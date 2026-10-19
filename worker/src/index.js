// Commute Guard Worker: stores the route and check results in KV, serves the PWA, pushes to
// the phone (Web Push, optional ntfy), and every 5 minutes runs the watch in monitor.js —
// polling 511 during the user's commutes and waking the Claude routine at each checkpoint.
//
// Auth: the PWA sends `Bearer <APP_PASSCODE>`; the routine's scripts send `Bearer <WRITE_TOKEN>`
// (added by the cloud environment's network secret). Only the writer may post results.

import { targetDateFor } from '../../checker/lib/analyze.mjs';
import { buildDigest } from '../../checker/lib/digest.mjs';
import { getJSON } from '../../checker/lib/http.mjs';
import { createLiveSource } from '../../checker/lib/source.mjs';
import { openIssues } from '../../checker/lib/issues.mjs';
import {
  DEFAULT_NOTIFY,
  DIRS,
  HHMM,
  MODES,
  checkByMode,
  dayTimes,
  departureFor,
  dirAt,
  linesOf,
  planInputs,
  preferredBoarding,
  tripFor,
  watchWindow,
} from '../../shared/schedule.mjs';
import { addDays, pacificDate, pacificHHMM } from '../../shared/time.mjs';
import { planDay } from '../../shared/transitous.mjs';
import { poll, tick } from './monitor.js';
import { notify } from './notify.js';
import { recordMessage, saveRecord, shouldPush, supersededBy, validRecord } from './records.js';
import { fireRoutine, routineConfigured } from './routine.js';
import { statusPayload } from './status.js';
import { createStore } from './store.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN = 60000;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
const fail = (status, error) => json({ error }, status);

async function safeEqual(a, b) {
  const enc = new TextEncoder();
  const x = enc.encode(a);
  const y = enc.encode(b);
  return x.byteLength === y.byteLength && crypto.subtle.timingSafeEqual(x, y);
}

async function roleOf(request, env) {
  const h = request.headers.get('Authorization') ?? '';
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!token) return null;
  if (env.WRITE_TOKEN && (await safeEqual(token, env.WRITE_TOKEN))) return 'writer';
  if (env.APP_PASSCODE && (await safeEqual(token, env.APP_PASSCODE))) return 'app';
  return null;
}

// ---------- data sources ----------

const BUDGET_PER_HOUR = 60; // 511 calls per key per hour
const BUDGET_RESERVE = 15; // below this many left, checks reuse the watch's data instead of fetching
const SNAPSHOT_FRESH_MIN = 12; // the watch polls every 10 minutes

/**
 * Live 511/NWS plus KV-backed route data. Counts its 511 calls; flush() adds them to the hour's
 * usage. A ferry terminal's timetable is fetched once a day.
 */
function workerSource(env, store, now) {
  const live = createLiveSource({ key511: env.API_511_KEY, base511: env.API_511_BASE || undefined });
  const today = pacificDate(now);
  let calls = 0;
  const counted =
    (fn) =>
    (...args) => {
      calls++;
      return fn(...args);
    };
  return {
    ...live,
    alerts: counted(live.alerts),
    tripUpdates: counted(live.tripUpdates),
    stopVisits: counted(live.stopVisits),
    route: () => store.route(),
    pause: () => store.pause(),
    plan: (date, dir) => store.plan(date, dir),
    async timetable(agency, stopCode) {
      const key = `tt:${today}:${agency}:${stopCode}`;
      const cached = await store.get(key);
      if (cached) return cached;
      calls++;
      const list = await live.timetable(agency, stopCode);
      await store.put(key, list, 2);
      return list;
    },
    count: () => calls,
    async flush() {
      const n = calls;
      calls = 0;
      await store.addUsed511(now, n);
    },
  };
}

/** Serve realtime from the watch's latest poll instead of calling 511 again. */
function withSnapshot(source, watch, now, maxAgeMin) {
  const snap = watch?.snapshot;
  if (!snap || now - new Date(snap.at) > maxAgeMin * MIN) return source;
  const { alerts, tripUpdates, stopVisits } = snap.data;
  const cached = (value, fetch) => (value ? Promise.resolve(value) : fetch());
  return {
    ...source,
    alerts: (ag) => cached(alerts[ag], () => source.alerts(ag)),
    tripUpdates: (ag) => cached(tripUpdates[ag], () => source.tripUpdates(ag)),
    stopVisits: (ag, code) => cached(stopVisits[`${ag}:${code}`], () => source.stopVisits(ag, code)),
  };
}

