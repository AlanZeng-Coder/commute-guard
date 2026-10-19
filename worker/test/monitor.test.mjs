import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkpointsFor, tripFor, watchWindow } from '../../shared/schedule.mjs';
import { at, harness, routeOf } from './harness.mjs';

test('checkpoints and the watch window follow each day’s own times', () => {
  const route = routeOf('normal');
  route.schedule.days[3] = { leaveHome: '07:10', arriveBy: '09:00', leaveWork: null }; // Wednesdays later
  const trip = tripFor(route, '2026-10-14', 'morning');
  assert.equal(trip.time, '07:10');
  assert.equal(trip.source, 'closest', 'no plan saved for 07:10 → nearest saved trip');
  const cps = Object.fromEntries(checkpointsFor(route, '2026-10-14', { morning: trip }).map((c) => [c.mode, c]));
  assert.equal(cps.night.runDate, '2026-10-13');
  assert.equal(cps.night.time, '21:30');
  assert.equal(cps.wake.time, '06:20');
  assert.equal(cps.leave.time, '06:55');
  assert.equal(cps.enroute.time, '07:10', 'ten minutes after the 07:00 boat');
  assert.equal(cps.offwork, undefined, 'no evening route saved');
  const win = watchWindow(route, '2026-10-14', 'morning', trip);
  assert.equal(win.start.toISOString(), at('06:20').toISOString());
  assert.equal(win.end.toISOString(), at('09:15').toISOString(), 'until 15 min after the must-arrive time');
});

test('checkpoint times are Pacific wall-clock across the switch back to PST', () => {
  const route = routeOf('normal');
  // Mon 2026-11-02 is the first commute day after DST ends (Nov 1).
  const cps = Object.fromEntries(checkpointsFor(route, '2026-11-02').map((c) => [c.mode, c]));
  assert.equal(cps.wake.at.toISOString(), '2026-11-02T13:40:00.000Z');
  assert.equal(cps.night.at.toISOString(), '2026-11-02T05:30:00.000Z', 'Sun 21:30 PST');
});

test('a ferry cancelled mid-commute is pushed at once, Claude is asked, and recovery is pushed after two clean polls', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();

  assert.deepEqual(await h.run(at('05:40')), ['fire:2026-10-14:wake']);
  assert.equal(h.pushed.length, 0);

  h.use('ferry-canceled');
  const did = await h.run(at('05:50'));
  assert.ok(did.includes('new:L0:ferry:canceled'), did.join());
  const issue = h.pushed.at(-1);
  assert.equal(issue.kind, 'issue');
  assert.equal(issue.level, 'red');
  assert.match(issue.title, /^🔴 渡轮 SEA$/);
  assert.match(issue.body, /07:00 那班 SEA 船已取消，下一班 07:25/);
  assert.match(issue.body, /预计 08:24 到公司/);
  assert.match(issue.body, /Claude 正在分析/);
  assert.equal(h.fired.at(-1).mode, 'alert', 'the wake run saw no cancellation, so Claude is asked again');
  assert.match(h.fired.at(-1).reason, /07:00 那班 SEA 船已取消/);

  await h.run(at('06:00')); // still cancelled
  assert.equal(h.pushed.length, 1, 'same problem is not pushed twice');
  assert.equal(h.fired.length, 2);

  h.use('normal');
  await h.run(at('06:10'));
  assert.equal(h.pushed.length, 1, 'one clean poll is not enough to call it recovered');
  await h.run(at('06:20'));
  const resolved = h.pushed.at(-1);
  assert.equal(resolved.kind, 'resolved');
  assert.match(resolved.title, /已恢复：渡轮 SEA/);
  assert.match(resolved.body, /05:50 发现/);

  const watch = await h.store.watch('2026-10-14', 'morning');
  assert.deepEqual(watch.issues, {});
  assert.ok(watch.snapshot.data.tripUpdates.SB, 'raw data kept for /api/digest');
});

test('a problem found right after a check started does not wake Claude a second time', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('ferry-canceled');
  await h.run(at('05:20')); // before the wake check and outside the window: nothing
  assert.equal(h.fired.length, 0);
  await h.run(at('05:40')); // wake check fires, and the first poll finds the cancellation
  assert.deepEqual(
    h.fired.map((f) => f.mode),
    ['wake'],
  );
  assert.equal(h.pushed.filter((m) => m.kind === 'issue').length, 1, 'the instant push still goes out');
});

test('when Claude does not answer, the Worker pushes its own result after the grace period', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  h.use('muni-down');
  await h.run(at('06:15')); // leave check fired; the watch polls too
  assert.ok(h.fired.some((f) => f.mode === 'leave'));
  const before = h.pushed.length;
  await h.run(at('06:25')); // poll slot again (heavy) → fallback waits
  await h.run(at('06:30'));
  const auto = h.pushed.slice(before).find((m) => m.kind === 'check');
  assert.ok(auto, 'auto result pushed');
  assert.match(auto.body, /出门检查（自动检查）/);
  const [record] = (await h.store.checks('2026-10-14')).filter((r) => r.mode === 'leave');
  assert.equal(record.auto, true);
  assert.equal(record.level, 'red');
  assert.match(record.details, /15 分钟内没有结果/);
});

test('without a routine configured, every checkpoint still gets the Worker’s result', async () => {
  const h = harness(routeOf('normal'), { canFire: false, fireOk: false });
  await h.ready();
  await h.run(at('21:30', '13')); // Tue evening: night check for Wednesday
  await h.run(at('21:35', '13'));
  const night = h.pushed.find((m) => m.kind === 'check');
  assert.ok(night);
  assert.equal(night.level, 'green');
  assert.match(night.title, /没发现问题，预计 07:59 到/);
  assert.match(night.body, /睡前检查（自动检查） · 10\/14/);
});

test('paused days and weekends are left alone', async () => {
  const h = harness(routeOf('normal'));
  await h.ready();
  await h.store.put('pause', { dates: ['2026-10-14'] });
  assert.deepEqual(await h.run(at('06:15')), []);
  assert.deepEqual(await h.run(new Date('2026-10-17T06:15:00-07:00')), []); // Saturday
});

test('the evening watch catches a cancelled boat home', async () => {
  const h = harness(routeOf('evening-ferry-canceled'));
  await h.ready();
  h.use('evening-ferry-canceled');
  const did = await h.run(at('17:00'));
  assert.ok(did.includes('fire:2026-10-14:offwork'), did.join());
  assert.ok(did.includes('new:L1:ferry:canceled'), did.join());
  const msg = h.pushed.find((m) => m.kind === 'issue');
  assert.equal(msg.dir, 'evening');
  assert.match(msg.body, /18:15 那班 SEA 船已取消，下一班 18:45/);
  assert.match(msg.body, /预计 19:15 到家/);
});
