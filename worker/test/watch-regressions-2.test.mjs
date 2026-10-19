// Regressions from the second review round: scenarios the first round of fixes got wrong
// (estimates frozen too early, cancelled boats dropping out of the feed, timing issues flipping,
// subscriptions removed during an outage, verdicts racing the watch).

import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../src/index.js';
import { notify } from '../src/notify.js';
import { createStore, memoryKV } from '../src/store.js';
import { generateVapidKeys } from '../src/webpush.js';
import { planDay } from '../../shared/transitous.mjs';
import { planInputs, tripFor } from '../../shared/schedule.mjs';
import { at, harness, routeOf } from './harness.mjs';

const sec = (hhmm, day = '14') => at(hhmm, day).getTime() / 1000;
const boat = (relationship, delayMin = 0, tripId = 't_6144183_b_86948_tn_0', start = '07:00', stop = '7207', day = '14') => ({
  tripId,
  routeId: 'SEA',
  startTime: `${start}:00`,
  startDate: `202610${day}`,
  relationship,
  stops:
    relationship === 'CANCELED'
      ? []
      : [{ stopId: stop, relationship: 'SCHEDULED', depTime: sec(start, day) + delayMin * 60, depDelay: delayMin * 60, arrTime: null, arrDelay: null }],
});
const updates = (...trips) => ({ tripUpdates: async () => trips });
const visit = (line, aimed, expected = aimed) => ({
  line,
  lineName: line,
  direction: 'OB',
  destination: '',
  journeyRef: `${line}-${aimed}`,
  aimed: sec(aimed),
  expected: sec(expected),
});
const muni = (...visits) => ({ stopVisits: async (ag) => (ag === 'SF' ? visits : []) });
const titles = (h) => h.pushed.map((m) => m.title);
const withArriveBy = (t) => {
  const r = routeOf('normal');
  r.schedule.days[3].arriveBy = t;
  return r;
};

test('a cancelled boat dropping out of the feed after its time is not "已恢复"', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('06:50'));
  await h.run(at('07:00'));
  h.use('normal', updates()); // gone from TripUpdates
  await h.run(at('07:10'));
  await h.run(at('07:20'));
  assert.ok(!titles(h).some((t) => /已恢复/.test(t)), titles(h).join('\n'));
  assert.equal((await h.store.watch('2026-10-14', 'morning')).timing.eta, '08:24', 'still on the 07:25 boat');
});

