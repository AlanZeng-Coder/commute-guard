#!/usr/bin/env node
// Gather everything one check needs and write checker/out/digest.json.
//
//   node checker/collect.mjs --remote --mode leave --date 2026-10-20 --dir morning   # the routine
//   node checker/collect.mjs --mode leave                                            # laptop, live 511
//   node checker/collect.mjs --mode enroute --fixtures checker/fixtures/muni-down --now 2026-10-14T13:57:00Z
//
// --remote asks our Worker to build the digest (it already has fresh 511 data from its watch),
// so the routine needs no 511 key and no npm packages. --date defaults to the commute day the
// mode is about (night → tomorrow), --dir to the mode's direction.
//
// Env: CG_BASE_URL, CG_WRITE_TOKEN (optional in the cloud; the agent proxy adds it), API_511_KEY (local live runs).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODES, checkByMode, dirAt } from '../shared/schedule.mjs';
import { pacificHHMM } from '../shared/time.mjs';
import { targetDateFor } from './lib/analyze.mjs';
import { buildDigest } from './lib/digest.mjs';
import { loadDotEnv, parseArgs, workerBase, workerHeaders } from './lib/env.mjs';
import { getJSON } from './lib/http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function resolveCheck({ mode, now = new Date(), date, dir }) {
  return {
    mode,
    date: date ?? targetDateFor(mode, now),
    dir: dir ?? checkByMode(mode)?.dir ?? dirAt(pacificHHMM(now)),
  };
}

export async function collect({ mode, now = new Date(), source, date, dir, routeOverride }) {
  const check = resolveCheck({ mode, now, date, dir });
  const src = routeOverride ? { ...source, route: async () => routeOverride } : source;
  return (await buildDigest({ ...check, now, source: src })).digest;
}

async function main() {
  loadDotEnv(resolve(here, '..', '.env'));
  const args = parseArgs();
  const mode = args.mode;
  if (!MODES.includes(mode)) {
    console.error(`--mode must be one of: ${MODES.join(', ')}`);
    process.exit(2);
  }
  if (args.date && !DATE_RE.test(args.date)) {
    console.error('--date must be YYYY-MM-DD');
    process.exit(2);
  }
  if (args.dir && !['morning', 'evening'].includes(args.dir)) {
    console.error('--dir must be morning or evening');
    process.exit(2);
  }
  const now = args.now ? new Date(args.now) : new Date();
  const check = resolveCheck({ mode, now, date: args.date, dir: args.dir });

  let digest;
  if (args.remote) {
    const q = new URLSearchParams(check);
    digest = await getJSON(`${workerBase()}/api/digest?${q}`, { headers: workerHeaders(), timeoutMs: 60000 });
  } else {
    // Imported lazily so --remote runs without the protobuf package installed.
    const source = args.fixtures
      ? (await import('./lib/fixtures.mjs')).createFixtureSource(resolve(args.fixtures))
      : (await import('./lib/source.mjs')).createLiveSource({
          key511: process.env.API_511_KEY,
          workerBase: args.route ? undefined : workerBase(),
          workerHeaders: workerHeaders(),
        });
    const routeOverride = args.route ? JSON.parse(readFileSync(resolve(args.route), 'utf8')) : undefined;
    digest = await collect({ ...check, now, source, routeOverride });
  }

  const out = resolve(args.out ?? resolve(here, 'out', 'digest.json'));
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(digest, null, 2));

  console.log(`${digest.modeLabel}（${digest.dirLabel ?? ''}）→ ${digest.targetDate}  建议：${digest.suggestedLevel}`);
  for (const r of digest.reasons) console.log(`  ${r}`);
  if (digest.timing?.eta) console.log(`  预计到达 ${digest.timing.eta}${digest.timing.arriveBy ? `（要求 ${digest.timing.arriveBy} 前）` : ''}`);
  for (const e of digest.errors ?? []) console.log(`  ⚠ ${e.source}: ${e.message}`);
  console.log(`digest: ${out}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
