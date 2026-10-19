// The user's commute schedule (per-weekday times entered in the app) and everything derived
// from it: which checks run when, which hours the Worker watches 511, and which saved trip
// applies to a given day. Used by the Worker, the checker and the browser.
//
// route.schedule = { nightCheck: '21:30', days: { 1: { leaveHome, arriveBy, leaveWork }, … } }
// route.morning / route.evening = { pattern, byTime: { 'HH:MM': { primary, alternatives } } }
//   pattern: the lines the user picked ("SB:SEA>N"); byTime: that pattern planned for each
//   departure time used in the schedule.

import { addDays, pacificToDate, weekdayOf } from './time.mjs';

export const DIRS = ['morning', 'evening'];
export const DIR_LABEL = { morning: '去公司', evening: '回家' };

export const CHECKS = [
  { mode: 'night', dir: 'morning', label: '睡前检查', question: '明天要不要定早闹钟？' },
  { mode: 'wake', dir: 'morning', label: '起床检查', question: '要不要起来准备？' },
  { mode: 'leave', dir: 'morning', label: '出门检查', question: '要不要出门？' },
  { mode: 'enroute', dir: 'morning', label: '船上检查', question: '到 SF 后 Muni 能不能坐？' },
  { mode: 'offwork', dir: 'evening', label: '下班检查', question: '回家的路通不通？' },
];

// Not on the timeline: the Worker fires it when its 10-minute watch finds a new problem.
export const ALERT_CHECK = { mode: 'alert', dir: null, label: '突发分析', question: '刚出的问题影响多大？该怎么走？' };

export const MODES = [...CHECKS.map((c) => c.mode), ALERT_CHECK.mode];

export const checkByMode = (mode) => CHECKS.find((c) => c.mode === mode) ?? (mode === 'alert' ? ALERT_CHECK : undefined);

/** Minutes relative to the user's times. */
export const OFFSETS = {
  wake: -50, // before leaving home
  leave: -15,
  enroute: 10, // after boarding the first boat (or first transit leg)
  offwork: -30, // before leaving work
  eveningWatch: -60, // evening watch starts this long before leaving work
  watchAfterArrival: 15,
};

/** Minutes between two 511 polls while a commute is being watched. */
export const POLL_MINUTES = 10;

/** Minutes after the Claude routine was fired before the Worker sends its own result instead. */
export const GRACE_MINUTES = 15;

export const DEFAULT_SCHEDULE = {
  nightCheck: '21:30',
  days: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, { leaveHome: '06:30', arriveBy: '08:30', leaveWork: '17:30' }])),
};

/** Push a green result for these checks too (problems are always pushed). */
export const DEFAULT_NOTIFY = { night: true, wake: false, leave: true, enroute: true, offwork: true };

export const LEVELS = ['green', 'yellow', 'red', 'skip'];

export const LEVEL_LABEL = { green: '🟢 正常', yellow: '🟡 注意', red: '🔴 别去', skip: '⚪ 跳过' };

export const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A night check set before this time runs after midnight, on the commute day itself. */
export const NIGHT_AFTER_MIDNIGHT_UNTIL = '04:00';

export const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

