// Pure analysis: route + gathered data → digest with per-leg findings and a suggested level.
// Claude reads the digest and makes the final call; this layer only does what rules can do
// reliably (id matching, time windows, cancellations, missing predictions).

import { DIR_LABEL, checkByMode, commutesOn, dayTimes, fromMin, toMin } from '../../shared/schedule.mjs';
import { addDays, pacificDate, pacificHHMM, pacificToDate } from '../../shared/time.mjs';
import { idKey } from './normalize.mjs';
import { realtimeKinds } from './gather.mjs';

const RANK = { info: 0, yellow: 1, red: 2 };
const MODE_ZH = {
  FERRY: '渡轮',
  TRAM: '轻轨',
  SUBWAY: '地铁',
  RAIL: '火车',
  REGIONAL_RAIL: '火车',
  SUBURBAN: '通勤铁路',
  BUS: '公交',
  COACH: '巴士',
  CABLE_CAR: '缆车',
  FUNICULAR: '缆车',
};

const NO_SERVICE = new Set(['NO_SERVICE']);
const BENIGN = new Set(['ADDITIONAL_SERVICE', 'NO_EFFECT', 'ACCESSIBILITY_ISSUE']);
const AGENCY_WIDE_BAD = new Set(['NO_SERVICE', 'SIGNIFICANT_DELAYS', 'REDUCED_SERVICE']);
const ALARM_WORDS =
  /\b(suspend\w*|cancel+ed|cancel+ation|no (?:train|bus|ferry|rail|service)\w*|not (?:running|operating)|strike|shut ?down|bus bridge|shuttle bus\w*|single[- ]track\w*)\b/gi;
const SEVERE_WEATHER = /gale|storm warning|hurricane|dense fog|high wind|wind advisory|tsunami/i;

export const legLabel = (leg) =>
  `${MODE_ZH[leg.mode] ?? leg.mode} ${leg.routeShortName || idKey(leg.routeId).toUpperCase()}（${leg.agencyName ?? leg.agencyId}）`;

const routeKeys = (leg) => [idKey(leg.routeId), idKey(leg.routeShortName)].filter(Boolean);

/** Stop ids/codes in both 511 and Transitous spellings (Muni codes are "1" + stop id). */
function stopKeys(stop) {
  const keys = new Set();
  for (const v of [stop?.stopId, stop?.stopCode]) {
    const k = idKey(v);
    if (!k) continue;
    keys.add(k);
    if (/^1\d{4}$/.test(k)) keys.add(k.slice(1));
  }
  return [...keys];
}

const epoch = (dateStr, hhmm) => pacificToDate(dateStr, hhmm).getTime() / 1000;
const fmt = (sec) => (sec ? pacificHHMM(new Date(sec * 1000)) : null);
const fmtDay = (sec) => (sec ? `${pacificDate(new Date(sec * 1000)).slice(5)} ${fmt(sec)}` : null);

function overlaps(periods, [ws, we]) {
  if (!periods?.length) return true;
  return periods.some((p) => (p.start ?? -Infinity) <= we && (p.end ?? Infinity) >= ws);
}

// ---------- alerts ----------

function relevanceOf(alert, leg) {
  const rk = routeKeys(leg);
  const sk = [...stopKeys(leg.from), ...stopKeys(leg.to)];
  const tk = idKey(leg.tripId);
  let best = null;
  const order = ['agency', 'route-otherstop', 'stop', 'route', 'trip'];
  const bump = (r) => {
    if (!best || order.indexOf(r) > order.indexOf(best)) best = r;
  };
  for (const ie of alert.informed) {
    if (ie.agencyId && leg.agencyId && idKey(ie.agencyId) !== idKey(leg.agencyId)) continue;
    const routeHit = ie.routeId ? rk.includes(idKey(ie.routeId)) : null;
    const stopHit = ie.stopId ? sk.includes(idKey(ie.stopId)) : null;
    if (ie.tripId && tk && idKey(ie.tripId) === tk) bump('trip');
    else if (routeHit === false) continue;
    else if (routeHit && stopHit === false) bump('route-otherstop');
    else if (routeHit) bump('route');
    else if (stopHit) bump('stop');
    else if (!ie.routeId && !ie.stopId && !ie.tripId && ie.agencyId) bump('agency');
  }
  return best;
}

