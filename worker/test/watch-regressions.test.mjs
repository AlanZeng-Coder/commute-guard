// Regressions for defects found in the v2 review: each test is a scenario where the watch used
// to stay silent, push something false, or lose a push.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replanFrom } from '../src/monitor.js';
import { notify } from '../src/notify.js';
import { saveRecord } from '../src/records.js';
import { createStore, memoryKV } from '../src/store.js';
import { generateVapidKeys } from '../src/webpush.js';
import { checkpointsFor } from '../../shared/schedule.mjs';
import { at, harness, routeOf } from './harness.mjs';

const sec = (hhmm) => at(hhmm).getTime() / 1000;

/** The 07:00 SEA boat's trip update: on time + delay, or cancelled. */
const boat = (relationship, delayMin = 0, tripId = 't_6144183_b_86948_tn_0', start = '07:00') => ({
  tripId,
  routeId: 'SEA',
  startTime: `${start}:00`,
  startDate: '20261014',
  relationship,
  stops:
    relationship === 'CANCELED'
      ? []
      : [{ stopId: '7207', relationship: 'SCHEDULED', depTime: sec(start) + delayMin * 60, depDelay: delayMin * 60, arrTime: null, arrDelay: null }],
});
const updates = (...trips) => ({ tripUpdates: async () => trips });
const kinds = (h) => h.pushed.map((m) => `${m.kind}:${m.title}`);

test('a failing data source no longer silences the watch', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  await h.run(at('05:40'));
  // Stop monitoring fails on both legs while the boat is cancelled.
  h.use('ferry-canceled', { stopVisits: async () => Promise.reject(new Error('HTTP 502')) });
  const first = await h.run(at('05:50'));
  assert.ok(first.includes('new:L0:ferry:canceled'), first.join());
  const second = await h.run(at('06:00'));
  assert.ok(second.some((d) => /^new:L\d:source$/.test(d)), `the "can't confirm" warning after two polls: ${second.join()}`);
});

test('a delay that becomes a cancellation is not followed by "已恢复"', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('SCHEDULED', 15)));
  assert.ok((await h.run(at('05:40'))).includes('new:L0:ferry:delay'));
  h.use('normal', updates(boat('CANCELED')));
  assert.ok((await h.run(at('05:50'))).includes('new:L0:ferry:canceled'));
  await h.run(at('06:00'));
  await h.run(at('06:10'));
  assert.ok(!h.pushed.some((m) => m.kind === 'resolved'), kinds(h).join('\n'));
});

test('when the replacement boat is cancelled too, the user is told again', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('05:40'));
  assert.match(h.pushed.at(-1).body, /下一班 07:25/);
  h.use('normal', updates(boat('CANCELED'), boat('CANCELED', 0, 't_6144186_b_86948_tn_0', '07:25')));
  const did = await h.run(at('05:50'));
  assert.ok(did.includes('update:L0:ferry:canceled'), did.join());
  assert.match(h.pushed.at(-1).title, /有变化/);
  assert.doesNotMatch(h.pushed.at(-1).body, /07:25/);
});

test('"可能迟到" is not cleared while the arrival time can\'t be estimated', async () => {
  const route = routeOf('normal');
  route.schedule.days[3].arriveBy = '08:10';
  const h = harness(route);
  await h.ready();
  h.use('normal', updates(boat('SCHEDULED', 20)));
  assert.ok((await h.run(at('05:40'))).includes('new:late'));
  // Muni N suspended: no estimate at all now.
  h.use('muni-down', updates(boat('SCHEDULED', 20)));
  await h.run(at('05:50'));
  await h.run(at('06:00'));
  await h.run(at('06:10'));
  assert.ok(!h.pushed.some((m) => /来得及/.test(m.title)), kinds(h).join('\n'));
});

test('once on the Muni, later trains don\'t produce a false "可能迟到"', async () => {
  const route = routeOf('normal');
  route.schedule.days[3].arriveBy = '08:10';
  const h = harness(route);
  await h.ready();
  h.use('enroute-normal');
  await h.run(at('07:30')); // N predicted 07:33 → arrive about 07:55
  // 20 minutes later the feed only lists trains that haven't left yet.
  const later = (t) => ({ line: 'N', lineName: 'N', direction: 'OB', destination: 'Ocean Beach', journeyRef: 'x', aimed: sec(t), expected: sec(t) });
  h.use('enroute-normal', { stopVisits: async (ag) => (ag === 'SF' ? [later('07:53'), later('08:01')] : []) });
  await h.run(at('07:50'));
  assert.ok(!h.pushed.some((m) => /迟到/.test(m.title)), kinds(h).join('\n'));
  const w = await h.store.watch('2026-10-14', 'morning');
  assert.equal(w.timing.eta, '07:55');
});

test('a push that fails is sent again on the next poll', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  h.pushesFail(true);
  await h.run(at('05:40'));
  assert.equal(h.pushed.length, 0);
  h.pushesFail(false);
  const did = await h.run(at('05:50'));
  assert.ok(did.includes('new:L0:ferry:canceled'), did.join());
  assert.equal(h.pushed.filter((m) => m.kind === 'issue').length, 1);
});