test('a last-minute cancellation moves the estimate instead of keeping the old one', async () => {
  const h = harness(withArriveBy('08:10'));
  await h.ready();
  h.use('normal', updates(boat('SCHEDULED', 0)));
  await h.run(at('06:50'));
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('07:00'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.equal(w.timing.eta, '08:24');
  assert.ok(h.pushed.some((m) => /可能迟到/.test(m.title)), titles(h).join('\n'));
});

test('a delay of the train the user is waiting for is noticed', async () => {
  const h = harness(withArriveBy('08:10'));
  await h.ready();
  h.use('enroute-normal', muni(visit('N', '07:37')));
  await h.run(at('07:20'));
  h.use('enroute-normal', muni(visit('N', '07:37', '07:55')));
  await h.run(at('07:30'));
  assert.ok(h.pushed.some((m) => /可能迟到/.test(m.title)), titles(h).join('\n'));
});

test('a trip-level alert cancelling only the user\'s boat still names the next boat and an arrival time', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const alert = {
    id: 'sb-700',
    agency: 'SB',
    header: '7:00am Seaplane departure cancelled',
    description: '',
    url: '',
    cause: 'TECHNICAL_PROBLEM',
    effect: 'NO_SERVICE',
    activePeriods: [],
    informed: [{ agencyId: 'SB', routeId: 'SEA', stopId: null, tripId: 't_6144183_b_86948_tn_0' }],
  };
  h.use('normal', { ...updates(boat('CANCELED')), alerts: async (ag) => (ag === 'SB' ? [alert] : []) });
  await h.run(at('05:40'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.equal(w.timing.eta, '08:24');
  assert.ok(h.pushed.some((m) => /下一班 07:25/.test(m.body)), h.pushed.map((m) => m.body).join('\n'));
});

test('an alert on the user\'s boat counts even when the saved plan knows it by an older id', async () => {
  const route = routeOf('normal');
  const ferry = route.morning.byTime['06:30'].primary.legs.find((l) => l.mode === 'FERRY');
  ferry.tripId = 'SB:t_5990001_b_80000_tn_0'; // from an older timetable build
  const h = harness(route);
  await h.ready();
  const alert = {
    id: 'sb-700',
    agency: 'SB',
    header: '7:00am Seaplane departure cancelled',
    description: '',
    url: '',
    cause: 'TECHNICAL_PROBLEM',
    effect: 'NO_SERVICE',
    activePeriods: [],
    informed: [{ agencyId: 'SB', routeId: 'SEA', stopId: null, tripId: 't_6144183_b_86948_tn_0' }],
  };
  h.use('normal', { alerts: async (ag) => (ag === 'SB' ? [alert] : []) });
  const did = await h.run(at('05:40'));
  assert.ok(did.includes('new:L0:alert:sb-700'), did.join());
});

test('missing the boat because of a late Muni is held while the user rides the next one', async () => {
  const h = harness(routeOf('evening-ferry-canceled'));
  await h.ready();
  const evening = (n) => ({
    ...updates(boat('SCHEDULED', 0, 't_6144201_b_86948_tn_0', '18:15', '72012')),
    stopVisits: async (ag) => (ag === 'SF' ? [{ ...visit('N', '17:40', n), direction: 'IB' }] : []),
  });
  h.use('evening-ferry-canceled', evening('17:52'));
  const did = await h.run(at('17:00'));
  assert.ok(did.includes('new:L1:ferry:missed'), did.join());
  h.use('evening-ferry-canceled', updates());
  for (const t of ['18:50', '19:00', '19:10']) await h.run(at(t));
  assert.ok(!titles(h).some((t) => /已恢复/.test(t)), titles(h).join('\n'));
});

test('lateness whose cause changes is one problem, not a flip-flop of "已恢复" pushes', async () => {
  const route = withArriveBy('08:10');
  const h = harness(route);
  await h.ready();
  // Tonight's re-plan moved the trip to the 07:25 boat (arrives 08:24).
  const saved = route.morning.byTime['06:30'];
  const plus25 = (hhmm) => {
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + 25;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  const later = {
    ...saved.primary,
    startLocal: plus25(saved.primary.startLocal),
    endLocal: plus25(saved.primary.endLocal),
    legs: saved.primary.legs.map((l) => ({
      ...l,
      depLocal: plus25(l.depLocal),
      arrLocal: plus25(l.arrLocal),
      ...(l.mode === 'FERRY' ? { tripId: 'SB:t_6144186_b_86948_tn_0' } : {}),
    })),
  };
  await h.store.putPlan('2026-10-14', 'morning', { primary: later, alternatives: [], time: '06:30', pattern: route.morning.pattern, inputs: planInputs(route, 'morning', '06:30') });
  h.use('normal', updates(boat('SCHEDULED', 0, 't_6144186_b_86948_tn_0', '07:25')));
  await h.run(at('05:40'));
  h.use('normal', updates(boat('SCHEDULED', 15, 't_6144186_b_86948_tn_0', '07:25')));
  await h.run(at('05:50'));
  h.use('normal', updates(boat('SCHEDULED', 0, 't_6144186_b_86948_tn_0', '07:25')));
  for (const t of ['06:00', '06:10', '06:20']) await h.run(at(t));
  // The boat's own delay clearing is a real recovery; the lateness (still 14 minutes) is not.
  assert.ok(!titles(h).some((t) => /来得及|已恢复：(可能迟到|班次变了)/.test(t)), titles(h).join('\n'));
  assert.ok((await h.store.watch('2026-10-14', 'morning')).issues.late?.notified);
});

test('a push-service outage doesn\'t remove the subscription', async () => {
  const store = createStore(memoryKV());
  const keys = await generateVapidKeys();
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey)).toString('base64url');
  await store.putSubs([{ endpoint: 'https://push.example/1', keys: { p256dh, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }]);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('busy', { status: 503 });
  try {
    const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_JWK: keys.privateJwk };
    for (let i = 0; i < 8; i++) {
      const [r] = await notify(env, store, at('06:00'), [{ kind: 'issue', level: 'red', title: 'x', body: 'y', badge: 1 }], { log: false });
      assert.equal(r.delivered, false);
      assert.equal(r.deliverable, true, 'still worth retrying');
    }
    const subs = await store.subs();
    assert.equal(subs.length, 1);
    assert.equal(subs[0].fails, 8);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('a verdict milder than a problem pushed after its data was taken is held back', async () => {
  // Workers-only API, used by the auth check.
  crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
  const kv = memoryKV();
  const store = createStore(kv);
  await store.put('route', routeOf('normal'));
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
  const old = new Date(Date.now() - 3600000).toISOString();
  await store.putWatch(date, 'morning', {
    issues: { 'L1:alert:sf-n': { key: 'L1:alert:sf-n', leg: 1, level: 'red', notified: 'red', firstSeen: old, notifiedAt: new Date().toISOString(), text: 'N suspended' } },
  });
  const res = await worker.fetch(
    new Request('https://cg.example/api/status', {
      method: 'POST',
      headers: { Authorization: 'Bearer w', 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'leave', dir: 'morning', targetDate: date, level: 'yellow', headline: '可以出门', digestAt: new Date(Date.now() - 60000).toISOString() }),
    }),
    { CG: kv, WRITE_TOKEN: 'w' },
  );
  const body = await res.json();
  assert.equal(body.reason, 'superseded');
});

test('a re-plan counts only while what it was planned from still holds', () => {
  const route = routeOf('normal');
  const plan = { ...route.morning.byTime['06:30'], time: '06:30', pattern: route.morning.pattern, inputs: planInputs(route, 'morning', '06:30') };
  assert.equal(tripFor(route, '2026-10-14', 'morning', plan).source, 'replanned');
  // An unrelated save (notification settings) keeps it.
  assert.equal(tripFor({ ...route, savedAt: '2099-01-01T00:00:00Z', notify: {} }, '2026-10-14', 'morning', plan).source, 'replanned');
  // Choosing another boat for that time doesn't.
  const later = structuredClone(route);
  later.morning.byTime['06:30'].primary.legs.find((l) => l.mode === 'FERRY').depLocal = '07:25';
  assert.equal(tripFor(later, '2026-10-14', 'morning', plan).source, 'saved');
});

test('with some planner requests failed, only the boat asked for is accepted', async () => {
  const iso = (hhmm) => new Date(`2026-10-20T${hhmm}:00-07:00`).toISOString();
  const itin = (dep, arr) => ({
    duration: 3600,
    startTime: iso(dep),
    endTime: iso(arr),
    legs: [
      { mode: 'FERRY', scheduledStartTime: iso(dep), scheduledEndTime: iso(arr), from: { name: 'A' }, to: { name: 'B' }, agencyId: 'SB', routeId: 'SB:SEA', routeShortName: 'SEA' },
    ],
  });
  const fetchJSON = async (url) => {
    if (new URL(url).searchParams.get('toPlace') === 'stop-7207') throw new Error('HTTP 429');
    return { itineraries: [itin('07:00', '07:20')] };
  };
  const args = { from: { lat: 37.77, lon: -122.29 }, to: { lat: 37.76, lon: -122.45 }, date: '2026-10-20', time: '06:30', terminals: [{ id: 'stop-7207' }], pattern: 'SB:SEA', fetchJSON };
  await assert.rejects(planDay({ ...args, board: '07:25' }), /Transitous 查询失败/);
  assert.equal((await planDay({ ...args, board: '07:00' })).primary.legs[0].depLocal, '07:00');
});

test('a boat delay is read from stop monitoring even though its direction codes differ from the timetable', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const sm = { line: 'SEA', lineName: 'SEA', direction: 'OB', destination: '', journeyRef: 'x', aimed: sec('07:00'), expected: sec('07:14') };
  h.use('normal', { ...updates(), stopVisits: async (ag) => (ag === 'SB' ? [sm] : []) });
  const did = await h.run(at('06:30'));
  assert.ok(did.includes('new:L0:ferry:delay'), did.join());
});

test('a cancellation matched only by start time is "possibly cancelled", not red', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', {
    ...updates(boat('CANCELED', 0, 't_other_direction', '07:01')),
    timetable: async () => Promise.reject(new Error('HTTP 502')),
    stopVisits: async () => [], // nothing listed at the stop either, so it can't be ruled out
  });
  await h.run(at('05:40'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.equal(w.issues['L0:ferry:canceled']?.level, 'yellow');
});

test('a Muni gap near departure doesn\'t "clear" just because time passes', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('enroute-normal', muni(visit('J', '07:31'), visit('N', '08:25')));
  for (const t of ['07:05', '07:15', '07:25', '07:35']) await h.run(at(t));
  assert.ok(!titles(h).some((t) => /已恢复/.test(t)), titles(h).join('\n'));
});