function alertSeverity(alert, relevance) {
  const direct = relevance === 'trip' || relevance === 'route' || relevance === 'stop';
  if (direct) {
    if (NO_SERVICE.has(alert.effect)) return 'red';
    return BENIGN.has(alert.effect) ? 'info' : 'yellow';
  }
  if (relevance === 'route-otherstop') return NO_SERVICE.has(alert.effect) ? 'yellow' : 'info';
  return AGENCY_WIDE_BAD.has(alert.effect) ? 'yellow' : 'info';
}

function matchAlerts(alerts, leg, window) {
  const out = [];
  for (const a of alerts ?? []) {
    if (!overlaps(a.activePeriods, window)) continue;
    const relevance = relevanceOf(a, leg);
    if (!relevance) continue;
    const words = [...new Set(`${a.header} ${a.description}`.match(ALARM_WORDS) ?? [])];
    out.push({
      id: a.id,
      agency: a.agency,
      relevance,
      severity: alertSeverity(a, relevance),
      effect: a.effect,
      cause: a.cause,
      header: a.header,
      description: a.description.slice(0, 700),
      url: a.url || null,
      alarmWords: words,
      active: a.activePeriods.map((p) => ({ start: fmtDay(p.start), end: fmtDay(p.end) })),
    });
  }
  return out.sort((x, y) => RANK[y.severity] - RANK[x.severity]);
}

// ---------- realtime ----------

function ferryRealtime(leg, planned, data) {
  const ag = leg.agencyId;
  const key = `${ag}:${leg.from.stopCode || leg.from.stopId}`;
  const rk = routeKeys(leg);
  const fk = stopKeys(leg.from);
  const lineOk = (line) => !line || rk.includes(idKey(line));
  const out = { kind: 'ferry', plannedDep: fmt(planned), tripRef: null, status: 'unknown', delayMin: null };

  const tt = data.timetable[key];
  if (Array.isArray(tt)) {
    const near = tt
      .filter((v) => v.aimed && lineOk(v.line) && Math.abs(v.aimed - planned) <= 15 * 60)
      .sort((a, b) => Math.abs(a.aimed - planned) - Math.abs(b.aimed - planned));
    if (near[0]) out.tripRef = near[0].journeyRef;
  }

  const tus = data.tripUpdates[ag];
  if (Array.isArray(tus)) {
    const onRoute = (t) => !t.routeId || rk.includes(idKey(t.routeId));
    let mine = out.tripRef ? tus.find((t) => idKey(t.tripId) === idKey(out.tripRef)) : null;
    mine ??= tus.find((t) =>
      t.stops.some(
        (s) => fk.includes(idKey(s.stopId)) && s.depTime && Math.abs(s.depTime - (s.depDelay ?? 0) - planned) <= 5 * 60,
      ),
    );
    // Cancelled trips often carry no stop updates; fall back to the trip's start time.
    mine ??= tus.find(
      (t) =>
        t.relationship === 'CANCELED' &&
        onRoute(t) &&
        t.startTime &&
        Math.abs(epoch(pacificDate(new Date(planned * 1000)), t.startTime.slice(0, 5)) - planned) <= 3 * 60,
    );
    out.canceledOnRoute = tus
      .filter((t) => t.relationship === 'CANCELED' && onRoute(t))
      .map((t) => ({ tripId: t.tripId, startTime: t.startTime }));
    if (mine) {
      out.tripRef ??= mine.tripId;
      if (mine.relationship === 'CANCELED') out.status = 'canceled';
      else {
        out.status = 'tracked';
        const st = mine.stops.find((s) => fk.includes(idKey(s.stopId)));
        if (st?.relationship === 'SKIPPED') out.status = 'skips-your-stop';
        else if (st) {
          const delay = st.depDelay ?? (st.depTime ? st.depTime - planned : null);
          if (delay !== null) out.delayMin = Math.round(delay / 60);
        }
      }
    }
  }

  const sv = data.stopVisits[key];
  if (Array.isArray(sv)) {
    const mineVisits = sv.filter((v) => lineOk(v.line));
    out.upcoming = mineVisits.slice(0, 4).map((v) => ({ line: v.line, aimed: fmt(v.aimed), expected: fmt(v.expected) }));
    const near = mineVisits
      .filter((v) => v.aimed && Math.abs(v.aimed - planned) <= 15 * 60)
      .sort((a, b) => Math.abs(a.aimed - planned) - Math.abs(b.aimed - planned))[0];
    if (near?.expected && out.delayMin === null) {
      out.delayMin = Math.round((near.expected - near.aimed) / 60);
      if (out.status === 'unknown') out.status = 'tracked';
    }
  }

  // The next boat on this line after yours that isn't cancelled — what the user would take instead.
  if (Array.isArray(tt)) {
    const canceled = new Set((out.canceledOnRoute ?? []).map((t) => idKey(t.tripId)));
    const next = tt
      .filter((v) => v.aimed > planned + 60 && lineOk(v.line) && !canceled.has(idKey(v.journeyRef)))
      .sort((a, b) => a.aimed - b.aimed)[0];
    out.nextDep = fmt(next?.aimed) ?? null;
  }

  // `key` identifies the condition across polls (the Worker's watch diffs them); text may change.
  const flags = [];
  const label = `${out.plannedDep} 那班 ${leg.routeShortName ?? ''} 船`;
  const instead = out.nextDep ? `，下一班 ${out.nextDep}` : '';
  if (out.status === 'canceled') flags.push({ level: 'red', key: 'ferry:canceled', text: `${label}已取消${instead}` });
  else if (out.status === 'skips-your-stop')
    flags.push({ level: 'red', key: 'ferry:skips', text: `${label}不停 ${leg.from.name}${instead}` });
  if (out.delayMin !== null && out.delayMin >= 30)
    flags.push({ level: 'red', key: 'ferry:delay', text: `${label}预计晚 ${out.delayMin} 分钟` });
  else if (out.delayMin !== null && out.delayMin >= 10)
    flags.push({ level: 'yellow', key: 'ferry:delay', text: `${label}预计晚 ${out.delayMin} 分钟` });
  const others = (out.canceledOnRoute ?? []).filter((t) => idKey(t.tripId) !== idKey(out.tripRef));
  if (others.length && out.status !== 'canceled') {
    flags.push({
      level: out.status === 'unknown' ? 'yellow' : 'info',
      key: 'ferry:others-canceled',
      text: `该航线今天有 ${others.length} 班被取消${out.status === 'unknown' ? '（无法确认是否包括你那班）' : ''}`,
    });
  }
  return { ...out, flags };
}