test('a cancellation of a different boat on the line is not the user\'s problem', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const other = {
    id: 'sb-725',
    agency: 'SB',
    header: '7:25am departure cancelled',
    description: '',
    url: '',
    cause: 'TECHNICAL_PROBLEM',
    effect: 'NO_SERVICE',
    activePeriods: [],
    informed: [{ agencyId: 'SB', routeId: 'SEA', stopId: null, tripId: 't_6144186_b_86948_tn_0' }],
  };
  h.use('normal', { alerts: async (ag) => (ag === 'SB' ? [other] : []) });
  const did = await h.run(at('05:40'));
  assert.deepEqual(did.filter((d) => d.startsWith('new:')), []);
});

test('the next boat is in the user\'s direction, not one arriving and ending at the terminal', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const call = (journeyRef, direction, hhmm) => ({ line: 'SEA', direction, journeyRef, aimed: sec(hhmm) });
  h.use('normal', {
    ...updates(boat('CANCELED')),
    timetable: async () => [
      call('t_6144183_b_86948_tn_0', 'SF', '07:00'),
      call('t_inbound_ends_here', 'AL', '07:12'),
      call('t_6144186_b_86948_tn_0', 'SF', '07:25'),
    ],
  });
  await h.run(at('05:40'));
  assert.match(h.pushed.at(-1).body, /下一班 07:25/);
});

test('a missing Muni run right before departure is a yellow gap, not just "sparse"', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  const v = (line, hhmm) => ({ line, lineName: line, direction: 'OB', destination: '', journeyRef: 'x', aimed: sec(hhmm), expected: sec(hhmm) });
  h.use('enroute-normal', { stopVisits: async (ag) => (ag === 'SF' ? [v('J', '07:31'), v('K', '07:35'), v('N', '08:25')] : []) });
  await h.run(at('07:05'));
  const second = await h.run(at('07:15'));
  assert.ok(second.includes('new:L1:line:gap'), second.join());
});

test('notify pushes every message of a busy poll and logs them in one write', async () => {
  const kv = memoryKV();
  const put = kv.put.bind(kv);
  const lastWrite = new Map();
  kv.put = async (key, value, opts) => {
    // Cloudflare KV: one write per second per key.
    if (Date.now() - (lastWrite.get(key) ?? 0) < 1000) throw new Error(`KV PUT failed: 429 (${key})`);
    lastWrite.set(key, Date.now());
    return put(key, value, opts);
  };
  const store = createStore(kv);
  const keys = await generateVapidKeys();
  const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const p256dh = Buffer.from(await crypto.subtle.exportKey('raw', ua.publicKey)).toString('base64url');
  await store.putSubs([{ endpoint: 'https://push.example/1', keys: { p256dh, auth: 'BTBZMqHH6r4Tts7J_aSIgg' } }]);
  const realFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = async () => {
    posts++;
    return new Response('', { status: 201 });
  };
  try {
    const env = { VAPID_PUBLIC_KEY: keys.publicKey, VAPID_PRIVATE_JWK: keys.privateJwk };
    const msg = (title) => ({ kind: 'issue', level: 'red', title, body: '…', badge: 2 });
    const results = await notify(env, store, at('06:00'), [msg('🔴 渡轮 SEA'), msg('🔴 轻轨 N')]);
    assert.deepEqual(results.map((r) => r.delivered), [true, true]);
    assert.equal(posts, 2);
    assert.equal((await store.events('2026-10-14')).length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('the Worker\'s automatic result never replaces Claude\'s', async () => {
  const store = createStore(memoryKV());
  await saveRecord(store, { mode: 'leave', targetDate: '2026-10-14', level: 'green', headline: 'Claude', checkedAt: '1' });
  assert.equal(await saveRecord(store, { mode: 'leave', targetDate: '2026-10-14', level: 'yellow', headline: 'auto', auto: true, checkedAt: '2' }), false);
  assert.equal((await store.checks('2026-10-14'))[0].headline, 'Claude');
});

test('re-planning starts early enough for an early night check; a check after midnight is for that day', () => {
  const route = routeOf('normal');
  route.schedule.nightCheck = '19:30';
  assert.equal(replanFrom(route), '18:00');
  route.schedule.nightCheck = '00:15';
  assert.equal(replanFrom(route), '20:00');
  const night = checkpointsFor(route, '2026-10-14').find((c) => c.mode === 'night');
  assert.equal(night.runDate, '2026-10-14');
  assert.equal(night.at.toISOString(), at('00:15').toISOString());
});

test('the home screen never leads with a finished trip, and skips paused days', async () => {
  const { statusPayload } = await import('../src/status.js');
  const store = createStore(memoryKV());
  await store.put('route', routeOf('normal'));
  await store.put('pause', { dates: ['2026-10-15'] });
  const s = await statusPayload(store, {}, at('19:00'));
  assert.deepEqual(s.focus, { date: '2026-10-16', dir: 'morning' }, 'Friday — Thursday is paused, Wednesday is over');
  assert.deepEqual(
    s.days.map((d) => d.date),
    ['2026-10-14', '2026-10-16'],
  );
});

test('problems on a trip that is over no longer count on the badge', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('normal', updates(boat('CANCELED')));
  await h.run(at('05:40'));
  const { openCount } = await import('../src/notify.js');
  assert.equal(await openCount(h.store, at('06:00')), 1);
  assert.equal(await openCount(h.store, at('17:00')), 0);
});
