// The Worker's cron (every 5 minutes). Each run, in order:
//   1. wake the Claude routine for checkpoints that are due (night / wake / leave / enroute / offwork)
//   2. during a commute, poll 511 every POLL_MINUTES and push new / worse / recovered problems at once
//   3. if Claude hasn't answered GRACE_MINUTES after a checkpoint, push the Worker's own result
//   4. in the evening, re-plan tomorrow's trips so schedule changes and holidays are picked up
// Steps 2–4 parse large upstream payloads; the free plan allows ~10 ms CPU per run, so at most
// one of them runs per invocation and the rest wait five minutes.
//
// ctx: { now, store, source(), notify(msg), fire(req), canFire, replan(route, date, dir) }

import { buildDigest } from '../../checker/lib/digest.mjs';
import { diffIssues, frozenLegs, issuesFromDigest } from '../../checker/lib/issues.mjs';
import {
  DIRS,
  DIR_LABEL,
  GRACE_MINUTES,
  POLL_MINUTES,
  checkpointsFor,
  commutesOn,
  dayTimes,
  tripFor,
  watchWindow,
} from '../../shared/schedule.mjs';
import { addDays, pacificDate, pacificHHMM } from '../../shared/time.mjs';
import { LEVEL_EMOJI, autoRecord, recordMessage, saveRecord, shouldPush } from './records.js';

const MIN = 60000;
const FIRE_EARLY_MIN = 3; // cron runs every 5 min: fire up to 3 min before the checkpoint
const FIRE_LATE_MIN = 20; // …and still catch up if the cron was briefly down
const ALERT_FIRES_PER_HOUR = 3; // keeps the shared 511 key under 60 calls/hour
const REPLAN_FROM = '20:00';

const shortLeg = (label) => (label ?? '').replace(/（.*?）$/, '');
const hhmm = (iso) => pacificHHMM(new Date(iso));

async function tripsOn(store, route, date) {
  const out = {};
  for (const dir of DIRS) out[dir] = tripFor(route, date, dir, await store.plan(date, dir));
  return out;
}

export async function tick(ctx) {
  const { now, store } = ctx;
  const route = await store.route();
  if (!route?.schedule) return [];
  const pause = await store.pause();
  const today = pacificDate(now);
  const did = [];
  const fallbacks = [];

  // 1. Checkpoints for today and tomorrow (tomorrow's night check runs this evening).
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
      did.push(...(await poll(ctx, route, today, dir, prev)));
    }
  }

  // 3. Claude didn't answer: send the rule-based result so silence never means "fine".
  if (!heavy && fallbacks.length) {
    heavy = true;
    const { cp, fire } = fallbacks[0];
    await sendFallback(ctx, cp, fire);
    did.push(`fallback:${cp.date}:${cp.mode}`);
  }

  // 4. Re-plan tomorrow with Transitous, one direction per run.
  if (!heavy && pacificHHMM(now) >= REPLAN_FROM) {
    const tomorrow = addDays(today, 1);
    for (const dir of DIRS) {
      if (!commutesOn(route, tomorrow, dir) || pause.dates.includes(tomorrow)) continue;
      const stored = await store.plan(tomorrow, dir);
      if (stored?.primary || (stored?.attempts ?? 0) >= 3 || (stored && now - new Date(stored.at) < 30 * MIN)) continue;
      // Record the attempt first: if the run is cut off mid-plan, the next run won't loop on it.
      await store.putPlan(tomorrow, dir, { primary: null, attempts: (stored?.attempts ?? 0) + 1, at: now.toISOString() });
      const plan = await ctx.replan(route, tomorrow, dir).catch(() => null);
      if (plan?.primary) await store.putPlan(tomorrow, dir, plan);
      did.push(`replan:${tomorrow}:${dir}:${plan?.primary ? 'ok' : 'failed'}`);
      break;
    }
  }
  return did;
}