/** How far ahead line predictions are judged; the Worker's watch starts early, so it waits longer. */
const LINE_LOOKAHEAD_MIN = { monitor: 75 };

function lineRealtime(leg, planned, nowSec, data, mode) {
  const key = `${leg.agencyId}:${leg.from.stopCode || leg.from.stopId}`;
  const out = { kind: 'line', plannedDep: fmt(planned), status: 'unknown', upcoming: [] };
  const flags = [];
  if (planned - nowSec > (LINE_LOOKAHEAD_MIN[mode] ?? 120) * 60) return { ...out, status: 'too-early', flags };
  const sv = data.stopVisits[key];
  if (!Array.isArray(sv)) return { ...out, status: 'error', flags };
  if (!sv.length) {
    flags.push({
      level: 'yellow',
      key: 'line:no-data',
      text: `${leg.from.name} 站实时数据为空，无法确认 ${leg.routeShortName} 是否在跑`,
    });
    return { ...out, status: 'no-data', flags };
  }
  const rk = routeKeys(leg);
  const t = (v) => v.expected ?? v.aimed;
  const mine = sv.filter((v) => rk.includes(idKey(v.line)) || rk.includes(idKey(v.lineName))).filter((v) => t(v));
  out.upcoming = mine
    .sort((a, b) => t(a) - t(b))
    .slice(0, 5)
    .map((v) => ({
      expected: fmt(t(v)),
      delayMin: v.expected && v.aimed ? Math.round((v.expected - v.aimed) / 60) : null,
      destination: v.destination,
    }));
  const nearPlan = mine.filter((v) => t(v) >= planned - 20 * 60 && t(v) <= planned + 40 * 60);
  const nearNow = mine.filter((v) => t(v) >= nowSec && t(v) <= nowSec + 60 * 60);
  if (nearPlan.length) out.status = 'running';
  else if (nearNow.length) out.status = 'running-now';
  else if (mine.length) {
    out.status = 'sparse';
    flags.push({
      level: 'info',
      key: 'line:sparse',
      text: `${leg.routeShortName} 在 ${leg.from.name} 的下一班预测要到 ${fmt(t(mine[0]))}`,
    });
  } else {
    out.status = 'no-predictions';
    flags.push({
      level: 'yellow',
      key: 'line:no-predictions',
      text: `${leg.from.name} 站有其他线路的实时预测，但 ${leg.routeShortName} 没有任何班次（可能停运或大间隔）`,
    });
  }
  return { ...out, flags };
}

