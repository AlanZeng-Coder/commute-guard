// Data sources. `live` hits 511 / NWS / our Worker; `fixtures` reads JSON files so the
// whole pipeline can be tested offline with made-up scenarios (ferry cancelled, Muni down…).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getBytes, getJSON } from './http.mjs';
import { decodeFeed } from './gtfsrt.mjs';
import { workerBase, workerHeaders } from './env.mjs';

const API_511 = 'https://api.511.org/transit';
const NWS = 'https://api.weather.gov';
const NWS_HEADERS = { Accept: 'application/geo+json' };

export function createLiveSource({ key511 = process.env.API_511_KEY } = {}) {
  const k = () => {
    if (!key511) throw new Error('API_511_KEY is not set');
    return encodeURIComponent(key511);
  };
  const q = (params) => new URLSearchParams(params).toString();

  return {
    async route() {
      return getJSON(`${workerBase()}/api/route`, { headers: workerHeaders() });
    },
    async pause() {
      return getJSON(`${workerBase()}/api/pause`, { headers: workerHeaders() });
    },
    async alerts(agency) {
      return decodeFeed(await getBytes(`${API_511}/servicealerts?api_key=${k()}&${q({ agency })}`));
    },
    async tripUpdates(agency) {
      return decodeFeed(await getBytes(`${API_511}/tripupdates?api_key=${k()}&${q({ agency })}`));
    },
    async stopMonitoring(agency, stopCode) {
      return getJSON(`${API_511}/StopMonitoring?api_key=${k()}&${q({ agency, stopcode: stopCode, format: 'json' })}`);
    },
    async stopTimetable(agency, stopCode) {
      // No time window: a ferry terminal only has a couple dozen departures a day, so we filter locally.
      return getJSON(
        `${API_511}/stoptimetable?api_key=${k()}&${q({ operatorref: agency, monitoringref: stopCode, format: 'json' })}`,
      );
    },
    async nwsAlerts(zones) {
      return getJSON(`${NWS}/alerts/active?${q({ zone: zones.join(',') })}`, { headers: NWS_HEADERS });
    },
    async nwsMarine(zone) {
      return getJSON(`${NWS}/zones/forecast/${zone}/forecast`, { headers: NWS_HEADERS });
    },
    async nwsHourly(lat, lon) {
      const point = await getJSON(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: NWS_HEADERS });
      return getJSON(point.properties.forecastHourly, { headers: NWS_HEADERS });
    },
  };
}

export function createFixtureSource(dir) {
  const read = (name, fallback) => {
    // `<name>.error` simulates an upstream failure with that message.
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
    alerts: async (ag) => read(`alerts-${ag}.json`, emptyFeed),
    tripUpdates: async (ag) => read(`tripupdates-${ag}.json`, emptyFeed),
    stopMonitoring: async (ag, code) => read(`stopmonitoring-${ag}-${code}.json`, {}),
    stopTimetable: async (ag, code) => read(`stoptimetable-${ag}-${code}.json`, {}),
    nwsAlerts: async () => read('nws-alerts.json', { features: [] }),
    nwsMarine: async (zone) => read(`nws-marine-${zone}.json`, { properties: { periods: [] } }),
    nwsHourly: async () => read('nws-hourly.json', { properties: { periods: [] } }),
  };
}
