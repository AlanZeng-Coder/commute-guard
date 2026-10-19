// One check end to end: load the route and that day's trip, fetch what the mode needs, analyze.
// Shared by the laptop/test runner (collect.mjs) and the Worker (watch + /api/digest).

import { tripFor } from '../../shared/schedule.mjs';
import { pacificDate } from '../../shared/time.mjs';
import { analyze, skipReason } from './analyze.mjs';
import { emptyGathered, gather } from './gather.mjs';

/**
 * source: route() / pause() / plan(date, dir) plus the data calls of source.mjs.
 * prev: the watch's previous timing.legs (see estimateArrival).
 * Returns the digest and the raw gathered data (the Worker keeps it to reuse for a few minutes).
 */
export async function buildDigest({ mode, date, dir, now = new Date(), source, gatherOptions, prev = null }) {
  const route = await source.route();
  const pause = await source.pause().catch(() => ({ dates: [] }));
  const replanned = route ? await source.plan(date, dir).catch(() => null) : null;
  const trip = tripFor(route, date, dir, replanned);
  const needData = trip && !skipReason({ date, dir, route, pause });
  // Live positions only mean something for today's trip.
  const options = { ...(gatherOptions ?? source.gatherOptions), realtime: date === pacificDate(now) };
  const gathered = needData ? await gather(source, trip, mode, options) : emptyGathered();
  return { digest: analyze({ mode, now, date, dir, route, trip, pause, gathered, prev }), gathered, route, trip };
}