// ---------- weather ----------

function maxNumber(str, unit) {
  const re = new RegExp(`(\\d+)(?:\\s*to\\s*(\\d+))?\\s*${unit}`, 'gi');
  let max = null;
  for (const m of str.matchAll(re)) max = Math.max(max ?? 0, Number(m[2] ?? m[1]));
  return max;
}

function analyzeWeather(weather, window) {
  const flags = [];
  const toSec = (iso) => (iso ? new Date(iso).getTime() / 1000 : null);
  const alerts = (weather.alerts ?? []).filter((a) =>
    overlaps([{ start: toSec(a.onset), end: toSec(a.ends) }], window),
  );
  for (const a of alerts) {
    const when = `${fmtDay(toSec(a.onset)) ?? '?'} – ${fmtDay(toSec(a.ends)) ?? '?'}`;
    flags.push({
      level: SEVERE_WEATHER.test(a.event) ? 'yellow' : 'info',
      key: `weather:${a.event}`,
      text: `NWS ${a.event}（${when}）`,
    });
  }
  const hourly = (weather.hourly ?? [])
    .filter((p) => {
      const s = toSec(p.start);
      return s >= window[0] && s <= window[1];
    })
    .map((p) => ({ time: fmt(toSec(p.start)), temp: p.temperature, wind: `${p.windDirection} ${p.windSpeed}`, sky: p.short }));
  const windMph = Math.max(0, ...hourly.map((h) => maxNumber(h.wind, 'mph') ?? 0));
  if (windMph >= 30) flags.push({ level: 'yellow', key: 'weather:wind', text: `通勤时段风速可达 ${windMph} mph` });
  if (hourly.some((h) => /fog/i.test(h.sky))) flags.push({ level: 'info', key: 'weather:fog', text: '通勤时段有雾' });
  const marine = (weather.marine ?? []).slice(0, 3).map((p) => ({ name: p.name, forecast: p.detailed }));
  const kt = marine.length ? maxNumber(marine[0].forecast + ' ' + (marine[1]?.forecast ?? ''), 'kt') : null;
  if (kt !== null && kt >= 30)
    flags.push({ level: 'yellow', key: 'weather:marine', text: `海湾风力预报最高 ${kt} kt，渡轮可能受影响` });
  return { alerts, hourly, marine, flags };
}

// ---------- arrival estimate ----------

/**
 * Move the planned arrival by what realtime says: a late boat, or a cancelled one (take the
 * next), then the first predicted Muni/bus after the user can reach that stop.
 */