test('a result whose push failed is sent again by the cron', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const checkedAt = at('06:15').toISOString();
  await h.store.putChecks('2026-10-14', [{ mode: 'leave', dir: 'morning', targetDate: '2026-10-14', level: 'red', headline: '07:00 船取消', checkedAt }]);
  await h.store.putPushStates('2026-10-14', { leave: { delivered: false, deliverable: true, attempts: 1, at: checkedAt, checkedAt } });
  const did = await h.run(at('06:22'));
  assert.ok(did.includes('resend:2026-10-14:leave:ok'), did.join());
  assert.equal((await h.store.pushStates('2026-10-14')).leave.delivered, true);
});

test('a failed result is not re-sent once something newer has gone out', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const checkedAt = at('06:15').toISOString();
  await h.store.putChecks('2026-10-14', [{ mode: 'leave', dir: 'morning', targetDate: '2026-10-14', level: 'green', headline: '可以出门', checkedAt }]);
  await h.store.putPushStates('2026-10-14', { leave: { delivered: false, deliverable: true, attempts: 1, at: checkedAt, checkedAt } });
  await h.store.putWatch('2026-10-14', 'morning', { lastEventAt: at('06:20').toISOString(), lastPollAt: at('06:20').toISOString(), issues: {} });
  const did = await h.run(at('06:22'));
  assert.ok(!did.some((d) => d.startsWith('resend:')), did.join());
  assert.ok((await h.store.pushStates('2026-10-14')).leave.stopped);
});

