import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { collect } from '../collect.mjs';
import { buildRecord } from '../publish.mjs';
import { decodeFeed } from '../lib/gtfsrt.mjs';
import { normalizeAlerts } from '../lib/normalize.mjs';
import { createFixtureSource } from '../lib/fixtures.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

// Commute day in the fixtures: Wed 2026-10-14 (PDT). Ferry SEA 07:00 from Seaplane Lagoon, Muni N 07:37.
const AT = {
  night: new Date('2026-10-14T04:30:00Z'), // Tue 21:30
  wake: new Date('2026-10-14T12:37:00Z'),
  leave: new Date('2026-10-14T13:17:00Z'),
  enroute: new Date('2026-10-14T13:57:00Z'),
};

const run = (scenario, mode, now = AT[mode]) =>
  collect({ mode, now, source: createFixtureSource(join(fixtures, scenario)) });

const ferryLeg = (d) => d.legs.find((l) => l.mode === 'FERRY');
const muniLeg = (d) => d.legs.find((l) => l.mode === 'TRAM');

test('normal morning is green and tracks the ferry trip', async () => {
  const d = await run('normal', 'leave');
  assert.equal(d.suggestedLevel, 'green', d.reasons.join('\n'));
  assert.equal(d.targetDate, '2026-10-14');
  assert.equal(ferryLeg(d).realtime.status, 'tracked');
  assert.equal(ferryLeg(d).realtime.delayMin, 1);
  assert.equal(ferryLeg(d).realtime.tripRef, 't_6144183_b_86948_tn_0');
  assert.equal(muniLeg(d).realtime.status, 'running-now');
  // Unrelated alerts (J Church detour, an elevator, a weekend OA change) are not attached to the legs.
  assert.deepEqual(muniLeg(d).alerts, []);
  assert.deepEqual(ferryLeg(d).alerts, []);
});

test('cancelled ferry trip is red', async () => {
  const d = await run('ferry-canceled', 'leave');
  assert.equal(d.suggestedLevel, 'red');
  assert.equal(ferryLeg(d).realtime.status, 'canceled');
  assert.match(d.reasons[0], /07:00 那班 SEA 船已取消/);
});

test('cancelled ferry is found by trip start time when the timetable call fails', async () => {
  const d = await run('ferry-canceled-no-timetable', 'leave');
  assert.equal(d.suggestedLevel, 'red');
  assert.equal(ferryLeg(d).realtime.status, 'canceled');
  assert.ok(d.errors.some((e) => e.source === '511 stop timetable SB:7207'));
});

test('Muni N suspended while on the ferry is red, with plan B candidates', async () => {
  const d = await run('muni-down', 'enroute');
  assert.equal(d.suggestedLevel, 'red');
  const muni = muniLeg(d);
  assert.equal(muni.level, 'red');
  assert.equal(muni.alerts[0].relevance, 'route');
  assert.equal(muni.alerts[0].effect, 'NO_SERVICE');
  assert.ok(muni.alerts[0].alarmWords.some((w) => /shuttle bus/i.test(w)));
  assert.equal(muni.realtime.status, 'no-predictions');
  assert.ok(d.alternatives.length >= 1);
  // Every alternative in this route also ends on the N, so none is marked clean.
  assert.ok(d.alternatives.every((a) => a.level === 'red'));
});

test('normal en-route check sees N predictions near the planned time', async () => {
  const d = await run('enroute-normal', 'enroute');
  assert.equal(d.suggestedLevel, 'green', d.reasons.join('\n'));
  assert.equal(muniLeg(d).realtime.status, 'running');
  assert.equal(muniLeg(d).realtime.upcoming[0].expected, '07:33');
});

test('night check targets tomorrow and flags planned cancellations and a gale warning', async () => {
  const d = await run('night-planned', 'night');
  assert.equal(d.targetDate, '2026-10-14');
  assert.equal(d.suggestedLevel, 'yellow');
  const ferry = ferryLeg(d);
  assert.equal(ferry.realtime, null, 'no realtime lookups the night before');
  assert.equal(ferry.alerts[0].relevance, 'route');
  assert.ok(ferry.alerts[0].alarmWords.length > 0);
  assert.ok(d.reasons.some((r) => /Gale Warning/.test(r)));
  assert.ok(d.reasons.some((r) => /45 kt/.test(r)), "gusts count toward the max wind");
});

