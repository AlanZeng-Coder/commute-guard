// Test harness: runs the Worker's cron (tick) against an in-memory KV, with 511 served from a
// fixture scenario (optionally with some calls overridden), and records pushes and routine fires.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureSource } from '../../checker/lib/fixtures.mjs';
import { tick } from '../src/monitor.js';
import { createStore, memoryKV } from '../src/store.js';

export const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'checker', 'fixtures');
export const routeOf = (scenario) => JSON.parse(readFileSync(join(fixtures, scenario, 'route.json'), 'utf8'));

// Commute day in the fixtures: Wed 2026-10-14 (PDT, UTC-7). Leave 06:30, ferry SEA 07:00, must arrive 08:30.
export const at = (hhmm, day = '14') => new Date(`2026-10-${day}T${hhmm}:00-07:00`);

/** A Worker run against an in-memory KV, with 511 served from a fixture scenario. */
export function harness(route, { canFire = true, fireOk = true } = {}) {
  const kv = memoryKV();
  const store = createStore(kv);
  const pushed = [];
  const fired = [];
  let scenario = 'normal';
  let overrides = {};
  let delivering = true;
  const run = async (now) => {
    const ctx = {
      now,
      store,
      source: () => ({ ...createFixtureSource(join(fixtures, scenario)), ...overrides, route: store.route, pause: store.pause, plan: store.plan }),
      notify: async (msgs) => {
        const list = Array.isArray(msgs) ? msgs : [msgs];
        const results = list.map(() => ({ delivered: delivering, deliverable: true }));
        if (delivering) pushed.push(...list);
        return Array.isArray(msgs) ? results : results[0];
      },
      fire: async (req) => {
        fired.push(req);
        return fireOk ? { ok: true, status: 200 } : { ok: false, status: 500 };
      },
      canFire,
      replan: async () => null,
    };
    return tick(ctx);
  };
  return {
    store,
    pushed,
    fired,
    run,
    use: (s, o = {}) => {
      scenario = s;
      overrides = o;
    },
    pushesFail: (failing) => {
      delivering = !failing;
    },
    ready: () => store.put('route', route),
  };
}

