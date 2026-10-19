// The Worker's 10-minute watch: turn a digest into the list of open problems and compare it
// with the previous poll, so the phone hears about a problem once when it appears, again if it
// gets worse or its details change (a different next boat), and once when it clears.

import { toMin } from '../../shared/schedule.mjs';
import { pacificDate, pacificHHMM } from '../../shared/time.mjs';

const RANK = { yellow: 1, red: 2 };

// Soft signals that can flicker on one bad poll: wait for a second poll before telling the user.
const CONFIRM_POLLS = { source: 2, 'line:no-predictions': 2, 'line:no-data': 2, 'line:gap': 2 };

/** A notified problem has to be gone this many polls in a row before "recovered" is sent. */
export const MISSES_TO_RESOLVE = 2;

export function issuesFromDigest(digest) {
  const out = [];
  const issue = (f, leg, legLabel) => ({
    key: leg === null ? f.key : `L${leg}:${f.key}`,
    flag: f.key,
    leg,
    legLabel,
    level: f.level,
    sig: f.sig ?? null,
    text: f.text,
    url: f.url ?? null,
  });
  (digest.legs ?? []).forEach((leg, i) => {
    for (const f of leg.flags ?? []) if (f.level !== 'info' && f.key) out.push(issue(f, i, leg.label));
  });
  for (const f of digest.timing?.flags ?? []) if (f.level !== 'info') out.push(issue(f, null, null));
  return out;
}

/**
 * What this poll cannot speak to:
 *  - departed: legs the user is past — new problems there no longer concern them. Judged by when
 *    they actually board (a cancelled 07:00 boat's leg stays open until the 07:25 they switch to).
 *  - passed: legs whose planned departure is behind us. Their problems are held, not resolved:
 *    a cancelled 07:00 boat drops out of the feed after 07:00, and that is not a recovery.
 *  - unknown: legs whose data failed this poll. Their problems can't be judged cleared, but new
 *    ones (including the "can't confirm" warning itself) still count.
 *  - timingUnknown / stillLate: "late" can't be judged cleared without an estimate, and isn't
 *    cleared while the estimate still says late.
 */
export function pollContext(digest, now) {
  const departed = new Set();
  const passed = new Set();
  const unknown = new Set();
  const nowMin = digest.targetDate === pacificDate(now) ? toMin(pacificHHMM(now)) : -1;
  (digest.legs ?? []).forEach((leg, i) => {
    const planned = toMin(leg.depLocal) + Math.max(0, leg.realtime?.delayMin ?? 0);
    const board = digest.timing?.legs?.[i]?.boardAt ?? planned;
    if (Math.max(board, planned) + 10 < nowMin) departed.add(i);
    if (Math.min(board, planned) + 10 < nowMin) passed.add(i);
    if (leg.flags?.some((f) => f.key === 'source')) unknown.add(i);
  });
  return {
    departed,
    passed,
    unknown,
    timingUnknown: !digest.timing?.eta || unknown.size > 0,
    stillLate: (digest.timing?.lateMin ?? 0) > 0,
  };
}

/** Numeric signatures (10-minute buckets) re-notify only when they grow; others on any change. */
function sigMoved(sig, before) {
  if (sig === null || sig === undefined || before === null || before === undefined) return false;
  if (typeof sig === 'number' && typeof before === 'number') return sig > before;
  return sig !== before;
}

/**
 * prev: { [key]: issue } from the last poll. Returns the new map and the events to push:
 * { type: 'new' | 'worse' | 'update' | 'resolved', issue, before?, remaining? }.
 */
export function diffIssues(prev = {}, current = [], at = new Date().toISOString(), ctx = {}) {
  const { departed = new Set(), passed = new Set(), unknown = new Set(), timingUnknown = false, stillLate = false } = ctx;
  const held = (p) =>
    p.leg === null ? timingUnknown || (p.flag === 'late' && stillLate) : departed.has(p.leg) || passed.has(p.leg) || unknown.has(p.leg);
  const next = {};
  const events = [];

  for (const c of current) {
    const p = prev[c.key];
    if (!p && c.leg !== null && departed.has(c.leg)) continue;
    const issue = {
      ...c,
      firstSeen: p?.firstSeen ?? at,
      lastSeen: at,
      seen: (p?.seen ?? 0) + 1,
      misses: 0,
      notified: p?.notified ?? null,
      notifiedSig: p?.notifiedSig ?? null,
      notifiedAt: p?.notifiedAt ?? null,
    };
    if (issue.seen >= (CONFIRM_POLLS[c.flag] ?? 1)) {
      const before = { notified: issue.notified, notifiedSig: issue.notifiedSig, notifiedAt: issue.notifiedAt };
      if (!issue.notified) events.push({ type: 'new', issue, before });
      else if (RANK[c.level] > RANK[issue.notified]) events.push({ type: 'worse', issue, before });
      else if (sigMoved(c.sig, issue.notifiedSig)) events.push({ type: 'update', issue, before });
      else {
        next[c.key] = issue;
        continue;
      }
      if (!issue.notified || RANK[c.level] > RANK[issue.notified]) issue.notified = c.level;
      issue.notifiedSig = c.sig;
      issue.notifiedAt = at;
    }
    next[c.key] = issue;
  }

  const gone = [];
  for (const [key, p] of Object.entries(prev)) {
    if (next[key]) continue;
    if (held(p)) next[key] = p;
    else if (p.notified) gone.push(p);
  }
  for (const p of gone) {
    const misses = (p.misses ?? 0) + 1;
    if (misses < MISSES_TO_RESOLVE) {
      next[p.key] = { ...p, misses };
      continue;
    }
    // Another problem still open on the same leg (a delay that became a cancellation, an alert
    // re-issued under a new id) means this is not a recovery. Judged on current levels, and only
    // problems actually seen this poll.
    const remaining = p.leg === null ? [] : Object.values(next).filter((i) => i.leg === p.leg && i.notified && !i.misses);
    if (remaining.some((i) => RANK[i.level] >= RANK[p.level])) continue;
    events.push({ type: 'resolved', issue: p, remaining: remaining[0] ?? null });
  }
  return { issues: next, events };
}

/** Put an event back so the next poll sends it again (the push didn't reach the phone). */
export function undoEvent(issues, ev) {
  if (ev.type === 'resolved') {
    issues[ev.issue.key] = { ...ev.issue, misses: MISSES_TO_RESOLVE - 1 };
    return;
  }
  const issue = issues[ev.issue.key];
  if (issue) Object.assign(issue, ev.before);
}

/** Problems the user has been told about and that haven't cleared. */
export const openIssues = (issues = {}) => Object.values(issues).filter((i) => i.notified);