test('weekend and paused days are skipped without fetching data', async () => {
  const weekend = await run('normal', 'night', new Date('2026-10-17T04:30:00Z')); // Fri night → Sat
  assert.equal(weekend.suggestedLevel, 'skip');
  assert.equal(weekend.skip.reason, 'not-workday');
  const paused = await run('paused', 'wake');
  assert.equal(paused.skip.reason, 'paused');
});

test('missing route asks the user to set one up', async () => {
  const d = await run('no-route', 'leave');
  assert.equal(d.suggestedLevel, 'yellow');
  assert.match(d.reasons[0], /还没有设置通勤路线/);
});

test('a failing data source makes the affected leg yellow instead of silently green', async () => {
  const d = await run('source-error', 'leave');
  assert.equal(d.suggestedLevel, 'yellow');
  assert.equal(muniLeg(d).level, 'yellow');
  assert.equal(ferryLeg(d).level, 'info');
  assert.ok(d.errors[0].message.includes('api_key=***'), 'api key is redacted');
});

test('real GTFS-RT protobuf decodes into the normalized alert shape', () => {
  const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
  const bytes = FeedMessage.encode(
    FeedMessage.fromObject({
      header: { gtfsRealtimeVersion: '2.0', timestamp: 1792000000 },
      entity: [
        {
          id: 'a1',
          alert: {
            activePeriod: [{ start: 1792000000 }],
            informedEntity: [{ agencyId: 'SF', routeId: 'N' }],
            effect: 'NO_SERVICE',
            headerText: { translation: [{ text: 'N Judah suspended', language: 'en' }] },
          },
        },
      ],
    }),
  ).finish();
  const [a] = normalizeAlerts(decodeFeed(bytes), 'SF');
  assert.equal(a.effect, 'NO_SERVICE');
  assert.equal(a.header, 'N Judah suspended');
  assert.deepEqual(a.informed[0], { agencyId: 'SF', routeId: 'N', stopId: null, tripId: null });
  assert.deepEqual(a.activePeriods, [{ start: 1792000000, end: null }]);
});

test('publish record validates the verdict', async () => {
  const d = await run('muni-down', 'enroute');
  const rec = buildRecord(d, { level: 'red', headline: 'N 停运，换 BART', legs: [{ name: 'Muni N', level: 'red', note: '停运' }] });
  assert.equal(rec.mode, 'enroute');
  assert.equal(rec.targetDate, '2026-10-14');
  assert.equal(rec.suggestedLevel, 'red');
  assert.throws(() => buildRecord(d, { level: 'purple', headline: 'x' }));
  assert.throws(() => buildRecord(d, { level: 'green', headline: ' ' }));
});

test('evening off-work check judges the trip home and estimates the arrival', async () => {
  const d = await collect({
    mode: 'offwork',
    now: new Date('2026-10-14T17:05:00-07:00'),
    source: createFixtureSource(join(fixtures, 'evening-ferry-canceled')),
  });
  assert.equal(d.dir, 'evening');
  assert.equal(d.suggestedLevel, 'red');
  assert.equal(d.route.leaveAt, '17:30');
  assert.equal(muniLeg(d).realtime.status, 'running');
  assert.equal(ferryLeg(d).realtime.status, 'canceled');
  assert.equal(ferryLeg(d).realtime.nextDep, '18:45');
  assert.equal(d.timing.eta, '19:15');
  assert.deepEqual(d.timing.basis, ['N 预计 17:41 开', '改坐 18:45 的船']);
});

test('a delay that pushes the arrival past the must-arrive time is flagged', async () => {
  const late = createFixtureSource(join(fixtures, 'ferry-canceled'));
  const d = await collect({
    mode: 'leave',
    now: AT.leave,
    source: { ...late, route: async () => ({ ...(await late.route()), schedule: { nightCheck: '21:30', days: { 3: { leaveHome: '06:30', arriveBy: '08:15' } } } }) },
  });
  assert.equal(d.timing.eta, '08:24');
  assert.equal(d.timing.lateMin, 9);
  assert.ok(d.reasons.some((r) => /预计 08:24 到，比要求的 08:15 晚 9 分钟/.test(r)), d.reasons.join('\n'));
});

test('no arrival estimate while a leg is suspended', async () => {
  const d = await run('muni-down', 'enroute');
  assert.equal(d.timing.eta, null);
  assert.equal(d.timing.lateMin, null);
});
