// Pure analysis: route + gathered data → digest with per-leg findings and a suggested level.
// Claude reads the digest and makes the final call; this layer only does what rules can do
// reliably (id matching, time windows, cancellations, missing predictions).

import { DIR_LABEL, NIGHT_AFTER_MIDNIGHT_UNTIL, checkByMode, commutesOn, dayTimes, fromMin, toMin } from '../../shared/schedule.mjs';
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

/** tripKeys: ids the user's own run is known by (the saved plan's, and the one 511's timetable matched). */
function relevanceOf(alert, leg, tripKeys) {
  const rk = routeKeys(leg);
  const sk = [...stopKeys(leg.from), ...stopKeys(leg.to)];
  let best = null;
  const order = ['other-trip', 'agency', 'route-otherstop', 'stop', 'route', 'trip'];
  const bump = (r) => {
    if (!best || order.indexOf(r) > order.indexOf(best)) best = r;
  };
  for (const ie of alert.informed) {
    if (ie.agencyId && leg.agencyId && idKey(ie.agencyId) !== idKey(leg.agencyId)) continue;
    const routeHit = ie.routeId ? rk.includes(idKey(ie.routeId)) : null;
    const stopHit = ie.stopId ? sk.includes(idKey(ie.stopId)) : null;
    if (routeHit === false) continue;
    // A trip-level entity names one departure: ours, another run on the same line, or — when we
    // don't know which run is ours — possibly ours, so it counts like the route.
    if (ie.tripId) {
      bump(!tripKeys.length ? 'route' : tripKeys.includes(idKey(ie.tripId)) ? 'trip' : 'other-trip');
      continue;
    }
    else if (routeHit && stopHit === false) bump('route-otherstop');
    else if (routeHit) bump('route');
    else if (stopHit) bump('stop');
    else if (!ie.routeId && !ie.stopId && !ie.tripId && ie.agencyId) bump('agency');
  }
  return best;
}

function alertSeverity(alert, relevance) {
  if (relevance === 'other-trip') return 'info';
  const direct = relevance === 'trip' || relevance === 'route' || relevance === 'stop';
  if (direct) {
    if (NO_SERVICE.has(alert.effect)) return 'red';
    return BENIGN.has(alert.effect) ? 'info' : 'yellow';
  }
  if (relevance === 'route-otherstop') return NO_SERVICE.has(alert.effect) ? 'yellow' : 'info';
  return AGENCY_WIDE_BAD.has(alert.effect) ? 'yellow' : 'info';
}

