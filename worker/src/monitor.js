// The Worker's cron (every 5 minutes). Each run, in order:
//   1. wake the Claude routine for checkpoints that are due (night / wake / leave / enroute / offwork)
//   2. during a commute, poll 511 every POLL_MINUTES and push new / worse / changed / recovered problems
//   3. if Claude hasn't answered GRACE_MINUTES after a checkpoint, push the Worker's own result
//   4. before the night check, re-plan tomorrow's trips so timetable changes and holidays are picked up
// Steps 2–4 parse large upstream payloads; the free plan allows ~10 ms CPU per run, so at most
// one of them runs per invocation and the rest wait five minutes.
//
// ctx: { now, store, source(opts), notify(msgs, opts), fire(req), canFire, replan(route, date, dir) }
//   source({ reuse: { date, dir } }) may serve realtime from that trip's last poll (saves 511 calls).

import { buildDigest } from '../../checker/lib/digest.mjs';
import { diffIssues, issuesFromDigest, pollContext, undoEvent } from '../../checker/lib/issues.mjs';
import {
  DIRS,
  DIR_LABEL,
  GRACE_MINUTES,
  NIGHT_AFTER_MIDNIGHT_UNTIL,
  POLL_MINUTES,
  checkpointsFor,
  commutesOn,
  dayTimes,
  fromMin,
  toMin,
  tripFor,
  watchWindow,
} from '../../shared/schedule.mjs';
import { addDays, pacificDate, pacificHHMM } from '../../shared/time.mjs';
import { openCount } from './notify.js';
import { LEVEL_EMOJI, autoRecord, recordMessage, saveRecord, shouldPush } from './records.js';

const MIN = 60000;
const FIRE_EARLY_MIN = 3; // cron runs every 5 min: fire up to 3 min before the checkpoint
const FIRE_LATE_MIN = 20; // …and still catch up if the cron was briefly down
const ALERT_FIRES_PER_HOUR = 3; // Claude runs per hour (each reads 511 too; the key allows 60 calls/hour)
const REPLAN_LEAD_MIN = 90; // re-plan tomorrow this long before the night check…
const REPLAN_LATEST = '20:00'; // …and from 20:00 at the latest
const REPLAN_EARLIEST = '12:00';

const shortLeg = (label) => (label ?? '').replace(/（.*?）$/, '');
const hhmm = (iso) => pacificHHMM(new Date(iso));
const TIMING_LABEL = { late: '可能迟到', 'plan:not-offered': '班次变了' };

async function tripsOn(store, route, date) {
  const out = {};
  for (const dir of DIRS) out[dir] = tripFor(route, date, dir, await store.plan(date, dir));
  return out;
}

/** When tomorrow's re-plan may start: early enough to finish before the night check. */
export function replanFrom(route) {
  const night = route.schedule.nightCheck ?? '21:30';
  if (night < NIGHT_AFTER_MIDNIGHT_UNTIL) return REPLAN_LATEST;
  const lead = fromMin(toMin(night) - REPLAN_LEAD_MIN);
  return lead < REPLAN_EARLIEST ? REPLAN_EARLIEST : lead < REPLAN_LATEST ? lead : REPLAN_LATEST;
}

