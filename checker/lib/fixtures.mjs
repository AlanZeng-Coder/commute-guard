// Fixture source: reads a scenario directory (checker/fixtures/<name>/) so the whole pipeline
// can be tested offline with made-up situations (ferry cancelled, Muni down…). Files hold the
// raw upstream payloads; `<name>.error` simulates that upstream call failing.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  normalizeAlerts,
  normalizeForecastPeriods,
  normalizeNwsAlerts,
  normalizeStopVisits,
  normalizeTimetable,
  normalizeTripUpdates,
} from './normalize.mjs';

export function createFixtureSource(dir) {
  const read = (name, fallback) => {
    if (existsSync(join(dir, `${name}.error`))) throw new Error(readFileSync(join(dir, `${name}.error`), 'utf8').trim());
    const p = join(dir, name);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    if (fallback === undefined) throw new Error(`fixture missing: ${name}`);
    return fallback;
  };
  const emptyFeed = { entity: [] };
  return {
    route: async () => read('route.json', null),
    pause: async () => read('pause.json', { dates: [] }),
    plan: async (date, dir) => read(`plan-${date}-${dir}.json`, null),
    alerts: async (ag) => normalizeAlerts(read(`alerts-${ag}.json`, emptyFeed), ag),
    tripUpdates: async (ag) => normalizeTripUpdates(read(`tripupdates-${ag}.json`, emptyFeed)),
    stopVisits: async (ag, code) => normalizeStopVisits(read(`stopmonitoring-${ag}-${code}.json`, {})),
    timetable: async (ag, code) => normalizeTimetable(read(`stoptimetable-${ag}-${code}.json`, {})),
    nwsAlerts: async () => normalizeNwsAlerts(read('nws-alerts.json', { features: [] })),
    nwsMarine: async (zone) => normalizeForecastPeriods(read(`nws-marine-${zone}.json`, { properties: { periods: [] } })),
    nwsHourly: async () => normalizeForecastPeriods(read('nws-hourly.json', { properties: { periods: [] } })),
  };
}