/** One poll: fetch the primary trip's realtime data, diff problems against the last poll, push changes. */
export async function poll(ctx, route, date, dir, prev) {
  const { now, store } = ctx;
  const { digest, gathered } = await buildDigest({
    mode: 'monitor',
    date,
    dir,
    now,
    source: ctx.source(),
    gatherOptions: { alternatives: false, weather: false },
  });
  const at = now.toISOString();
  const { issues, events } = diffIssues(prev?.issues, issuesFromDigest(digest), at, frozenLegs(digest, now));
  await store.putWatch(date, dir, {
    date,
    dir,
    lastPollAt: at,
    polls: (prev?.polls ?? 0) + 1,
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
    // /api/digest reuses this for a few minutes instead of calling 511 again.
    snapshot: { at, data: gathered.data },
  });

  for (const ev of events) await ctx.notify(issueMessage(ev, digest, date, dir, ctx.canFire));
  const fresh = events.filter((e) => e.type !== 'resolved');
  if (fresh.length) await maybeFireAlert(ctx, date, dir, fresh);
  return events.map((e) => `${e.type}:${e.issue.key}`);
}

export function issueMessage({ type, issue }, digest, date, dir, analyzing) {
  const where = issue.legLabel ? shortLeg(issue.legLabel) : issue.flag === 'late' ? '可能迟到' : DIR_LABEL[dir];
  if (type === 'resolved') {
    return {
      kind: 'resolved',
      level: 'green',
      title: issue.flag === 'late' ? '✅ 现在来得及了' : `✅ 已恢复：${where}`,
      body: `之前：${issue.text}（${hhmm(issue.firstSeen)} 发现）`,
      dir,
      date,
      tag: issue.key,
    };
  }
  const t = digest.timing;
  const lines = [issue.text];
  if (t?.eta && issue.flag !== 'late') {
    lines.push(`预计 ${t.eta} 到${dir === 'morning' ? '公司' : '家'}${t.lateMin > 0 ? `，比要求晚 ${t.lateMin} 分钟` : ''}`);
  }
  if (analyzing) lines.push('Claude 正在分析 Plan B，几分钟后推送。');
  return {
    kind: type === 'worse' ? 'worse' : 'issue',
    level: issue.level,
    title: `${LEVEL_EMOJI[issue.level]} ${type === 'worse' ? '更严重了：' : ''}${where}`,
    body: lines.join('\n'),
    dir,
    date,
    tag: issue.key,
  };
}

/** Ask Claude to explain new problems — unless a check just ran or the hourly budget is used. */
async function maybeFireAlert(ctx, date, dir, events) {
  if (!ctx.canFire) return;
  const { now, store } = ctx;
  const fires = await store.fires(date);
  const times = [...Object.values(fires.checks), ...fires.alerts].map((f) => new Date(f.at).getTime());
  if (times.some((t) => now - t < 10 * MIN)) return;
  if (times.filter((t) => now - t < 60 * MIN).length >= ALERT_FIRES_PER_HOUR) return;
  const reason = `新问题：${events.map((e) => `${shortLeg(e.issue.legLabel)} ${e.issue.text}`.trim()).join('；')}`;
  const res = await ctx.fire({ mode: 'alert', date, dir, reason });
  fires.alerts.push({ at: now.toISOString(), dir, ...res });
  await store.putFires(date, fires);
}

async function sendFallback(ctx, cp, fire) {
  const { now, store } = ctx;
  const why = fire.ok ? `${GRACE_MINUTES} 分钟内没有结果` : `没能启动：${fire.status}`;
  const { digest, route } = await buildDigest({ mode: cp.mode, date: cp.date, dir: cp.dir, now, source: ctx.source() });
  const record = autoRecord(digest, why, now);
  await saveRecord(store, record);
  if (shouldPush(record, route)) await ctx.notify(recordMessage(record));
  const fires = await store.fires(cp.date);
  if (fires.checks[cp.mode]) fires.checks[cp.mode].fallbackAt = now.toISOString();
  await store.putFires(cp.date, fires);
}