function estimateArrival(trip, legsOut) {
  const p = trip.primary;
  const basis = [];
  let shift = 0;
  let known = true;
  let ti = 0;
  p.legs.forEach((leg, i) => {
    if (!leg.transit) return;
    const out = legsOut[ti++];
    const rt = out?.realtime;
    if (!known) return;
    const dep = toMin(leg.depLocal);
    // A leg that is down (suspended, no service) has no arrival time to estimate —
    // except a cancelled boat, where the next boat gives one.
    const boatHandled = rt?.kind === 'ferry' && (rt.status === 'canceled' || rt.status === 'skips-your-stop');
    if (out?.level === 'red' && !boatHandled) {
      known = false;
      return;
    }
    if (!rt) return;
    if (rt.kind === 'ferry') {
      if (rt.status === 'canceled' || rt.status === 'skips-your-stop') {
        if (!rt.nextDep) {
          known = false;
          return;
        }
        shift = Math.max(shift, toMin(rt.nextDep) - dep);
        basis.push(`改坐 ${rt.nextDep} 的船`);
      } else if (rt.delayMin > 0) {
        shift = Math.max(shift, rt.delayMin);
        basis.push(`船晚 ${rt.delayMin} 分钟`);
      }
      return;
    }
    if (rt.status !== 'running' && rt.status !== 'running-now') return;
    const ready = toMin(p.legs[i - 1]?.arrLocal ?? leg.depLocal) + shift;
    const next = rt.upcoming
      .map((u) => toMin(u.expected))
      .filter((m) => m >= ready)
      .sort((a, b) => a - b)[0];
    if (next === undefined) return;
    shift = next - dep;
    basis.push(`${leg.routeShortName ?? ''} 预计 ${fromMin(next)} 开`);
  });

  const eta = known ? fromMin(toMin(p.endLocal) + shift) : null;
  const lateMin = eta && trip.arriveBy ? toMin(eta) - toMin(trip.arriveBy) : null;
  const flags = [];
  if (lateMin > 0 && shift > 0)
    flags.push({ level: 'yellow', key: 'late', text: `预计 ${eta} 到，比要求的 ${trip.arriveBy} 晚 ${lateMin} 分钟` });
  else if (lateMin > 0)
    flags.push({ level: 'info', key: 'plan-late', text: `按计划 ${eta} 到，晚于你要求的 ${trip.arriveBy}` });
  return {
    plannedStart: p.startLocal,
    plannedArrival: p.endLocal,
    arriveBy: trip.arriveBy ?? null,
    eta,
    shiftMin: known ? shift : null,
    lateMin,
    basis,
    flags,
  };
}

// ---------- digest ----------

function legSummary(leg) {
  return {
    label: legLabel(leg),
    mode: leg.mode,
    agencyId: leg.agencyId,
    route: leg.routeShortName,
    headsign: leg.headsign ?? null,
    from: leg.from?.name,
    to: leg.to?.name,
    depLocal: leg.depLocal,
    arrLocal: leg.arrLocal,
  };
}

const levelOf = (flags) =>
  flags.reduce((lvl, f) => (RANK[f.level] > RANK[lvl] ? f.level : lvl), 'info');

/** Commute date a check is about: the night check looks at tomorrow. */
export function targetDateFor(mode, now) {
  const today = pacificDate(now);
  return mode === 'night' ? addDays(today, 1) : today;
}

export function skipReason({ date, dir, route, pause }) {
  if (!route) return null; // handled as an error, not a skip
  if (!dayTimes(route, date)) return { reason: 'not-workday', message: `${date} 不是通勤日` };
  if (!commutesOn(route, date, dir)) return { reason: 'no-trip', message: `${date} 没有设置${DIR_LABEL[dir]}的路线或时间` };
  if ((pause?.dates ?? []).includes(date)) return { reason: 'paused', message: `${date} 已设为暂停/请假` };
  return null;
}

/**
 * route: the saved route (schedule, home/work); trip: tripFor(route, date, dir) — the one
 * itinerary (plus alternatives) to judge; gathered: output of gather().
 */
