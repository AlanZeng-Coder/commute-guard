#!/usr/bin/env node
// Build a route.json from Transitous without the web UI (dev/testing helper).
//   node scripts/sample-route.mjs --from "37.77,-122.27" --to "500 Parnassus Ave, San Francisco" \
//     --date 2026-10-14 [--depart 06:30] [--evening 17:30] [--pick 0] [--out route.json]

import { writeFileSync } from 'node:fs';
import { parseArgs } from '../checker/lib/env.mjs';
import { getJSON } from '../checker/lib/http.mjs';
import { DEFAULT_NOTIFY } from '../shared/schedule.mjs';
import { geocode, nearbyFerryTerminals, patternOf, planOptions } from '../shared/transitous.mjs';

const args = parseArgs();
const fetchJSON = (url) => getJSON(url);

async function resolvePlace(text) {
  const m = text.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (m) return { label: text, lat: Number(m[1]), lon: Number(m[2]) };
  const [best] = (await geocode(text, fetchJSON)).filter((g) => g.type !== 'STOP');
  if (!best) throw new Error(`no geocode result for ${text}`);
  return { label: best.label, lat: best.lat, lon: best.lon };
}

function pick(options, label) {
  for (const [i, o] of options.entries()) console.log(`${label} ${i}: ${o.startLocal}-${o.endLocal} ${o.summary}`);
  const i = Number(args.pick ?? 0);
  const primary = options[i];
  if (!primary) throw new Error(`no ${label} options`);
  return { primary, set: { pattern: patternOf(primary), alternatives: options.filter((_, j) => j !== i).slice(0, 4) } };
}

const home = await resolvePlace(args.from);
const work = await resolvePlace(args.to);
const terminals = await nearbyFerryTerminals(home, fetchJSON);
const depart = args.depart ?? '06:30';
const m = pick(await planOptions({ from: home, to: work, date: args.date, departTime: depart, terminals, fetchJSON }), 'morning');
let evening = null;
if (args.evening) {
  const options = await planOptions({ from: work, to: home, date: args.date, departTime: args.evening, terminals, terminalSide: 'to', fetchJSON });
  const e = pick(options, 'evening');
  evening = { pattern: e.set.pattern, byTime: { [args.evening]: { primary: e.primary, alternatives: e.set.alternatives } } };
}
const route = {
  version: 2,
  savedAt: new Date().toISOString(),
  home,
  work,
  terminals,
  schedule: {
    nightCheck: '21:30',
    days: Object.fromEntries([1, 2, 3, 4, 5].map((d) => [d, { leaveHome: depart, arriveBy: null, leaveWork: args.evening ?? null }])),
  },
  notify: DEFAULT_NOTIFY,
  morning: { pattern: m.set.pattern, byTime: { [depart]: { primary: m.primary, alternatives: m.set.alternatives } } },
  evening,
};
if (args.out) writeFileSync(args.out, JSON.stringify(route, null, 1));
console.log(`terminals: ${terminals.map((t) => `${t.name} ${t.km.toFixed(1)}km`).join('; ')}`);