export function fromMin(m) {
  const c = Math.min(Math.max(Math.round(m), 0), 23 * 60 + 59);
  return `${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
}

/** The user's times for a calendar date, or null when it isn't a commute day. */
export function dayTimes(route, date) {
  const t = route?.schedule?.days?.[weekdayOf(date)];
  return t && HHMM.test(t.leaveHome ?? '') ? t : null;
}

/** Departure time the trip for `dir` is planned around. */
export function departureFor(route, date, dir) {
  const t = dayTimes(route, date);
  if (!t) return null;
  if (dir === 'morning') return t.leaveHome;
  return route?.evening && HHMM.test(t.leaveWork ?? '') ? t.leaveWork : null;
}

export const commutesOn = (route, date, dir) => departureFor(route, date, dir) !== null;

/**
 * The trip to watch on `date` in `dir`: the Worker's nightly re-plan if it is for the current
 * time and lines, else the plan saved for that departure time, else the closest saved one.
 */
export function tripFor(route, date, dir, replanned = null) {
  const time = departureFor(route, date, dir);
  const set = route?.[dir];
  if (!time || !set) return null;
  // A re-plan counts only while what it was planned from still holds (time, lines, chosen boat,
  // addresses) — an unrelated save doesn't throw it away.
  const fresh = replanned && replanned.inputs === planInputs(route, dir, time);
  const saved = set.byTime?.[time];
  let plan = fresh && replanned.primary ? replanned : saved;
  let source = fresh && replanned.primary ? 'replanned' : 'saved';
  if (!plan?.primary) {
    const closest = Object.keys(set.byTime ?? {}).sort((a, b) => Math.abs(toMin(a) - toMin(time)) - Math.abs(toMin(b) - toMin(time)))[0];
    plan = set.byTime?.[closest];
    source = 'closest';
  }
  if (!plan?.primary) return null;
  return {
    date,
    dir,
    time,
    arriveBy: dir === 'morning' ? (dayTimes(route, date).arriveBy ?? null) : null,
    primary: plan.primary,
    alternatives: plan.alternatives ?? [],
    source,
    savedEnd: saved?.primary?.endLocal ?? null,
    // Tonight's re-plan gave up after 3 tries: the saved trip is unconfirmed for this date.
    replanFailed: Boolean(replanned && !replanned.primary && !replanned.notOffered && (replanned.attempts ?? 0) >= 3),
    // The re-plan found other options but none on this trip's lines (holiday / timetable change).
    notOffered: Boolean(fresh && replanned.notOffered),
  };
}

/** When the user boards: the first boat if the trip has one, else the first transit leg. */
export function boardingTime(itinerary) {
  const transit = (itinerary?.legs ?? []).filter((l) => l.transit);
  return (transit.find((l) => l.mode === 'FERRY') ?? transit[0])?.depLocal ?? null;
}

/**
 * Checkpoints for one commute day, each with the instant it is due. The night check runs the
 * evening before (`runDate`), or after midnight on the day itself for a late bedtime.
 * `trips` = { morning, evening } from tripFor().
 */
export function checkpointsFor(route, date, trips = {}) {
  const t = dayTimes(route, date);
  if (!t) return [];
  const leave = toMin(t.leaveHome);
  const at = (runDate, time) => ({ runDate, time, at: pacificToDate(runDate, time) });
  const board = boardingTime(trips.morning?.primary);
  const night = route.schedule.nightCheck ?? DEFAULT_SCHEDULE.nightCheck;
  const out = [
    { ...CHECKS[0], ...at(night < NIGHT_AFTER_MIDNIGHT_UNTIL ? date : addDays(date, -1), night) },
    { ...CHECKS[1], ...at(date, fromMin(leave + OFFSETS.wake)) },
    { ...CHECKS[2], ...at(date, fromMin(leave + OFFSETS.leave)) },
    { ...CHECKS[3], ...at(date, fromMin(board ? toMin(board) + OFFSETS.enroute : leave + 30)) },
  ];
  const work = departureFor(route, date, 'evening');
  if (work) out.push({ ...CHECKS[4], ...at(date, fromMin(toMin(work) + OFFSETS.offwork)) });
  return out.map((c) => ({ ...c, date }));
}

/** The span during which the Worker polls 511 for this trip. */
export function watchWindow(route, date, dir, trip) {
  const time = departureFor(route, date, dir);
  if (!time) return null;
  const arrive = trip?.primary?.endLocal;
  if (dir === 'morning') {
    const t = dayTimes(route, date);
    const end = Math.max(toMin(arrive ?? fromMin(toMin(time) + 120)), t.arriveBy ? toMin(t.arriveBy) : 0);
    return {
      start: pacificToDate(date, fromMin(toMin(time) + OFFSETS.wake)),
      end: pacificToDate(date, fromMin(end + OFFSETS.watchAfterArrival)),
    };
  }
  return {
    start: pacificToDate(date, fromMin(toMin(time) + OFFSETS.eveningWatch)),
    end: pacificToDate(date, fromMin(toMin(arrive ?? fromMin(toMin(time) + 120)) + OFFSETS.watchAfterArrival)),
  };
}

/**
 * The boarding time the user chose for `time` — or, for a time with no saved trip yet, the same
 * gap after leaving that their other saved trips have. Re-planning aims for it so a later boat
 * the user deliberately picked isn't swapped for the earliest one on the same lines.
 */
/** Everything a day's re-plan depends on; a stored re-plan is current while this is unchanged. */
export function planInputs(route, dir, time) {
  const set = route?.[dir];
  const at = (p) => (p ? `${p.lat},${p.lon}` : '');
  return [time, set?.pattern, linesOf(set?.byTime?.[time]?.primary), preferredBoarding(set, time), at(route?.home), at(route?.work)].join('|');
}

/** The lines an itinerary uses, in order ("SB:SEA>N"). */
export const linesOf = (itinerary) =>
  (itinerary?.legs ?? [])
    .filter((l) => l.transit)
    .map((l) => l.routeId)
    .join('>');

export function preferredBoarding(set, time) {
  const own = boardingTime(set?.byTime?.[time]?.primary);
  if (own) return own;
  for (const [t, plan] of Object.entries(set?.byTime ?? {})) {
    const b = boardingTime(plan.primary);
    if (b) return fromMin(toMin(time) + toMin(b) - toMin(t));
  }
  return null;
}

/** Commute direction a free-form check (`alert`) is about, by time of day. */
export const dirAt = (hhmm) => (hhmm < '12:00' ? 'morning' : 'evening');
