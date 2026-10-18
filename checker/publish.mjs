#!/usr/bin/env node
// Send Claude's verdict to the Worker, which stores it and pushes it to the phone.
//
//   node checker/publish.mjs                      # reads checker/out/verdict.json + digest.json
//   node checker/publish.mjs --skip               # record a skipped check (no push)
//   node checker/publish.mjs --dry-run            # print what would be sent
//
// verdict.json (written by Claude):
//   { "level": "green|yellow|red", "headline": "…", "legs": [{ "name": "…", "level": "…", "note": "…" }],
//     "planB": "…", "details": "…", "sources": [{ "title": "…", "url": "…" }] }

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVELS } from '../shared/schedule.mjs';
import { loadDotEnv, parseArgs, workerBase, workerHeaders } from './lib/env.mjs';
import { sendJSON } from './lib/http.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

export function buildRecord(digest, verdict) {
  if (!LEVELS.includes(verdict.level)) throw new Error(`level must be one of ${LEVELS.join('/')}`);
  const headline = String(verdict.headline ?? '').trim();
  if (!headline) throw new Error('headline is required');
  return {
    mode: digest.mode,
    dir: digest.dir,
    targetDate: digest.targetDate,
    level: verdict.level,
    headline: headline.slice(0, 120),
    legs: (verdict.legs ?? []).slice(0, 6).map((l) => ({
      name: String(l.name ?? ''),
      level: LEVELS.includes(l.level) ? l.level : 'yellow',
      note: String(l.note ?? '').slice(0, 300),
    })),
    planB: verdict.planB ? String(verdict.planB).slice(0, 400) : null,
    details: verdict.details ? String(verdict.details).slice(0, 1500) : null,
    sources: (verdict.sources ?? []).slice(0, 6),
    suggestedLevel: digest.suggestedLevel,
    reasons: (digest.reasons ?? []).slice(0, 8),
    timing: digest.timing ? { eta: digest.timing.eta, arriveBy: digest.timing.arriveBy, lateMin: digest.timing.lateMin } : null,
    errors: (digest.errors ?? []).map((e) => `${e.source}: ${e.message}`).slice(0, 6),
    checkedAt: new Date().toISOString(),
  };
}

async function main() {
  loadDotEnv(resolve(here, '..', '.env'));
  const args = parseArgs();
  const digest = readJSON(resolve(args.digest ?? resolve(here, 'out', 'digest.json')));
  const verdict = args.skip
    ? { level: 'skip', headline: digest.skip?.message ?? '今天不检查' }
    : readJSON(resolve(args.verdict ?? resolve(here, 'out', 'verdict.json')));
  const record = buildRecord(digest, verdict);

  if (args['dry-run']) {
    console.log(JSON.stringify(record, null, 2));
    return;
  }
  const res = await sendJSON(`${workerBase()}/api/status`, 'POST', record, { headers: workerHeaders() });
  console.log(`published ${record.mode} ${record.targetDate} ${record.level}; push: ${res?.pushed ?? 'n/a'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