export async function tick(ctx) {
  const { now, store } = ctx;
  const route = await store.route();
  if (!route?.schedule) return [];
  const pause = await store.pause();
  const today = pacificDate(now);
  const did = [];
  const fallbacks = [];

  // 1. Checkpoints for today and tomorrow (tomorrow's night check usually runs this evening).
  for (const date of [today, addDays(today, 1)]) {
    if (!dayTimes(route, date) || pause.dates.includes(date)) continue;
    const trips = await tripsOn(store, route, date);
    const [fires, checks] = await Promise.all([store.fires(date), store.checks(date)]);
    let changed = false;
    for (const cp of checkpointsFor(route, date, trips)) {
      const since = (now - cp.at) / MIN;
      if (since < -FIRE_EARLY_MIN || since > 90) continue;
      const answered = checks.some((r) => r.mode === cp.mode);
      const fire = fires.checks[cp.mode];
      if (!fire) {
        if (answered || since > FIRE_LATE_MIN) continue;
        fires.checks[cp.mode] = { at: now.toISOString(), ...(await ctx.fire({ mode: cp.mode, date, dir: cp.dir, reason: '定时检查' })) };
        changed = true;
        did.push(`fire:${date}:${cp.mode}`);
      } else if (!answered && !fire.fallbackAt && (!fire.ok || (now - new Date(fire.at)) / MIN >= GRACE_MINUTES)) {
        fallbacks.push({ cp, fire });
      }
    }
    if (changed) await store.putFires(date, fires);
    // A result whose push didn't get through is sent again (up to 3 tries, 5 minutes apart).
    const unsent = checks.filter(
      (r) => r.push && !r.push.delivered && r.push.deliverable && r.push.attempts < 3 && now - new Date(r.push.at) >= 5 * MIN,
    );
    if (unsent.length) {
      const results = await ctx.notify(unsent.map(recordMessage));
      unsent.forEach((r, i) => {
        r.push = { ...r.push, delivered: Boolean(results[i]?.delivered), attempts: r.push.attempts + 1, at: now.toISOString() };
      });
      await store.putChecks(date, checks);
      did.push(...unsent.map((r) => `resend:${date}:${r.mode}:${r.push.delivered ? 'ok' : 'failed'}`));
    }
  }

  // 2. The 10-minute watch over today's trips.
  let heavy = false;
  if (dayTimes(route, today) && !pause.dates.includes(today)) {
    const trips = await tripsOn(store, route, today);
    for (const dir of DIRS) {
      const trip = trips[dir];
      const win = trip && watchWindow(route, today, dir, trip);
      if (!win || now < win.start || now > win.end || heavy) continue;
      const prev = await store.watch(today, dir);
      if (prev?.lastPollAt && now - new Date(prev.lastPollAt) < (POLL_MINUTES - 1) * MIN) continue;
      heavy = true;
      did.push(...(await poll(ctx, route, today, dir, prev, win)));
    }
  }

  // 3. Claude didn't answer: send the rule-based result so silence never means "fine".
  if (!heavy && fallbacks.length) {
    heavy = true;
    const { cp, fire } = fallbacks[0];
    did.push(`fallback:${cp.date}:${cp.mode}:${await sendFallback(ctx, cp, fire)}`);
  }

  // 4. Re-plan tomorrow with Transitous, one direction per run.
  if (!heavy && pacificHHMM(now) >= replanFrom(route)) {
    const tomorrow = addDays(today, 1);
    for (const dir of DIRS) {
      if (!commutesOn(route, tomorrow, dir) || pause.dates.includes(tomorrow)) continue;
      const stored = await store.plan(tomorrow, dir);
      if (stored?.primary || stored?.notOffered) continue;
      if ((stored?.attempts ?? 0) >= 3 || (stored && now - new Date(stored.at) < 30 * MIN)) continue;
      // Record the attempt first: if the run is cut off mid-plan, the next run won't loop on it.
      await store.putPlan(tomorrow, dir, { primary: null, attempts: (stored?.attempts ?? 0) + 1, at: now.toISOString() });
      const plan = await ctx.replan(route, tomorrow, dir).catch(() => null);
      if (plan) await store.putPlan(tomorrow, dir, plan);
      did.push(`replan:${tomorrow}:${dir}:${plan?.primary ? 'ok' : plan?.notOffered ? 'not-offered' : 'failed'}`);
      break;
    }
  }
  return did;
}

/**
 * One poll: fetch the primary trip's realtime data, diff problems against the last poll, push
 * the changes. A push that doesn't reach the phone is undone so the next poll sends it again.
 */
export async function poll(ctx, route, date, dir, prev, win = null, extra = {}) {
  const { now, store } = ctx;
  const source = await ctx.source();
  const { digest, gathered } = await buildDigest({
    mode: 'monitor',
    date,
    dir,
    now,
    source,
    gatherOptions: { alternatives: false, weather: false },
    prev: prev?.timing?.legs ?? null,
  });
  const calls = source.count?.() ?? null;
  await source.flush?.().catch(() => {}); // usage counting is best-effort
  const at = now.toISOString();
  const { issues, events } = diffIssues(prev?.issues, issuesFromDigest(digest), at, pollContext(digest, now));

  if (events.length) {
    extra = { ...extra, lastEventAt: at };
    // Ask Claude first, so a push only promises a Plan B when an analysis is actually coming.
    // A data-source failure alone is not worth a run (it would read the same failing source).
    const fresh = events.filter((e) => e.type !== 'resolved' && e.issue.flag !== 'source');
    const analyzing = fresh.length > 0 && (await maybeFireAlert(ctx, date, dir, fresh));
    const badge = await openCount(store, now, { [dir]: issues });
    const results = await ctx.notify(
      events.map((ev) => ({ ...issueMessage(ev, digest, date, dir, analyzing), badge })),
      { logFailed: false },
    );
    events.forEach((ev, i) => {
      if (results[i]?.deliverable && !results[i].delivered) undoEvent(issues, ev);
    });
  }

  await store.putWatch(date, dir, {
    manual: prev?.manual ?? [],
    lastEventAt: prev?.lastEventAt ?? null,
    ...extra,
    date,
    dir,
    lastPollAt: at,
    windowEnd: win?.end?.toISOString() ?? prev?.windowEnd ?? null,
    polls: (prev?.polls ?? 0) + 1,
    calls: calls ?? prev?.calls ?? null,
    level: digest.suggestedLevel,
    issues,
    legs: (digest.legs ?? []).map((l) => ({
      label: l.label,
      mode: l.mode,
      from: l.from,
      to: l.to,
      depLocal: l.depLocal,
      arrLocal: l.arrLocal,
      level: l.level,
      realtime: l.realtime && {
        kind: l.realtime.kind,
        status: l.realtime.status,
        delayMin: l.realtime.delayMin ?? null,
        nextDep: l.realtime.nextDep ?? null,
        upcoming: (l.realtime.upcoming ?? []).slice(0, 3),
      },
    })),
    timing: digest.timing ?? null,
    errors: digest.errors,
    // /api/digest and fallbacks reuse this for a few minutes instead of calling 511 again.
    snapshot: { at, data: gathered.data },
  });
  return events.map((e) => `${e.type}:${e.issue.key}`);
}

