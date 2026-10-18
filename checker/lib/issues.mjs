// The Worker's 10-minute watch: turn a digest into the list of open problems and compare it
// with the previous poll, so the phone hears about a problem once when it appears, again if
// it gets worse, and once when it clears.

import { toMin } from '../../shared/schedule.mjs';
import { pacificDate, pacificHHMM } from '../../shared/time.mjs';

const RANK = { yellow: 1, red: 2 };

// Soft signals that can flicker on one bad poll: wait for a second poll before telling the user.
const CONFIRM_POLLS = { source: 2, 'line:no-predictions': 2, 'line:no-data': 2 };

/** A notified problem has to be gone this many polls in a row before "recovered" is sent. */
export const MISSES_TO_RESOLVE = 2;

export function issuesFromDigest(digest) {
  const out = [];
  (digest.legs ?? []).forEach((leg, i) => {
    for (const f of leg.flags ?? []) {
      if (f.level === 'info' || !f.key) continue;
      out.push({ key: `L${i}:${f.key}`, flag: f.key, leg: i, legLabel: leg.label, level: f.level, text: f.text, url: f.url ?? null });
    }
  });
  for (const f of digest.timing?.flags ?? []) {
    if (f.level !== 'info') out.push({ key: f.key, flag: f.key, leg: null, legLabel: null, level: f.level, text: f.text, url: null });
  }
  return out;
}

/**
 * Legs whose problems must not change this poll: their data failed (an alert vanishing then
 * means nothing), or the user is already past them (a cancelled 07:00 boat drops out of the
 * feed after 07:00 — that is not a recovery).
 */
export function frozenLegs(digest, now) {
  const frozen = new Set();
  const nowMin = digest.targetDate === pacificDate(now) ? toMin(pacificHHMM(now)) : -1;
  (digest.legs ?? []).forEach((leg, i) => {
    const departed = toMin(leg.depLocal) + Math.max(0, leg.realtime?.delayMin ?? 0) + 10 < nowMin;
    if (departed || leg.flags?.some((f) => f.key === 'source')) frozen.add(i);
  });
  return frozen;
}

/**
 * prev: { [key]: issue } from the last poll. Returns the new map and the events to push:
 * { type: 'new' | 'worse' | 'resolved', issue }.
 */
export function diffIssues(prev = {}, current = [], at = new Date().toISOString(), frozen = new Set()) {
  const next = {};
  const events = [];
  for (const c of current) {
    const p = prev[c.key];
    if (!p && c.leg !== null && frozen.has(c.leg)) continue;
    const seen = (p?.seen ?? 0) + 1;
    const issue = { ...c, firstSeen: p?.firstSeen ?? at, lastSeen: at, seen, misses: 0, notified: p?.notified ?? null };
    if (seen >= (CONFIRM_POLLS[c.flag] ?? 1)) {
      if (!issue.notified) {
        events.push({ type: 'new', issue });
        issue.notified = c.level;
      } else if (RANK[c.level] > RANK[issue.notified]) {
        events.push({ type: 'worse', issue });
        issue.notified = c.level;
      }
    }
    next[c.key] = issue;
  }
  for (const [key, p] of Object.entries(prev)) {
    if (next[key]) continue;
    if (p.leg !== null && frozen.has(p.leg)) {
      next[key] = p;
      continue;
    }
    const misses = (p.misses ?? 0) + 1;
    if (!p.notified) continue; // never confirmed: drop quietly
    if (misses >= MISSES_TO_RESOLVE) events.push({ type: 'resolved', issue: p });
    else next[key] = { ...p, misses };
  }
  return { issues: next, events };
}

/** Problems the user has been told about and that haven't cleared. */
export const openIssues = (issues = {}) => Object.values(issues).filter((i) => i.notified);