/**
 * The source for a check (Claude's digest, the Worker's fallback): reuses the trip's latest poll
 * while it is fresh — or up to an hour old, skipping the alternatives' alerts, when the hour's
 * 511 budget is nearly spent.
 */
async function checkSource(env, store, now, date, dir) {
  const tight = BUDGET_PER_HOUR - (await store.used511(now)) < BUDGET_RESERVE;
  const watch = await store.watch(date, dir);
  const maxAge = tight ? 60 : SNAPSHOT_FRESH_MIN;
  const source = withSnapshot(workerSource(env, store, now), watch, now, maxAge);
  if (tight) source.gatherOptions = { alternatives: false };
  // When the realtime came from the watch's poll, the data is as old as that poll.
  const snap = watch?.snapshot;
  const snapshotAt = snap && now - new Date(snap.at) <= maxAge * MIN ? snap.at : null;
  return { source, tight, watch, snapshotAt };
}

/**
 * Plan `date` again with Transitous: the option on the user's lines that boards closest to the
 * boat they chose. { notOffered } when Transitous answered but those lines don't run then.
 * Throws when the planner itself failed (the caller retries).
 */
async function replan(route, date, dir, now) {
  const time = departureFor(route, date, dir);
  const set = route[dir];
  if (!time || !set?.pattern) return null;
  // Terminals near home: walked to in the morning, walked home from in the evening.
  const [from, to, terminalSide] = dir === 'morning' ? [route.home, route.work, 'from'] : [route.work, route.home, 'to'];
  // Search the saved trip's own lines: for a time where setup had to substitute other lines,
  // those are what the user takes.
  const saved = set.byTime?.[time]?.primary;
  const r = await planDay({
    from,
    to,
    date,
    time,
    terminals: route.terminals ?? [],
    terminalSide,
    pattern: saved ? linesOf(saved) : set.pattern,
    board: preferredBoarding(set, time),
    fetchJSON: (u) => getJSON(u),
  });
  const base = { time, pattern: set.pattern, inputs: planInputs(route, dir, time), plannedAt: now.toISOString() };
  if (!r.primary) return { ...base, primary: null, notOffered: true, offered: r.options.slice(0, 3).map((o) => `${o.startLocal}-${o.endLocal} ${o.summary}`) };
  // A partial planner answer can find the boat but miss the other options: keep the saved Plan B then.
  const alternatives = r.alternatives.length ? r.alternatives : (set.byTime?.[time]?.alternatives ?? []);
  return { ...base, primary: r.primary, alternatives };
}

function makeCtx(env, now) {
  const store = createStore(env.CG);
  return {
    now,
    store,
    source: async ({ reuse } = {}) =>
      reuse ? (await checkSource(env, store, now, reuse.date, reuse.dir)).source : workerSource(env, store, now),
    notify: (msgs, opts) => notify(env, store, now, msgs, opts),
    fire: (req) => fireRoutine(env, req),
    canFire: routineConfigured(env),
    replan: (route, date, dir) => replan(route, date, dir, now),
  };
}

// ---------- validation ----------

