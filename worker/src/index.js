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
import { DEFAULT_NOTIFY, DIRS, HHMM, MODES, checkByMode, departureFor, dirAt, tripFor, watchWindow } from '../../shared/schedule.mjs';
import { pacificDate, pacificHHMM } from '../../shared/time.mjs';
import { planDay } from '../../shared/transitous.mjs';
import { poll, tick } from './monitor.js';
import { notify } from './notify.js';
import { recordMessage, saveRecord, shouldPush, validRecord } from './records.js';
import { fireRoutine, routineConfigured } from './routine.js';
import { statusPayload } from './status.js';
import { createStore } from './store.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN = 60000;
const SNAPSHOT_FRESH_MIN = 8;

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

/** Live 511/NWS plus KV-backed route data; a ferry terminal's timetable is fetched once a day. */
function workerSource(env, store, now) {
  const live = createLiveSource({ key511: env.API_511_KEY, base511: env.API_511_BASE || undefined });
  const today = pacificDate(now);
  return {
    ...live,
    route: () => store.route(),
    pause: () => store.pause(),
    plan: (date, dir) => store.plan(date, dir),
    async timetable(agency, stopCode) {
      const key = `tt:${today}:${agency}:${stopCode}`;
      const cached = await store.get(key);
      if (cached) return cached;
      const list = await live.timetable(agency, stopCode);
      await store.put(key, list, 2);
      return list;
    },
  };
}

/** Serve realtime from the watch's latest poll while it is only a few minutes old. */
function withSnapshot(source, watch, now) {
  const snap = watch?.snapshot;
  if (!snap || now - new Date(snap.at) > SNAPSHOT_FRESH_MIN * MIN) return source;
  const { alerts, tripUpdates, stopVisits } = snap.data;
  const cached = (value, fetch) => (value ? Promise.resolve(value) : fetch());
  return {
    ...source,
    alerts: (ag) => cached(alerts[ag], () => source.alerts(ag)),
    tripUpdates: (ag) => cached(tripUpdates[ag], () => source.tripUpdates(ag)),
    stopVisits: (ag, code) => cached(stopVisits[`${ag}:${code}`], () => source.stopVisits(ag, code)),
  };
}

/** Plan `date` again with Transitous and keep the option with the user's chosen lines. */
async function replan(route, date, dir, now) {
  const time = departureFor(route, date, dir);
  const set = route[dir];
  if (!time || !set?.pattern) return null;
  // Terminals near home: walked to in the morning, walked home from in the evening.
  const [from, to, terminalSide] = dir === 'morning' ? [route.home, route.work, 'from'] : [route.work, route.home, 'to'];
  const terminals = route.terminals ?? [];
  const r = await planDay({ from, to, date, time, terminals, terminalSide, pattern: set.pattern, fetchJSON: (u) => getJSON(u) });
  if (!r.primary) return null;
  return { primary: r.primary, alternatives: r.alternatives, time, pattern: set.pattern, plannedAt: now.toISOString() };
}

function makeCtx(env, now) {
  const store = createStore(env.CG);
  return {
    now,
    store,
    source: () => workerSource(env, store, now),
    notify: (msg) => notify(env, store, now, msg),
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
async function currentTrip(store, route, now) {
  const today = pacificDate(now);
  for (const dir of DIRS) {
    const trip = tripFor(route, today, dir, await store.plan(today, dir));
    if (trip && now <= watchWindow(route, today, dir, trip).end) return trip;
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
    const dates = [...new Set((body?.dates ?? []).filter((d) => DATE_RE.test(d) && d >= today))].sort().slice(0, 60);
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
    await saveRecord(store, record);
    const pushed = shouldPush(record, await store.route()) ? await notify(env, store, now, recordMessage(record)) : 'skipped';
    return json({ ok: true, pushed });
  }

  // The routine's input: everything one check needs, built from the watch's fresh data.
  if (path === '/api/digest' && method === 'GET') {
    const mode = url.searchParams.get('mode');
    if (!MODES.includes(mode)) return fail(400, `mode must be one of ${MODES.join('/')}`);
    const date = url.searchParams.get('date') || targetDateFor(mode, now);
    if (!DATE_RE.test(date)) return fail(400, 'date must be YYYY-MM-DD');
    const dir = url.searchParams.get('dir') || checkByMode(mode)?.dir || dirAt(pacificHHMM(now));
    if (!DIRS.includes(dir)) return fail(400, 'dir must be morning or evening');
    const source = withSnapshot(workerSource(env, store, now), await store.watch(date, dir), now);
    const { digest } = await buildDigest({ mode, date, dir, now, source });
    return json(digest);
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    if (role !== 'app') return fail(403, 'forbidden');
    const sub = body;
    // http://127.0.0.1 is allowed for the local end-to-end test's mock push service.
    const endpointOk = /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])/.test(sub?.endpoint ?? '');
    if (!endpointOk || !sub.keys?.p256dh || !sub.keys?.auth) return fail(400, 'not a push subscription');
    const subs = (await store.subs()).filter((s) => s.endpoint !== sub.endpoint);
    subs.push({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, addedAt: now.toISOString() });
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
  if (path === '/api/check-now' && method === 'POST') {
    const route = await store.route();
    const trip = route && (await currentTrip(store, route, now));
    if (!trip) return fail(400, '今天没有还没结束的行程');
    const prev = await store.watch(trip.date, trip.dir);
    if (prev?.lastPollAt && now - new Date(prev.lastPollAt) < 2 * MIN) return json({ ok: true, throttled: true });
    const did = await poll(makeCtx(env, now), route, trip.date, trip.dir, prev);
    return json({ ok: true, did });
  }

  // 「让 Claude 看一下」: wake the routine for the current or next trip.
  if (path === '/api/analyze' && method === 'POST') {
    if (!routineConfigured(env)) return fail(400, 'Claude routine 还没有设置（ROUTINE_ID / ROUTINE_TOKEN）');
    const route = await store.route();
    const trip = route && (await currentTrip(store, route, now));
    const date = trip?.date ?? targetDateFor('night', now);
    const dir = trip?.dir ?? 'morning';
    const fires = await store.fires(date);
    if (fires.alerts.filter((f) => now - new Date(f.at) < 60 * MIN).length >= 3) return fail(429, '一小时内已经分析过 3 次了');
    const res = await fireRoutine(env, { mode: 'alert', date, dir, reason: '用户在 App 里点了「让 Claude 看一下」' });
    fires.alerts.push({ at: now.toISOString(), dir, manual: true, ...res });
    await store.putFires(date, fires);
    return json(res);
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