export function issueMessage({ type, issue, remaining }, digest, date, dir, analyzing) {
  const where = issue.legLabel ? shortLeg(issue.legLabel) : (TIMING_LABEL[issue.flag] ?? DIR_LABEL[dir]);
  const base = { dir, date, tag: issue.key };
  if (type === 'resolved') {
    if (remaining) {
      return {
        ...base,
        kind: 'resolved',
        level: remaining.level,
        title: `${LEVEL_EMOJI[remaining.level]} 好转了：${where}`,
        body: `已解除：${issue.text}\n还有：${remaining.text}`,
      };
    }
    const title = { late: '✅ 现在来得及了', source: `✅ 数据恢复了：${where}` }[issue.flag] ?? `✅ 已恢复：${where}`;
    return { ...base, kind: 'resolved', level: 'green', title, body: `之前：${issue.text}（${hhmm(issue.firstSeen)} 发现）` };
  }
  const t = digest.timing;
  const lines = [issue.text];
  // Without any realtime the estimate is just the timetable: say so.
  const live = (t?.legs ?? []).some((l) => l?.informed);
  if (t?.eta && issue.flag !== 'late') {
    lines.push(`${live ? '预计' : '按时刻表'} ${t.eta} 到${dir === 'morning' ? '公司' : '家'}${t.lateMin > 0 ? `，比要求晚 ${t.lateMin} 分钟` : ''}`);
  } else if (t && !t.eta) {
    lines.push('有一段走不通，到达时间没法估计');
  }
  if (analyzing) lines.push('Claude 正在分析 Plan B，几分钟后推送。');
  const prefix = { worse: '更严重了：', update: '有变化：' }[type] ?? '';
  return {
    ...base,
    kind: type === 'new' ? 'issue' : type,
    level: issue.level,
    title: `${LEVEL_EMOJI[issue.level]} ${prefix}${where}`,
    body: lines.join('\n'),
  };
}

/**
 * Ask Claude to explain new problems. True when an analysis is coming: a new alert run, or a run
 * woken moments ago that hasn't fetched its data yet (its digest will include these problems).
 */
async function maybeFireAlert(ctx, date, dir, events) {
  if (!ctx.canFire) return false;
  const { now, store } = ctx;
  const fires = await store.fires(date);
  const runs = [...Object.values(fires.checks), ...fires.alerts].filter((f) => f.ok).map((f) => new Date(f.at).getTime());
  const latest = Math.max(0, ...runs);
  if (now - latest < 10 * MIN && (!fires.lastDigestAt || new Date(fires.lastDigestAt).getTime() < latest)) return true;
  if (runs.filter((t) => now - t < 60 * MIN).length >= ALERT_FIRES_PER_HOUR) return false;
  const reason = `新问题：${events.map((e) => `${shortLeg(e.issue.legLabel)} ${e.issue.text}`.trim()).join('；')}`;
  const res = await ctx.fire({ mode: 'alert', date, dir, reason });
  fires.alerts.push({ at: now.toISOString(), dir, ...res });
  await store.putFires(date, fires);
  return Boolean(res.ok);
}

async function sendFallback(ctx, cp, fire) {
  const { now, store } = ctx;
  const markDone = async () => {
    const fires = await store.fires(cp.date);
    if (fires.checks[cp.mode]) fires.checks[cp.mode].fallbackAt = now.toISOString();
    await store.putFires(cp.date, fires);
  };
  const why = fire.ok ? `${GRACE_MINUTES} 分钟内没有结果` : `没能启动：${fire.status}`;
  const source = await ctx.source({ reuse: { date: cp.date, dir: cp.dir } });
  // Today's watch knows what the feeds have forgotten (a boat that left, a cancelled trip gone from the feed).
  const watch = cp.date === pacificDate(now) ? await store.watch(cp.date, cp.dir) : null;
  const { digest, route } = await buildDigest({ mode: cp.mode, date: cp.date, dir: cp.dir, now, source, prev: watch?.timing?.legs ?? null });
  await source.flush?.().catch(() => {});
  // Claude may have answered while the data was being fetched.
  if ((await store.checks(cp.date)).some((r) => r.mode === cp.mode && !r.auto)) {
    await markDone();
    return 'answered';
  }
  const record = autoRecord(digest, why, now);
  if (!(await saveRecord(store, record))) {
    await markDone();
    return 'answered';
  }
  if (shouldPush(record, route)) await ctx.notify(recordMessage(record));
  await markDone();
  return 'sent';
}