function validRoute(r) {
  if (!r || typeof r !== 'object') return 'route must be an object';
  if (!Number.isFinite(r.home?.lat) || !Number.isFinite(r.work?.lat)) return 'home and work (with lat/lon) are required';
  const days = r.schedule?.days;
  if (!days || typeof days !== 'object' || !Object.keys(days).length) return 'schedule.days needs at least one commute day';
  for (const [d, t] of Object.entries(days)) {
    if (!/^[0-6]$/.test(d)) return 'schedule.days keys are weekdays 0-6';
    if (!HHMM.test(t?.leaveHome ?? '')) return `leaveHome is required (HH:MM) for weekday ${d}`;
    for (const f of ['arriveBy', 'leaveWork']) if (t[f] != null && !HHMM.test(t[f])) return `${f} must be HH:MM`;
  }
  if (r.schedule.nightCheck != null && !HHMM.test(r.schedule.nightCheck)) return 'nightCheck must be HH:MM';
  // Before 04:00 it runs after midnight on the commute day; a morning time would run a day early.
  if (r.schedule.nightCheck >= '04:00' && r.schedule.nightCheck < '12:00') return '睡前检查时间要在 12:00 之后，或 00:00–03:59';
  if (!r.morning) return 'morning route is required';
  for (const dir of DIRS) {
    if (!r[dir]) continue;
    const plans = Object.entries(r[dir].byTime ?? {});
    if (!plans.length) return `${dir}.byTime is empty`;
    for (const [time, p] of plans) {
      if (!HHMM.test(time)) return `${dir}.byTime keys must be HH:MM`;
      if (!p?.primary?.legs?.some((l) => l.transit)) return `${dir} ${time}: the trip has no transit legs`;
    }
  }
  return null;
}

const trimSet = (set) =>
  set && {
    pattern: String(set.pattern ?? ''),
    byTime: Object.fromEntries(
      Object.entries(set.byTime).map(([t, p]) => [t, { primary: p.primary, alternatives: (p.alternatives ?? []).slice(0, 4) }]),
    ),
  };

/** The trip the user is on or about to start today: morning until its watch ends, then evening. */
async function currentTrip(store, route, pause, now) {
  const today = pacificDate(now);
  if (pause.dates.includes(today)) return null;
  for (const dir of DIRS) {
    const trip = tripFor(route, today, dir, await store.plan(today, dir));
    if (trip && now <= watchWindow(route, today, dir, trip).end) return trip;
  }
  return null;
}

/** The next commute day after today that isn't paused (within a week). */
function nextCommuteDay(route, pause, now) {
  const today = pacificDate(now);
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    if (dayTimes(route, d) && !pause.dates.includes(d)) return d;
  }
  return null;
}

