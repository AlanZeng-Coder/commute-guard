#!/usr/bin/env node
// Build a route.json from Transitous without the web UI (dev/testing helper).
//   node scripts/sample-route.mjs --from "37.77,-122.27" --to "500 Parnassus Ave, San Francisco" --date 2026-10-14 --out route.json

import { writeFileSync } from 'node:fs';
import { parseArgs } from '../checker/lib/env.mjs';
import { getJSON } from '../checker/lib/http.mjs';
import { geocode, nearbyFerryTerminals, planOptions } from '../shared/transitous.mjs';
import { DEFAULT_WORKDAYS } from '../shared/schedule.mjs';

const args = parseArgs();
const fetchJSON = (url) => getJSON(url);

async function resolvePlace(text) {
  const m = text.match(/^\s*(-?\d+\.\d+)\s*,\s*(-?\d+\.\d+)\s*$/);
  if (m) return { label: text, lat: Number(m[1]), lon: Number(m[2]) };
  const [best] = (await geocode(text, fetchJSON)).filter((g) => g.type !== 'STOP');
  if (!best) throw new Error(`no geocode result for ${text}`);
  return { label: best.label, lat: best.lat, lon: best.lon };
}

const home = await resolvePlace(args.from);
const work = await resolvePlace(args.to);
const terminals = await nearbyFerryTerminals(home, fetchJSON);
const departTime = args.depart ?? '06:30';
const options = await planOptions({ from: home, to: work, date: args.date, departTime, terminals, fetchJSON });
for (const [i, o] of options.entries()) console.log(`${i}: ${o.startLocal}-${o.endLocal} ${o.summary}`);
const pick = Number(args.pick ?? 0);
const route = {
  version: 1,
  savedAt: new Date().toISOString(),
  home,
  work,
  departTime,
  workdays: DEFAULT_WORKDAYS,
  primary: options[pick],
  alternatives: options.filter((_, i) => i !== pick).slice(0, 4),
};
if (args.out) writeFileSync(args.out, JSON.stringify(route, null, 2));
console.log(`terminals: ${terminals.map((t) => `${t.name} ${t.km.toFixed(1)}km`).join('; ')}`);
