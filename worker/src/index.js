// Commute Guard Worker: stores the chosen route and check results in KV, pushes results to
// the phone through ntfy, serves the PWA, and runs a watchdog for checks that never ran.
//
// Auth: the PWA sends `Bearer <APP_PASSCODE>`; the routine's scripts send `Bearer <WRITE_TOKEN>`
// (added by the cloud environment's network secret). Only the writer may post results.

import { CHECKS, DEFAULT_WORKDAYS, GRACE_MINUTES, LEVELS, MODES, checkByMode } from '../../shared/schedule.mjs';
import { addDays, minutesBetween, pacificDate, pacificHHMM, pacificToDate, weekdayOf } from '../../shared/time.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CHECKS_TTL = 30 * 86400;
const LEVEL_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴', skip: '⚪' };
const NTFY_PRIORITY = { green: 2, yellow: 3, red: 5 };

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

// ---------- storage ----------

const getJSON = async (env, key, fallback = null) => (await env.CG.get(key, 'json')) ?? fallback;
const getRoute = (env) => getJSON(env, 'route');
const getPause = (env) => getJSON(env, 'pause', { dates: [] });
const getChecks = (env, date) => getJSON(env, `checks:${date}`, []);

function validRoute(r) {
  if (!r || typeof r !== 'object') return 'route must be an object';
  if (!r.primary?.legs?.length) return 'route.primary.legs is required';
  if (!r.primary.legs.some((l) => l.transit)) return 'primary route has no transit legs';
  if (!/^\d{2}:\d{2}$/.test(r.departTime ?? '')) return 'departTime must be HH:MM';
  if (r.workdays && !(Array.isArray(r.workdays) && r.workdays.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)))
    return 'workdays must be weekday numbers 0-6';
  return null;
}

function validRecord(r) {
  if (!MODES.includes(r?.mode)) return `mode must be one of ${MODES.join('/')}`;
  if (!DATE_RE.test(r.targetDate ?? '')) return 'targetDate must be YYYY-MM-DD';
  if (!LEVELS.includes(r.level)) return `level must be one of ${LEVELS.join('/')}`;
  if (!String(r.headline ?? '').trim()) return 'headline is required';
  return null;
}

// ---------- push ----------

