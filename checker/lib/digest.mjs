// One check end to end: load the route and that day's trip, fetch what the mode needs, analyze.
// Shared by the laptop/test runner (collect.mjs) and the Worker (watch + /api/digest).

import { tripFor } from '../../shared/schedule.mjs';
import { analyze, skipReason } from './analyze.mjs';
import { emptyGathered, gather } from './gather.mjs';

/**
 * source: route() / pause() / plan(date, dir) plus the data calls of source.mjs.
 * Returns the digest and the raw gathered data (the Worker keeps it to reuse for a few minutes).
 */
export async function buildDigest({ mode, date, dir, now = new Date(), source, gatherOptions }) {
  const route = await source.route();
  const pause = await source.pause().catch(() => ({ dates: [] }));
  const replanned = route ? await source.plan(date, dir).catch(() => null) : null;
  const trip = tripFor(route, date, dir, replanned);
  const needData = trip && !skipReason({ date, dir, route, pause });
  const gathered = needData ? await gather(source, trip, mode, gatherOptions) : emptyGathered();
  return { digest: analyze({ mode, now, date, dir, route, trip, pause, gathered }), gathered, route, trip };
}