// ---------- third round ----------

test('a suspension on the boat the user switched to is still pushed after the original time', async () => {
  const h = harness(withArriveBy('08:10'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('06:50'));
  const suspended = {
    id: 'sb-suspend',
    agency: 'SB',
    header: 'Seaplane service suspended',
    description: '',
    url: '',
    cause: 'TECHNICAL_PROBLEM',
    effect: 'NO_SERVICE',
    activePeriods: [],
    informed: [{ agencyId: 'SB', routeId: 'SEA', stopId: null, tripId: null }],
  };
  h.use('normal', { ...updates(boat('CANCELED')), alerts: async (ag) => (ag === 'SB' ? [suspended] : []) });
  const did = await h.run(at('07:20'));
  assert.ok(did.includes('new:L0:alert:sb-suspend'), did.join());
});

test('a Muni run remembered earlier doesn\'t hide a later ferry cancellation', async () => {
  const h = harness(withArriveBy('08:10'));
  await h.ready();
  const every8 = (from) => muni(...[0, 8, 16, 24, 32, 40, 48].map((m) => {
    const t = Number(from.slice(0, 2)) * 60 + Number(from.slice(3)) + m;
    return visit('N', `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }));
  h.use('normal', { ...updates(boat('SCHEDULED', 0)), ...every8('07:29') });
  await h.run(at('06:40'));
  h.use('normal', { ...updates(boat('CANCELED')), ...every8('07:29') });
  await h.run(at('07:00'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.ok(w.timing.eta > '08:10', `eta ${w.timing.eta}`);
  assert.ok(h.pushed.some((m) => /可能迟到/.test(m.title)), titles(h).join('\n'));
});

test('a withdrawn cancellation moves the estimate back to the original boat', async () => {
  const h = harness(withArriveBy('08:10'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('06:00'));
  h.use('normal', updates(boat('SCHEDULED', 0)));
  await h.run(at('06:10'));
  assert.equal((await h.store.watch('2026-10-14', 'morning')).timing.eta, '07:59');
});

test('when no boat is left, the estimate stays unknown after the cancelled trip leaves the feed', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED'), boat('CANCELED', 0, 't_6144186_b_86948_tn_0', '07:25')));
  await h.run(at('06:50'));
  h.use('normal', { ...updates(boat('CANCELED', 0, 't_6144186_b_86948_tn_0', '07:25')), stopVisits: async () => [] });
  await h.run(at('07:10'));
  assert.equal((await h.store.watch('2026-10-14', 'morning')).timing.eta, null);
});

test('remembered leg state is not applied to a different trip', async () => {
  const route = withArriveBy('08:30');
  const h = harness(route);
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('05:40'));
  // The user saves the 07:25 boat as their trip.
  const next = structuredClone(route);
  const p = next.morning.byTime['06:30'].primary;
  const plus = (hhmm) => {
    const m = Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3)) + 25;
    return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  };
  p.legs = p.legs.map((l) => ({ ...l, depLocal: plus(l.depLocal), arrLocal: plus(l.arrLocal), ...(l.mode === 'FERRY' ? { tripId: 'SB:t_6144186_b_86948_tn_0' } : {}) }));
  p.startLocal = plus(p.startLocal);
  p.endLocal = plus(p.endLocal);
  await h.store.put('route', next);
  h.use('normal', updates(boat('CANCELED'), boat('SCHEDULED', 0, 't_6144186_b_86948_tn_0', '07:25')));
  await h.run(at('06:00'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.equal(w.timing.eta, '08:24');
  assert.ok(!h.pushed.some((m) => /可能迟到/.test(m.title)), titles(h).join('\n'));
});

test('a late arrival at the Muni stop is not a "gap" once the planned run is long past', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('enroute-normal', { ...updates(boat('SCHEDULED', 45)), ...muni(visit('N', '08:36'), visit('N', '08:44')) });
  for (const t of ['08:20', '08:30']) await h.run(at(t));
  assert.ok(!h.pushed.some((m) => /附近没有/.test(m.body)), h.pushed.map((m) => m.body).join('\n'));
});

test('a retried push for an already-analysed problem doesn\'t wake Claude again', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  await h.store.putChecks('2026-10-14', [{ mode: 'wake', level: 'green', headline: 'ok', checkedAt: at('05:39').toISOString() }]);
  h.use('normal', updates(boat('CANCELED')));
  h.pushesFail(true);
  await h.run(at('05:50'));
  await h.run(at('06:00'));
  h.pushesFail(false);
  await h.run(at('06:10'));
  assert.equal(h.fired.filter((f) => f.mode === 'alert').length, 1);
});

test('pause and resume change one date against the stored list', async () => {
  crypto.subtle.timingSafeEqual ??= (a, b) => Buffer.from(a).equals(Buffer.from(b));
  const kv = memoryKV();
  const env = { CG: kv, APP_PASSCODE: 'p' };
  const put = (body) =>
    worker
      .fetch(new Request('https://cg.example/api/pause', { method: 'PUT', headers: { Authorization: 'Bearer p', 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), env)
      .then((r) => r.json());
  await put({ add: '2099-01-02' });
  await put({ add: '2099-01-03' });
  assert.deepEqual((await put({ remove: '2099-01-02' })).dates, ['2099-01-03']);
});