async function push(env, { title, message, priority = 3, click }) {
  if (!env.NTFY_TOPIC) return 'no-topic';
  const res = await fetch(`${env.NTFY_SERVER || 'https://ntfy.sh'}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ topic: env.NTFY_TOPIC, title, message, priority, ...(click ? { click } : {}) }),
  });
  return res.ok ? 'sent' : `ntfy ${res.status}`;
}

function pushText(record) {
  const check = checkByMode(record.mode);
  const lines = [record.headline];
  for (const leg of record.legs ?? []) {
    if (leg.level !== 'green') lines.push(`${LEVEL_EMOJI[leg.level] ?? ''} ${leg.name}：${leg.note}`);
  }
  if (record.planB) lines.push(`Plan B：${record.planB}`);
  return {
    title: `${LEVEL_EMOJI[record.level]} ${check?.label ?? record.mode}（${record.targetDate.slice(5)}）`,
    message: lines.join('\n').slice(0, 900),
  };
}

// ---------- timeline ----------

/** The commute day the app should feature: today until 10:00 on a commute day, otherwise the next one. */
function focusDate(now, workdays) {
  const today = pacificDate(now);
  if (workdays.includes(weekdayOf(today)) && pacificHHMM(now) < '10:00') return today;
  let d = addDays(today, 1);
  for (let i = 0; i < 7 && !workdays.includes(weekdayOf(d)); i++) d = addDays(d, 1);
  return d;
}

function timeline(date, records, now, paused) {
  return CHECKS.map((c) => {
    const runDate = addDays(date, c.runDayOffset);
    const due = pacificToDate(runDate, c.time);
    const record = records.find((r) => r.mode === c.mode) ?? null;
    let status;
    if (record) status = record.level === 'skip' ? 'skipped' : 'done';
    else if (paused) status = 'paused';
    else status = now.getTime() < due.getTime() + GRACE_MINUTES * 60000 ? 'pending' : 'missing';
    return { mode: c.mode, label: c.label, question: c.question, runDate, time: c.time, status, record };
  });
}

async function statusPayload(env, now) {
  const [route, pause] = await Promise.all([getRoute(env), getPause(env)]);
  const workdays = route?.workdays ?? DEFAULT_WORKDAYS;
  const focus = focusDate(now, workdays);
  const today = pacificDate(now);
  const dates = [...new Set([addDays(today, -1), today, focus])];
  const days = Object.fromEntries(await Promise.all(dates.map(async (d) => [d, await getChecks(env, d)])));
  const records = days[focus] ?? [];
  const latest = [...records].filter((r) => r.level !== 'skip').sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
  return {
    now: { date: today, time: pacificHHMM(now), iso: now.toISOString() },
    focusDate: focus,
    focusWeekday: weekdayOf(focus),
    paused: pause.dates.includes(focus),
    latest,
    timeline: timeline(focus, records, now, pause.dates.includes(focus)),
    days,
    pause,
    route: route
      ? { summary: route.primary.summary, startLocal: route.primary.startLocal, endLocal: route.primary.endLocal, home: route.home?.label, work: route.work?.label, workdays }
      : null,
  };
}

// ---------- watchdog ----------

async function watchdog(env, now) {
  const route = await getRoute(env);
  if (!route?.primary) return [];
  const workdays = route.workdays ?? DEFAULT_WORKDAYS;
  const pause = await getPause(env);
  const today = pacificDate(now);
  const hhmm = pacificHHMM(now);
  const origin = await env.CG.get('meta:origin');
  const sent = [];
  for (const c of CHECKS) {
    const target = addDays(today, -c.runDayOffset);
    if (!workdays.includes(weekdayOf(target)) || pause.dates.includes(target)) continue;
    const late = minutesBetween(c.time, hhmm);
    if (late < GRACE_MINUTES || late > 90) continue;
    if ((await getChecks(env, target)).some((r) => r.mode === c.mode)) continue;
    const flag = `watchdog:${target}:${c.mode}`;
    if (await env.CG.get(flag)) continue;
    await push(env, {
      title: `⚠️ ${c.label}没有运行`,
      message: `应在 ${c.time} 运行的检查到现在没有结果，系统可能没跑。没消息不代表没问题——出门前请自己看一眼 511.org、SF Bay Ferry 和 Muni 的公告。`,
      priority: 4,
      click: origin ?? undefined,
    });
    await env.CG.put(flag, '1', { expirationTtl: 3 * 86400 });
    sent.push(c.mode);
  }
  return sent;
}

// ---------- routes ----------

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;
  if (path === '/api/health') return json({ ok: true });

  const role = await roleOf(request, env);
  if (!role) return fail(401, 'unauthorized');
  const now = new Date();

  if (path === '/api/route' && method === 'GET') return json(await getRoute(env));
  if (path === '/api/route' && method === 'PUT') {
    if (role !== 'app') return fail(403, 'forbidden');
    const body = await request.json().catch(() => null);
    const err = validRoute(body);
    if (err) return fail(400, err);
    const route = {
      ...body,
      version: 1,
      savedAt: now.toISOString(),
      workdays: body.workdays ?? DEFAULT_WORKDAYS,
      alternatives: (body.alternatives ?? []).slice(0, 4),
    };
    await env.CG.put('route', JSON.stringify(route));
    await env.CG.put('meta:origin', url.origin);
    return json({ ok: true });
  }

  if (path === '/api/pause' && method === 'GET') return json(await getPause(env));
  if (path === '/api/pause' && method === 'PUT') {
    if (role !== 'app') return fail(403, 'forbidden');
    const body = await request.json().catch(() => null);
    const today = pacificDate(now);
    const dates = [...new Set((body?.dates ?? []).filter((d) => DATE_RE.test(d) && d >= today))].sort().slice(0, 60);
    await env.CG.put('pause', JSON.stringify({ dates }));
    return json({ dates });
  }

  if (path === '/api/status' && method === 'GET') return json(await statusPayload(env, now));
  if (path === '/api/status' && method === 'POST') {
    if (role !== 'writer') return fail(403, 'only the checker may post results');
    const record = await request.json().catch(() => null);
    const err = validRecord(record);
    if (err) return fail(400, err);
    record.checkedAt ??= now.toISOString();
    const list = (await getChecks(env, record.targetDate)).filter((r) => r.mode !== record.mode);
    list.push(record);
    list.sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
    await env.CG.put(`checks:${record.targetDate}`, JSON.stringify(list), { expirationTtl: CHECKS_TTL });
    let pushed = 'skipped';
    if (record.level !== 'skip') {
      const origin = (await env.CG.get('meta:origin')) ?? url.origin;
      pushed = await push(env, { ...pushText(record), priority: NTFY_PRIORITY[record.level], click: origin });
    }
    return json({ ok: true, pushed });
  }

  if (path === '/api/test-push' && method === 'POST') {
    const pushed = await push(env, {
      title: '🔔 通勤哨兵测试通知',
      message: '收到这条说明推送设置正确。🔴 级别的通知会用最高优先级。',
      priority: 3,
      click: url.origin,
    });
    return json({ pushed });
  }

  if (path === '/api/watchdog' && method === 'POST' && role === 'writer') return json({ sent: await watchdog(env, now) });

  return fail(404, 'not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (err) {
        return fail(500, String(err?.message ?? err));
      }
    }
    return env.ASSETS.fetch(request);
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(watchdog(env, new Date(event.scheduledTime)));
  },
};
