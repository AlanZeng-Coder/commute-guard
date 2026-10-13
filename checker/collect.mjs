#!/usr/bin/env node
// Gather everything one check needs and write checker/out/digest.json.
//
//   node checker/collect.mjs --mode leave
//   node checker/collect.mjs --mode enroute --fixtures checker/fixtures/muni-down --now 2026-10-14T13:57:00Z
//
// Env: API_511_KEY, CG_BASE_URL, CG_WRITE_TOKEN (optional in the cloud; the agent proxy adds it).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES } from '../shared/schedule.mjs';
import { analyze, skipReason } from './lib/analyze.mjs';
import { loadDotEnv, parseArgs } from './lib/env.mjs';
import { gather } from './lib/gather.mjs';
import { createFixtureSource, createLiveSource } from './lib/source.mjs';

const here = dirname(fileURLToPath(import.meta.url));

export async function collect({ mode, now = new Date(), source, routeOverride }) {
  const route = routeOverride ?? (await source.route());
  const pause = await source.pause().catch(() => ({ dates: [] }));
  const empty = { data: { alerts: {}, tripUpdates: {}, stopVisits: {}, timetable: {}, weather: {} }, errors: [] };
  const needData = route?.primary && !skipReason({ mode, now, route, pause });
  const gathered = needData ? await gather(source, route, mode) : empty;
  return analyze({ mode, now, route, pause, gathered });
}

async function main() {
  loadDotEnv(resolve(here, '..', '.env'));
  const args = parseArgs();
  const mode = args.mode;
  if (!MODES.includes(mode)) {
    console.error(`--mode must be one of: ${MODES.join(', ')}`);
    process.exit(2);
  }
  const source = args.fixtures ? createFixtureSource(resolve(args.fixtures)) : createLiveSource();
  const routeOverride = args.route ? JSON.parse(readFileSync(resolve(args.route), 'utf8')) : undefined;
  const now = args.now ? new Date(args.now) : new Date();

  const digest = await collect({ mode, now, source, routeOverride });

  const out = resolve(args.out ?? resolve(here, 'out', 'digest.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(digest, null, 2));

  console.log(`${digest.modeLabel} → ${digest.targetDate}  建议：${digest.suggestedLevel}`);
  for (const r of digest.reasons) console.log(`  ${r}`);
  for (const e of digest.errors ?? []) console.log(`  ⚠ ${e.source}: ${e.message}`);
  console.log(`digest: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