// ---------- routes ----------

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health') return json({ ok: true });

  const role = await roleOf(request, env);
  if (!role) return fail(401, 'unauthorized');
  const now = new Date();
  const store = createStore(env.CG);
  const body = method === 'GET' ? null : await request.json().catch(() => null);

  if (path === '/api/route' && method === 'GET') return json(await store.route());
  if (path === '/api/route' && method === 'PUT') {
    if (role !== 'app') return fail(403, 'forbidden');
    const err = validRoute(body);
    if (err) return fail(400, err);
    const route = {
      version: 2,
      savedAt: now.toISOString(),
      home: body.home,
      work: body.work,
      terminals: (body.terminals ?? []).slice(0, 3),
      schedule: { nightCheck: body.schedule.nightCheck ?? '21:30', days: body.schedule.days },
      notify: { ...DEFAULT_NOTIFY, ...body.notify },
      morning: trimSet(body.morning),
      evening: trimSet(body.evening) ?? null,
    };
    await store.put('route', route);
    await env.CG.put('meta:origin', url.origin);
    return json({ ok: true });
  }

  if (path === '/api/pause' && method === 'GET') return json(await store.pause());
  if (path === '/api/pause' && method === 'PUT') {
    if (role !== 'app') return fail(403, 'forbidden');
    const today = pacificDate(now);
    // {add} / {remove} change one date against the stored list, so two quick taps can't undo each other.
    let dates = body?.dates ?? (await store.pause()).dates;
    if (body?.add) dates = [...dates, body.add];
    if (body?.remove) dates = dates.filter((d) => d !== body.remove);
    dates = [...new Set(dates.filter((d) => DATE_RE.test(d) && d >= today))].sort().slice(0, 60);
    await store.put('pause', { dates });
    return json({ dates });
  }

  if (path === '/api/status' && method === 'GET') return json(await statusPayload(store, env, now));
  if (path === '/api/status' && method === 'POST') {
    if (role !== 'writer') return fail(403, 'only the checker may post results');
    const err = validRecord(body);
    if (err) return fail(400, err);
    const record = { ...body, auto: false, checkedAt: body.checkedAt ?? now.toISOString() };
    record.dir ??= checkByMode(record.mode)?.dir ?? dirAt(pacificHHMM(now));
    // A verdict built from data older than a problem the watch has since pushed (new, worse or
    // changed), and milder than that problem, must not be the last word on the phone.
    const newer = await supersededBy(store, record);
    if (newer) record.superseded = newer;
    await saveRecord(store, record);
    if (newer || !shouldPush(record, await store.route())) {
      return json({ ok: true, pushed: 'skipped', delivered: null, reason: newer ? 'superseded' : 'policy' });
    }
    const pushed = await notify(env, store, now, recordMessage(record));
    // The cron re-sends a result whose push didn't get through (see monitor.js).
    const states = await store.pushStates(record.targetDate);
    states[record.mode] = { delivered: pushed.delivered, deliverable: pushed.deliverable, attempts: 1, at: now.toISOString(), checkedAt: record.checkedAt };
    await store.putPushStates(record.targetDate, states);
    return json({ ok: true, pushed, delivered: pushed.delivered });
  }

  // The routine's input: everything one check needs, built from the watch's fresh data.
  if (path === '/api/digest' && method === 'GET') {
    const mode = url.searchParams.get('mode');
    if (!MODES.includes(mode)) return fail(400, `mode must be one of ${MODES.join('/')}`);
    const date = url.searchParams.get('date') || targetDateFor(mode, now);
    if (!DATE_RE.test(date)) return fail(400, 'date must be YYYY-MM-DD');
    const dir = url.searchParams.get('dir') || checkByMode(mode)?.dir || dirAt(pacificHHMM(now));
    if (!DIRS.includes(dir)) return fail(400, 'dir must be morning or evening');
    // Recorded before the watch is read: a poll finishing meanwhile then knows this run may not
    // have seen its problem, and wakes Claude again (see maybeFireAlert in monitor.js).
    const fires = await store.fires(date);
    fires.lastDigestAt = now.toISOString();
    await store.putFires(date, fires);
    const { source, tight, watch, snapshotAt } = await checkSource(env, store, now, date, dir);
    // Today's watch knows what the feeds have forgotten (a boat that left, a cancelled trip gone from the feed).
    const prev = date === pacificDate(now) ? (watch?.timing?.legs ?? null) : null;
    const { digest } = await buildDigest({ mode, date, dir, now, source, prev });
    await source.flush().catch(() => {});
    digest.dataAt = snapshotAt ?? digest.generatedAt;
    if (tight) {
      digest.errors.push({ source: '511 额度', message: '这一小时的 511 调用快用完了：实时数据用的是 Worker 最近一次巡查的结果，备选路线的公告没查' });
    }
    // Problems the watch has already pushed to the phone, so the verdict can account for them.
    digest.watch = watch
      ? {
          lastPollAt: watch.lastPollAt,
          openIssues: openIssues(watch.issues).map((i) => ({ level: i.level, leg: i.legLabel, text: i.text, since: i.firstSeen })),
        }
      : null;
    return json(digest);
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    if (role !== 'app') return fail(403, 'forbidden');
    const sub = body;
    // http://127.0.0.1 is allowed for the local end-to-end test's mock push service.
    const endpointOk = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(sub?.endpoint ?? '');
    if (!endpointOk || !sub.keys?.p256dh || !sub.keys?.auth) return fail(400, 'not a push subscription');
    const all = await store.subs();
    const same = all.find((s) => s.endpoint === sub.endpoint && s.keys.p256dh === sub.keys.p256dh && s.keys.auth === sub.keys.auth);
    const subs = all.filter((s) => s.endpoint !== sub.endpoint);
    // Re-posting the same subscription doesn't fix failing pushes: keep its failure record.
    subs.push(same ?? { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: now.toISOString() });
    await store.putSubs(subs.slice(-5));
    await env.CG.put('meta:origin', url.origin);
    return json({ ok: true, subscriptions: Math.min(subs.length, 5) });
  }
  if (path === '/api/push/unsubscribe' && method === 'POST') {
    const subs = (await store.subs()).filter((s) => s.endpoint !== body?.endpoint);
    await store.putSubs(subs);
    return json({ ok: true, subscriptions: subs.length });
  }

  if (path === '/api/test-push' && method === 'POST') {
    const pushed = await notify(
      env,
      store,
      now,
      {
        kind: 'test',
        level: 'green',
        title: '🔔 通勤哨兵测试通知',
        body: `收到这条说明通知设置好了（${pacificHHMM(now)}）。路线出问题时会像这样马上提醒你。`,
      },
      { log: false },
    );
    return json({ pushed });
  }

  // 「立即检查」: poll the current trip now instead of waiting for the next 10-minute slot.
  // Limited so the 511 key (60 calls/hour, shared with the watch and Claude) isn't exhausted.
  if (path === '/api/check-now' && method === 'POST') {
    const [route, pause] = await Promise.all([store.route(), store.pause()]);
    const trip = route && (await currentTrip(store, route, pause, now));
    if (!trip) return fail(400, '今天没有还没结束的行程');
    const prev = await store.watch(trip.date, trip.dir);
    const sinceMin = prev?.lastPollAt ? (now - new Date(prev.lastPollAt)) / MIN : Infinity;
    const manual = (prev?.manual ?? []).filter((t) => now - new Date(t) < 60 * MIN);
    const throttled = (message) => json({ ok: true, throttled: true, message });
    if (sinceMin < 5) return throttled(`${Math.max(1, Math.round(sinceMin))} 分钟前刚查过，结果就是最新的`);
    if (manual.length >= 3) return throttled('一小时内已经手动查了 3 次（511 每小时有调用上限），等自动巡查');
    // Leave room for this poll and the scheduled polls that can still run this hour (the next one
    // is at least 9 minutes after this poll).
    const cost = prev?.calls ?? 6;
    const minutesLeft = Math.min(60 - now.getUTCMinutes(), (watchWindow(route, trip.date, trip.dir, trip).end - now) / MIN);
    const scheduled = Math.max(0, Math.floor((minutesLeft - 9) / 10) + 1);
    if ((await store.used511(now)) + cost * (1 + scheduled) > BUDGET_PER_HOUR - 5) {
      return throttled('这一小时的 511 调用快用完了，等自动巡查');
    }
    const win = watchWindow(route, trip.date, trip.dir, trip);
    const did = await poll(makeCtx(env, now), route, trip.date, trip.dir, prev, win, { manual: [...manual, now.toISOString()] });
    return json({ ok: true, did });
  }

  // 「让 Claude 看一下」: wake the routine for the current trip, or the next commute day's morning.
  if (path === '/api/analyze' && method === 'POST') {
    if (!routineConfigured(env)) return fail(400, 'Claude routine 还没有设置（ROUTINE_ID / ROUTINE_TOKEN）');
    const [route, pause] = await Promise.all([store.route(), store.pause()]);
    if (!route?.schedule) return fail(400, '还没有设置路线');
    const trip = await currentTrip(store, route, pause, now);
    const date = trip?.date ?? nextCommuteDay(route, pause, now);
    if (!date) return fail(400, '接下来一周没有要检查的通勤日');
    const dir = trip?.dir ?? 'morning';
    const fires = await store.fires(date);
    // Every Claude run reads 511 too: with 4 runs (checks included) in the last hour, wait.
    const runs = [...Object.values(fires.checks), ...fires.alerts].filter((f) => now - new Date(f.at) < 60 * MIN);
    if (runs.length >= 4) return fail(429, '一小时内 Claude 已经分析过 4 次了，稍后再试');
    const res = await fireRoutine(env, { mode: 'alert', date, dir, reason: '用户在 App 里点了「让 Claude 看一下」' });
    fires.alerts.push({ at: now.toISOString(), dir, manual: true, ...res });
    await store.putFires(date, fires);
    return json({ ...res, date, dir });
  }

  if (path === '/api/tick' && method === 'POST' && role === 'writer') return json({ did: await tick(makeCtx(env, now)) });

  return fail(404, 'not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        console.error(err);
        return fail(500, String(err?.message ?? err));
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      tick(makeCtx(env, new Date(event.scheduledTime))).then(
        (did) => did.length && console.log(did.join(' ')),
        (err) => console.error('tick failed', err),
      ),
    );
  },
};