function matchAlerts(alerts, leg, window, tripKeys = [idKey(leg.tripId)].filter(Boolean)) {
  const out = [];
  for (const a of alerts ?? []) {
    if (!overlaps(a.activePeriods, window)) continue;
    const relevance = relevanceOf(a, leg, tripKeys);
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

/**
 * The user's boat at the boarding terminal. Terminals serve both directions (the morning boat's
 * destination is where the evening boat leaves), so calls are matched to the direction of the
 * user's own departure, and only trips for this service day count.
 * `suspended`: the line has a no-service alert, so no "next boat" is promised.
 */
function ferryRealtime(leg, planned, data, { date, suspended = false }) {
  const ag = leg.agencyId;
  const key = `${ag}:${leg.from.stopCode || leg.from.stopId}`;
  const rk = routeKeys(leg);
  const fk = stopKeys(leg.from);
  const lineOk = (line) => !line || rk.includes(idKey(line));
  const out = { kind: 'ferry', plannedDep: fmt(planned), tripRef: null, status: 'unknown', delayMin: null };

  const tt = Array.isArray(data.timetable[key]) ? data.timetable[key].filter((v) => v.aimed && lineOk(v.line)) : null;
  // Calls that only arrive here (a boat ending its trip) are never the user's departure.
  const departing = tt?.filter((v) => v.departs !== false) ?? null;
  const legTrip = idKey(leg.tripId);
  const mineTT = tt
    ? ((legTrip && tt.find((v) => idKey(v.journeyRef) === legTrip)) ??
      departing
        .filter((v) => Math.abs(v.aimed - planned) <= 15 * 60)
        .sort((a, b) => Math.abs(a.aimed - planned) - Math.abs(b.aimed - planned))[0] ??
      null)
    : null;
  if (mineTT) out.tripRef = mineTT.journeyRef;
  const direction = mineTT?.direction ?? null;
  const sameDir = (v) => !direction || !v.direction || v.direction === direction;
  // Without a timetable we can't tell which trips call here in the user's direction.
  const servesHere = (tripId) => !tt?.length || tt.some((v) => idKey(v.journeyRef) === idKey(tripId) && sameDir(v));
  const serviceDay = date.replaceAll('-', '');
  const thisDay = (t) => !t.startDate || t.startDate === serviceDay;

  const tus = data.tripUpdates[ag];
  if (Array.isArray(tus)) {
    const onRoute = (t) => !t.routeId || rk.includes(idKey(t.routeId));
    const ref = out.tripRef ?? legTrip;
    let mine = ref ? tus.find((t) => idKey(t.tripId) === idKey(ref) && thisDay(t)) : null;
    mine ??= tus.find(
      (t) =>
        thisDay(t) &&
        servesHere(t.tripId) &&
        t.stops.some(
          (s) => fk.includes(idKey(s.stopId)) && s.depTime && Math.abs(s.depTime - (s.depDelay ?? 0) - planned) <= 5 * 60,
        ),
    );
    // Cancelled trips often carry no stop updates. When the timetable didn't identify our trip,
    // fall back to the trip's start time.
    let byStartTime = false;
    if (!mine && !mineTT) {
      mine =
        tus.find(
          (t) =>
            t.relationship === 'CANCELED' &&
            onRoute(t) &&
            thisDay(t) &&
            servesHere(t.tripId) &&
            t.startTime &&
            Math.abs(epoch(date, t.startTime.slice(0, 5)) - planned) <= 3 * 60,
        ) ?? null;
      byStartTime = Boolean(mine);
    }
    out.canceledOnRoute = tus
      .filter((t) => t.relationship === 'CANCELED' && onRoute(t) && thisDay(t) && servesHere(t.tripId))
      .map((t) => ({ tripId: t.tripId, startTime: t.startTime }));
    if (mine) {
      out.tripRef ??= mine.tripId;
      // Matched only by start time (no timetable, ids differ): it may be another boat, e.g. one
      // leaving the other terminal at that time.
      out.uncertain = byStartTime;
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
    // StopMonitoring uses other direction codes than the timetable ('OB' vs 'SF'), so visits are
    // matched by journey id when 511 gives one, else by time.
    const mineVisits = sv.filter((v) => lineOk(v.line));
    out.upcoming = mineVisits.slice(0, 4).map((v) => ({ line: v.line, aimed: fmt(v.aimed), expected: fmt(v.expected) }));
    const near =
      (out.tripRef && mineVisits.find((v) => v.journeyRef && idKey(v.journeyRef) === idKey(out.tripRef))) ??
      mineVisits
        .filter((v) => v.aimed && Math.abs(v.aimed - planned) <= 15 * 60)
        .sort((a, b) => Math.abs(a.aimed - planned) - Math.abs(b.aimed - planned))[0];
    if (near?.expected && out.delayMin === null) {
      out.delayMin = Math.round((near.expected - near.aimed) / 60);
      if (out.status === 'unknown') out.status = 'tracked';
    }
  }

  // Later boats in the user's direction that aren't cancelled — what they would take instead.
  if (departing) {
    const canceled = new Set((out.canceledOnRoute ?? []).map((t) => idKey(t.tripId)));
    out.later = suspended
      ? []
      : departing
          .filter((v) => sameDir(v) && v.aimed > planned + 60 && !canceled.has(idKey(v.journeyRef)))
          .sort((a, b) => a.aimed - b.aimed)
          .slice(0, 6)
          .map((v) => ({ time: fmt(v.aimed), ref: v.journeyRef }));
    out.laterDeps = out.later.map((v) => v.time);
    out.nextDep = out.laterDeps[0] ?? null;
  }

  // `key` identifies the condition across polls (the Worker's watch diffs them); text may change.
  // `sig` changing on an already-notified problem is worth telling the user again (a different
  // next boat; a delay growing by another 10 minutes).
  const flags = [];
  const label = `${out.plannedDep} 那班 ${leg.routeShortName ?? ''} 船`;
  const instead = out.nextDep ? `，下一班 ${out.nextDep}` : '';
  if (out.status === 'canceled') {
    flags.push(
      out.uncertain
        ? { level: 'yellow', key: 'ferry:canceled', sig: out.nextDep ?? '', text: `${label}可能已取消（只按出发时间对上，没法确认是不是你这班）${instead}` }
        : { level: 'red', key: 'ferry:canceled', sig: out.nextDep ?? '', text: `${label}已取消${instead}` },
    );
  } else if (out.status === 'skips-your-stop') {
    flags.push({ level: 'red', key: 'ferry:skips', sig: out.nextDep ?? '', text: `${label}不停 ${leg.from.name}${instead}` });
  } else if (tt && !mineTT && out.status === 'unknown') {
    // The timetable came back but has no such boat (or none on this line at all): holiday or a schedule change.
    flags.push({
      level: 'yellow',
      key: 'ferry:not-in-timetable',
      sig: out.nextDep ?? '',
      text: tt.length ? `今天的时刻表里没有 ${label}（可能改了班表）${instead}` : `今天的时刻表里没有 ${leg.routeShortName ?? ''} 船在 ${leg.from.name} 开（可能停航或改了班表）`,
    });
  }
  if (out.delayMin !== null && out.delayMin >= 10) {
    flags.push({
      level: out.delayMin >= 30 ? 'red' : 'yellow',
      key: 'ferry:delay',
      sig: Math.floor(out.delayMin / 10),
      text: `${label}预计晚 ${out.delayMin} 分钟`,
    });
  }
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
      aimed: fmt(v.aimed ?? t(v)),
      delayMin: v.expected && v.aimed ? Math.round((v.expected - v.aimed) / 60) : null,
      destination: v.destination,
    }));
  const nearPlan = mine.filter((v) => t(v) >= planned - 20 * 60 && t(v) <= planned + 40 * 60);
  const nearNow = mine.filter((v) => t(v) >= nowSec && t(v) <= nowSec + 60 * 60);
  // Close to departure, nothing near the planned time is a gap in service (the planned run is
  // missing) — judged on the planned time, so it doesn't "clear" just because the clock moves on.
  const soon = planned - nowSec <= 45 * 60;
  // The next vehicle still to come (the feed can still list one that just left).
  const next = mine.find((v) => t(v) >= Math.max(nowSec, planned - 20 * 60)) ?? mine.at(-1);
  if (nearPlan.length) out.status = 'running';
  else if (mine.length && soon) {
    out.status = 'sparse';
    flags.push({
      level: 'yellow',
      key: 'line:gap',
      text: `${leg.from.name} 站 ${fmt(planned)} 附近没有 ${leg.routeShortName}，下一班要到 ${fmt(t(next))}`,
    });
  } else if (nearNow.length) out.status = 'running-now';
  else if (mine.length) {
    out.status = 'sparse';
    flags.push({ level: 'info', key: 'line:sparse', text: `${leg.routeShortName} 在 ${leg.from.name} 的下一班预测要到 ${fmt(t(next))}` });
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

// Red flags that still leave a way through (a later boat, a late boat). Any other red flag on a
// leg — a line- or stop-wide no-service alert — means there is no arrival time to estimate.
const PASSABLE_RED = new Set(['ferry:canceled', 'ferry:skips', 'ferry:delay']);
const passable = (f) => f.level !== 'red' || PASSABLE_RED.has(f.key) || f.relevance === 'trip';

/**
 * Move the planned arrival by what realtime says, leg by leg. A boat leaves on its own (possibly
 * delayed) schedule, so what matters is whether the user reaches the dock in time, else the next
 * boat; on a Muni/bus leg, the vehicle the user is waiting for (or the first after they arrive).
 *
 * Feeds forget a leg once it is over (passed stops and departed trips drop out, a cancelled trip
 * disappears after its time), so each leg remembers what was worked out (`prev`, the previous
 * poll's timing.legs) and keeps it when the feed has gone quiet — but never when the feed still
 * reports something newer about that leg.
 *
 * Returns the timing plus `legFlags`: boat-change flags that belong to a leg (missed connection,
 * the replacement boat cancelled too), merged into that leg's flags by the caller.
 */
function estimateArrival(trip, legsOut, { nowMin = null, prev = null } = {}) {
  const p = trip.primary;
  const basis = [];
  const flags = [];
  const states = [];
  const legFlags = {};
  let shift = 0;
  let known = true;
  let ti = 0;
  const flagLeg = (idx, f) => (legFlags[idx] ??= []).push(f);
  p.legs.forEach((leg, i) => {
    if (!leg.transit) return;
    const idx = ti++;
    if (!known) {
      states.push(null);
      return;
    }
    const out = legsOut[idx];
    const rt = out?.realtime;
    const before = prev?.[idx]?.shift != null ? prev[idx] : null;
    const dep = toMin(leg.depLocal);
    const ready = toMin(p.legs[i - 1]?.arrLocal ?? leg.depLocal) + shift;
    const set = (state) => {
      states.push(state);
      if (state.shift === null) known = false;
      else shift = state.shift;
      if (state.note) basis.push(state.note);
      if (state.flag) flagLeg(idx, state.flag);
    };
    const down = () => set({ shift: null, boardAt: dep, informed: true, note: null });
    if (!(out?.flags ?? []).every(passable)) return down();
    // Without realtime: on time if the user is there in time, else assume the lateness carries over.
    const plain = { shift: ready > dep ? shift : 0, boardAt: ready > dep ? dep + shift : dep, informed: false, note: null };

    if (rt?.kind === 'ferry') {
      const later = rt.later ?? [];
      const nextBoat = (from) => later.find((x) => toMin(x.time) >= from);
      const take = (next, note, flag) =>
        next
          ? set({ shift: toMin(next.time) - dep, boardAt: toMin(next.time), boardRef: next.ref, informed: true, note, flag })
          : down();
      const gone =
        rt.status === 'canceled' ||
        rt.status === 'skips-your-stop' ||
        out.flags.some((f) => (f.level === 'red' && f.relevance === 'trip') || f.key === 'ferry:not-in-timetable');
      const tracked = rt.status === 'tracked' && rt.delayMin !== null;
      // Once the user has switched to a later boat, news about the original one no longer applies
      // (feeds can keep listing it); and when the feed goes quiet, what we knew still holds. Only
      // the boat they switched to being cancelled too changes things.
      if (!gone && (before?.boardRef || (!tracked && before?.informed))) {
        const replaced = before.boardRef && (rt.canceledOnRoute ?? []).some((t) => idKey(t.tripId) === idKey(before.boardRef));
        if (!replaced) return set(before);
        const next = nextBoat(before.boardAt + 1);
        return take(
          next,
          next && `改坐 ${next.time} 的船`,
          next && {
            level: 'red',
            key: 'ferry:canceled',
            sig: next.time,
            text: `${fromMin(before.boardAt)} 那班也取消了，下一班 ${next.time}`,
          },
        );
      }
      if (gone) {
        const next = nextBoat(ready);
        return take(next, next && `改坐 ${next.time} 的船`);
      }
      if (tracked) {
        const boatDep = dep + Math.max(0, rt.delayMin);
        if (ready <= boatDep) {
          return set({ shift: boatDep - dep, boardAt: boatDep, informed: true, note: rt.delayMin > 0 ? `船晚 ${rt.delayMin} 分钟` : null });
        }
        const next = nextBoat(ready);
        return take(next, next && `赶不上 ${leg.depLocal} 的船，坐 ${next.time} 的`, next && missedFlag(leg, ready, next.time));
      }
      if (ready > dep && later.length) {
        // No word on the boat, but the user reaches the dock after it leaves.
        const next = nextBoat(ready);
        return take(next, next && `赶不上 ${leg.depLocal} 的船，坐 ${next.time} 的`, next && missedFlag(leg, ready, next.time));
      }
      return set(plain);
    }

    if (rt?.kind === 'line') {
      const ups = (rt.upcoming ?? []).map((u) => ({ at: toMin(u.expected), aimed: toMin(u.aimed ?? u.expected) }));
      // The run the user is waiting for is still in the feed: follow its prediction.
      const same = before?.boardAimed != null ? ups.find((u) => u.aimed === before.boardAimed) : null;
      if (same) return set({ ...before, shift: same.at - dep, boardAt: same.at, informed: true, note: `${leg.routeShortName ?? ''} 预计 ${fromMin(same.at)} 开` });
      // That run has left and the user should be on it.
      if (before && nowMin !== null && nowMin > before.boardAt + 1) return set(before);
      if (['running', 'running-now', 'sparse'].includes(rt.status)) {
        const next = ups.filter((u) => u.at >= Math.max(ready, nowMin ?? ready)).sort((a, b) => a.at - b.at)[0];
        if (next) {
          return set({ shift: next.at - dep, boardAt: next.at, boardAimed: next.aimed, informed: true, note: `${leg.routeShortName ?? ''} 预计 ${fromMin(next.at)} 开` });
        }
      }
      if (before?.informed) return set(before);
    }
    return set(plain);
  });

  // Tonight's re-plan found the trip's lines not running: its timetable arrival means nothing.
  if (trip.notOffered) known = false;
  const eta = known ? fromMin(toMin(p.endLocal) + shift) : null;
  const lateMin = eta && trip.arriveBy ? toMin(eta) - toMin(trip.arriveBy) : null;
  if (lateMin > 0) {
    // One key whatever the cause, so "late" never turns into a false "来得及了" when the cause
    // changes; a lateness the user accepted in setup is only info — unless tonight's re-plan made it.
    const newlyLate = trip.source === 'replanned' && trip.savedEnd && toMin(trip.savedEnd) <= toMin(trip.arriveBy);
    if (shift > 0 || newlyLate) {
      flags.push({
        level: 'yellow',
        key: 'late',
        sig: Math.floor(lateMin / 10),
        text: shift > 0 ? `预计 ${eta} 到，比要求的 ${trip.arriveBy} 晚 ${lateMin} 分钟` : `班次变了：按新时刻表 ${eta} 才到，晚于要求的 ${trip.arriveBy}`,
      });
    } else {
      flags.push({ level: 'info', key: 'plan-late', text: `按计划 ${eta} 到，晚于你要求的 ${trip.arriveBy}` });
    }
  }
  if (trip.notOffered) {
    flags.push({
      level: 'yellow',
      key: 'plan:not-offered',
      text: `重新查班次时，没找到你的路线（${p.summary}）${trip.time} 出发的班次：可能是节假日或改了班表`,
    });
  }
  return {
    plannedStart: p.startLocal,
    plannedArrival: p.endLocal,
    arriveBy: trip.arriveBy ?? null,
    eta,
    shiftMin: known ? shift : null,
    lateMin,
    basis,
    legs: states,
    flags,
    legFlags,
  };
}

const missedFlag = (leg, ready, next) => ({
  level: 'yellow',
  key: 'ferry:missed',
  sig: next,
  text: `预计 ${fromMin(ready)} 才到${leg.from?.name ?? '码头'}，赶不上 ${leg.depLocal} 的船，下一班 ${next}`,
});

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

/** Commute date a check is about: the night check looks at tomorrow (or today, after midnight). */
export function targetDateFor(mode, now) {
  const today = pacificDate(now);
  return mode === 'night' && pacificHHMM(now) >= NIGHT_AFTER_MIDNIGHT_UNTIL ? addDays(today, 1) : today;
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
 * itinerary (plus alternatives) to judge; gathered: output of gather(); prev: the Worker
 * watch's previous timing.legs, so a leg the user is already on keeps its estimate.
 */
export function analyze({ mode, now = new Date(), date, dir, route, trip, pause, gathered, prev = null }) {
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
      const window = [dep - 30 * 60, arr + 30 * 60];
      const tripKeys = [idKey(leg.tripId)].filter(Boolean);
      let alerts = matchAlerts(data.alerts[leg.agencyId], leg, window, tripKeys);
      let realtime = null;
      // A no-service alert for the line or stop (not one departure) means no later boat either.
      const suspended = alerts.some((a) => a.severity === 'red' && a.relevance !== 'trip');
      if (isToday && leg.mode === 'FERRY' && rt.ferry) realtime = ferryRealtime(leg, dep, data, { date, suspended });
      else if (isToday && leg.mode !== 'FERRY' && rt.line) realtime = lineRealtime(leg, dep, nowSec, data, mode);
      // 511 may know the user's run by another id than the saved plan: match trip-level alerts on it too.
      if (realtime?.tripRef && !tripKeys.includes(idKey(realtime.tripRef))) {
        alerts = matchAlerts(data.alerts[leg.agencyId], leg, window, [...tripKeys, idKey(realtime.tripRef)]);
      }
      const flags = alerts
        .filter((a) => a.severity !== 'info')
        .map((a) => ({ level: a.severity, key: `alert:${a.id}`, relevance: a.relevance, text: `${a.header || a.effect}`, url: a.url }));
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
  // The night check's main boat risk is wind and fog: not knowing must not read as fine.
  if (weatherErrors.length) {
    weather.flags.push({ level: mode === 'night' ? 'yellow' : 'info', key: 'weather:source', text: '天气数据拿不到（NWS 出错），无法确认风浪和大雾' });
  }
  const { legFlags, ...timing } = estimateArrival(trip, legs, { nowMin: isToday ? toMin(pacificHHMM(now)) : null, prev });
  for (const [i, extra] of Object.entries(legFlags)) {
    const leg = legs[i];
    for (const f of extra) leg.flags = [...leg.flags.filter((x) => x.key !== f.key), f];
    leg.level = levelOf(leg.flags);
  }

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
      replanFailed: trip.replanFailed ?? false,
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
