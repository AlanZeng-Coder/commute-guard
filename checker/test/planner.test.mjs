// Route planning (shared/transitous.mjs) against a scripted Transitous, and how a re-planned day
// feeds the analysis.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { planDay, planOptions } from '../../shared/transitous.mjs';
import { tripFor } from '../../shared/schedule.mjs';
import { collect } from '../collect.mjs';
import { createFixtureSource } from '../lib/fixtures.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const routeOf = (s) => JSON.parse(readFileSync(join(fixtures, s, 'route.json'), 'utf8'));

const iso = (day, hhmm) => new Date(`2026-10-${day}T${hhmm}:00-07:00`).toISOString();
/** A MOTIS itinerary: one transit leg per [mode, route, dep, arr] (day 20 unless given). */
function itin(legs, day = '20') {
  const [startTime, endTime] = [iso(day, legs[0][2]), iso(day, legs.at(-1)[3])];
  return {
    duration: (Date.parse(endTime) - Date.parse(startTime)) / 1000,
    startTime,
    endTime,
    legs: legs.map(([mode, route, dep, arr]) => ({
      mode,
      scheduledStartTime: iso(day, dep),
      scheduledEndTime: iso(day, arr),
      from: { name: 'A' },
      to: { name: 'B' },
      agencyId: 'X',
      routeId: route,
      routeShortName: route,
    })),
  };
}
const planner = (respond) => async (url) => respond(new URL(url));
const home = { lat: 37.77, lon: -122.29 };
const work = { lat: 37.76, lon: -122.45 };

test('next-morning itineraries are not evening options', async () => {
  const fetchJSON = planner(() => ({
    itineraries: [itin([['BUS', '19', '05:09', '06:12']], '21'), itin([['SUBWAY', 'Yellow', '21:30', '22:40']])],
  }));
  const options = await planOptions({ from: work, to: home, date: '2026-10-20', departTime: '21:30', fetchJSON });
  assert.deepEqual(
    options.map((o) => o.startLocal),
    ['21:30'],
  );
});

test('a planner failure is an error, not "your lines don\'t run at this time"', async () => {
  const terminal = { id: 'stop-7207', name: 'Seaplane' };
  const fetchJSON = planner((u) => {
    if (u.searchParams.get('toPlace') === 'stop-7207' || u.searchParams.get('fromPlace') === 'stop-7207') throw new Error('HTTP 429');
    return { itineraries: [itin([['BUS', 'AC:96', '06:49', '07:20'], ['SUBWAY', 'BA:Yellow', '07:25', '07:59']])] };
  });
  await assert.rejects(
    planDay({ from: home, to: work, date: '2026-10-20', time: '06:30', terminals: [terminal], pattern: 'SB:SEA>N', fetchJSON }),
    /Transitous 查询失败/,
  );
});

test('re-planning keeps the boat the user chose, not the earliest on the same lines', async () => {
  const fetchJSON = planner(() => ({
    itineraries: [
      itin([['FERRY', 'SB:SEA', '07:00', '07:20'], ['TRAM', 'N', '07:37', '07:55']]),
      itin([['FERRY', 'SB:SEA', '07:25', '07:45'], ['TRAM', 'N', '08:01', '08:20']]),
    ],
  }));
  const r = await planDay({ from: home, to: work, date: '2026-10-20', time: '06:30', pattern: 'SB:SEA>N', board: '07:25', fetchJSON });
  assert.equal(r.primary.legs[0].depLocal, '07:25');
});

test('when tonight\'s re-plan finds the user\'s lines aren\'t running, the check says so', async () => {
  const route = routeOf('normal');
  const replanned = { primary: null, notOffered: true, time: '06:30', pattern: route.morning.pattern };
  assert.equal(tripFor(route, '2026-10-14', 'morning', replanned).notOffered, true);
  const source = { ...createFixtureSource(join(fixtures, 'normal')), plan: async () => replanned };
  const d = await collect({ mode: 'night', now: new Date('2026-10-14T04:30:00Z'), source });
  assert.equal(d.suggestedLevel, 'yellow');
  assert.ok(d.reasons.some((r) => /没找到你的路线/.test(r)), d.reasons.join('\n'));
});

test('a re-plan that makes the user late is flagged, not just shown as a time', async () => {
  const route = routeOf('normal');
  const saved = route.morning.byTime['06:30'];
  const shift = (hhmm) => `${String(Number(hhmm.slice(0, 2)) + 1).padStart(2, '0')}${hhmm.slice(2)}`;
  const later = {
    ...saved.primary,
    startLocal: shift(saved.primary.startLocal),
    endLocal: shift(saved.primary.endLocal),
    legs: saved.primary.legs.map((l) => ({ ...l, depLocal: shift(l.depLocal), arrLocal: shift(l.arrLocal) })),
  };
  const replanned = { primary: later, alternatives: [], time: '06:30', pattern: route.morning.pattern };
  const source = { ...createFixtureSource(join(fixtures, 'normal')), plan: async () => replanned };
  const d = await collect({ mode: 'night', now: new Date('2026-10-14T04:30:00Z'), source });
  assert.equal(d.suggestedLevel, 'yellow');
  assert.ok(d.reasons.some((r) => /班次变了/.test(r)), d.reasons.join('\n'));
});

test('the night check is not green when the weather can\'t be read', async () => {
  const failing = { ...createFixtureSource(join(fixtures, 'normal')) };
  for (const k of ['nwsAlerts', 'nwsMarine', 'nwsHourly']) failing[k] = async () => Promise.reject(new Error('HTTP 503'));
  const d = await collect({ mode: 'night', now: new Date('2026-10-14T04:30:00Z'), source: failing });
  assert.equal(d.suggestedLevel, 'yellow');
  assert.ok(d.reasons.some((r) => /天气数据拿不到/.test(r)));
});