export function analyze({ mode, now = new Date(), date, dir, route, trip, pause, gathered }) {
  const check = checkByMode(mode);
  const nowSec = now.getTime() / 1000;
  const base = {
    version: 2,
    mode,
    modeLabel: check?.label ?? mode,
    question: check?.question ?? '',
    dir,
    dirLabel: DIR_LABEL[dir],
    generatedAt: now.toISOString(),
    nowLocal: pacificHHMM(now),
    targetDate: date,
  };
  const problem = (reason) => ({ ...base, skip: null, suggestedLevel: 'yellow', reasons: [reason], legs: [], errors: [] });

  if (!route) return problem('还没有设置通勤路线：打开 App 的「设置」页面选一条路线');
  const skip = skipReason({ date, dir, route, pause });
  if (skip) return { ...base, skip, suggestedLevel: 'skip', reasons: [skip.message], legs: [], errors: [] };
  if (!trip) return problem(`还没有选${DIR_LABEL[dir]}的路线：打开 App 的「设置」页面选一条`);

  const { data, errors } = gathered;
  const rt = realtimeKinds(mode);
  const p = trip.primary;
  const commuteWindow = [epoch(date, p.startLocal) - 30 * 60, epoch(date, p.endLocal) + 30 * 60];
  const isToday = date === pacificDate(now);

  const legs = p.legs
    .filter((l) => l.transit)
    .map((leg) => {
      const dep = epoch(date, leg.depLocal);
      const arr = epoch(date, leg.arrLocal);
      const alerts = matchAlerts(data.alerts[leg.agencyId], leg, [dep - 30 * 60, arr + 30 * 60]);
      const flags = alerts
        .filter((a) => a.severity !== 'info')
        .map((a) => ({ level: a.severity, key: `alert:${a.id}`, text: `${a.header || a.effect}`, url: a.url }));
      let realtime = null;
      if (isToday && leg.mode === 'FERRY' && rt.ferry) realtime = ferryRealtime(leg, dep, data);
      else if (isToday && leg.mode !== 'FERRY' && rt.line) realtime = lineRealtime(leg, dep, nowSec, data, mode);
      if (realtime) flags.push(...realtime.flags);
      const stopKey = `${leg.agencyId}:${leg.from.stopCode || leg.from.stopId}`;
      const errs = errors.filter(
        (e) =>
          e.source === `511 alerts ${leg.agencyId}` ||
          e.source.endsWith(stopKey) ||
          (leg.mode === 'FERRY' && e.source === `511 trip updates ${leg.agencyId}`),
      );
      if (errs.length) {
        const sources = errs.map((e) => e.source.replace(/^511 /, '')).join('、');
        flags.push({ level: 'yellow', key: 'source', text: `数据源出错（${sources}），这一段无法完全确认` });
      }
      return { ...legSummary(leg), level: levelOf(flags), flags, alerts, realtime };
    });

  const alternatives = (trip.alternatives ?? []).map((it) => {
    const flags = [];
    for (const leg of it.legs.filter((l) => l.transit)) {
      const dep = epoch(date, leg.depLocal);
      const arr = epoch(date, leg.arrLocal);
      for (const a of matchAlerts(data.alerts[leg.agencyId], leg, [dep - 30 * 60, arr + 30 * 60])) {
        if (a.severity !== 'info') flags.push({ level: a.severity, text: `${legLabel(leg)}：${a.header || a.effect}` });
      }
    }
    return {
      summary: it.summary,
      startLocal: it.startLocal,
      endLocal: it.endLocal,
      durationMin: it.durationMin,
      level: levelOf(flags),
      flags,
      legs: it.legs.filter((l) => l.transit).map(legSummary),
    };
  });

  const weather = analyzeWeather(data.weather, commuteWindow);
  const weatherErrors = errors.filter((e) => e.source.startsWith('NWS'));
  const timing = estimateArrival(trip, legs);

  const otherAlerts = {};
  for (const [ag, list] of Object.entries(data.alerts)) {
    otherAlerts[ag] = list.length;
  }

  const ranked = [
    ...legs.flatMap((l) => l.flags.map((f) => ({ ...f, text: `${l.label}：${f.text}` }))),
    ...weather.flags.map((f) => ({ ...f, text: `天气：${f.text}` })),
    ...timing.flags,
  ].filter((f) => f.level !== 'info');
  const top = levelOf(ranked);
  const suggestedLevel = top === 'info' ? 'green' : top;
  const reasons = ranked.length
    ? ranked.sort((a, b) => RANK[b.level] - RANK[a.level]).map((f) => `${f.level === 'red' ? '🔴' : '🟡'} ${f.text}`)
    : ['没有发现与你路线相关的问题'];

  return {
    ...base,
    skip: null,
    route: {
      summary: p.summary,
      home: route.home?.label,
      work: route.work?.label,
      leaveAt: trip.time,
      arriveBy: trip.arriveBy,
      startLocal: p.startLocal,
      endLocal: p.endLocal,
      planSource: trip.source,
    },
    suggestedLevel,
    reasons,
    legs,
    timing,
    alternatives,
    weather: { ...weather, errors: weatherErrors },
    alertCountsByAgency: otherAlerts,
    errors,
  };
}
