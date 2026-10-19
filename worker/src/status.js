// What the app's home screen shows: today's and the next commute day's trips with live watch
// state, the checkpoint timeline, the latest verdicts and today's pushed messages.

import { openIssues } from '../../checker/lib/issues.mjs';
import {
  DEFAULT_NOTIFY,
  DIRS,
  DIR_LABEL,
  GRACE_MINUTES,
  POLL_MINUTES,
  checkpointsFor,
  dayTimes,
  tripFor,
  watchWindow,
} from '../../shared/schedule.mjs';
import { addDays, pacificDate, pacificHHMM, weekdayOf } from '../../shared/time.mjs';
import { routineConfigured } from './routine.js';

const MIN = 60000;

/** The next commute day after today that isn't paused. */
function nextCommuteDate(route, pause, today) {
  for (let i = 1; i <= 7; i++) {
    const d = addDays(today, i);
    if (dayTimes(route, d) && !pause.dates.includes(d)) return d;
  }
  return null;
}

const slimLeg = (l) => ({
  mode: l.mode,
  route: l.routeShortName ?? null,
  agency: l.agencyName ?? null,
  from: l.from?.name,
  to: l.to?.name,
  depLocal: l.depLocal,
  arrLocal: l.arrLocal,
});

function checkpointStatus(cp, record, fire, paused, now, savedAt) {
  if (record) return record.level === 'skip' ? 'skipped' : record.auto ? 'auto' : 'done';
  if (paused) return 'paused';
  if (fire) return fire.ok ? 'running' : 'failed';
  if (savedAt && cp.at < new Date(savedAt)) return 'before-setup'; // due before the route existed
  return now - cp.at > (GRACE_MINUTES + 10) * MIN ? 'missing' : 'pending';
}

async function dayView(store, route, pause, date, now) {
  const paused = pause.dates.includes(date);
  const isToday = date === pacificDate(now);
  const [checks, fires] = await Promise.all([store.checks(date), store.fires(date)]);
  const trips = {};
  const dirs = {};
  for (const dir of DIRS) {
    const trip = tripFor(route, date, dir, await store.plan(date, dir));
    trips[dir] = trip;
    if (!trip) continue;
    const win = watchWindow(route, date, dir, trip);
    const w = isToday ? await store.watch(date, dir) : null;
    const stale = w ? now - new Date(w.lastPollAt) > (POLL_MINUTES * 2 + 1) * MIN : false;
    dirs[dir] = {
      dir,
      label: DIR_LABEL[dir],
      leaveAt: trip.time,
      arriveBy: trip.arriveBy,
      planSource: trip.source,
      plan: {
        summary: trip.primary.summary,
        startLocal: trip.primary.startLocal,
        endLocal: trip.primary.endLocal,
        legs: trip.primary.legs.filter((l) => l.transit).map(slimLeg),
      },
      window: {
        start: pacificHHMM(win.start),
        end: pacificHHMM(win.end),
        startsAt: win.start.toISOString(),
        endsAt: win.end.toISOString(),
        active: isToday && !paused && now >= win.start && now <= win.end,
      },
      watch: w && {
        lastPollAt: w.lastPollAt,
        lastEventAt: w.lastEventAt ?? null,
        stale,
        level: w.level,
        // Problems on a trip that is over don't count any more (badge, focus card).
        issues: now > win.end || paused ? [] : openIssues(w.issues).map((i) => ({ level: i.level, leg: i.legLabel, text: i.text, since: i.firstSeen })),
        legs: w.legs,
        timing: w.timing,
        errors: w.errors,
      },
    };
  }
  const checkpoints = checkpointsFor(route, date, trips).map((cp) => {
    const record = checks.find((r) => r.mode === cp.mode) ?? null;
    return {
      mode: cp.mode,
      dir: cp.dir,
      label: cp.label,
      question: cp.question,
      runDate: cp.runDate,
      time: cp.time,
      status: checkpointStatus(cp, record, fires.checks[cp.mode], paused, now, route.savedAt),
      record,
    };
  });
  const latest = checks.filter((r) => r.level !== 'skip').sort((a, b) => b.checkedAt.localeCompare(a.checkedAt))[0] ?? null;
  return { date, weekday: weekdayOf(date), times: dayTimes(route, date), paused, dirs, checkpoints, latest };
}

/** The trip the home screen leads with: the one in progress or next up (never one that is over). */
function focusOf(days, now) {
  for (const day of days) {
    for (const dir of DIRS) {
      const d = day.dirs[dir];
      if (d && !day.paused && now <= new Date(d.window.endsAt)) return { date: day.date, dir };
    }
  }
  return null;
}

export async function statusPayload(store, env, now) {
  const [route, pause, subs] = await Promise.all([store.route(), store.pause(), store.subs()]);
  const today = pacificDate(now);
  const days = [];
  if (route?.schedule) {
    const dates = [...new Set([dayTimes(route, today) ? today : null, nextCommuteDate(route, pause, today)])].filter(Boolean);
    for (const date of dates) days.push(await dayView(store, route, pause, date, now));
  }
  return {
    now: { date: today, time: pacificHHMM(now), iso: now.toISOString() },
    route: route?.schedule
      ? {
          home: route.home?.label,
          work: route.work?.label,
          hasEvening: Boolean(route.evening),
          schedule: route.schedule,
          notify: { ...DEFAULT_NOTIFY, ...route.notify },
        }
      : null,
    focus: focusOf(days, now),
    days,
    events: (await store.events(today)).slice(-40).reverse(),
    pause,
    push: {
      subscriptions: subs.length,
      // The app compares its own subscription with these to re-subscribe after a key change.
      endpoints: subs.map((x) => x.endpoint),
      failing: subs.filter((x) => x.fails).map((x) => ({ endpoint: x.endpoint, fails: x.fails, error: x.lastError })),
      publicKey: env.VAPID_PUBLIC_KEY ?? null,
    },
    configured: {
      push: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_JWK),
      routine: routineConfigured(env),
      data511: Boolean(env.API_511_KEY),
    },
  };
}
