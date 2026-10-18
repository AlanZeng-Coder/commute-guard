// Live data sources: 511 and NWS over fetch, returning the normalized records from
// normalize.mjs. Runs in Node (checker) and in the Worker (the 10-minute watch), so no Node
// APIs here — fixture scenarios for tests live in fixtures.mjs.

import { getBytes, getJSON } from './http.mjs';
import { decodeFeed } from './gtfsrt.mjs';
import {
  normalizeAlerts,
  normalizeForecastPeriods,
  normalizeNwsAlerts,
  normalizeStopVisits,
  normalizeTimetable,
  normalizeTripUpdates,
} from './normalize.mjs';

export const API_511 = 'https://api.511.org/transit';
const NWS = 'https://api.weather.gov';
const NWS_HEADERS = { Accept: 'application/geo+json' };

/**
 * `workerBase`/`workerHeaders` are only needed when running on the laptop, where the route
 * and pause list come from our Worker; the Worker itself reads them from KV.
 */
export function createLiveSource({ key511, base511 = API_511, workerBase, workerHeaders = {} } = {}) {
  const k = () => {
    if (!key511) throw new Error('API_511_KEY is not set');
    return encodeURIComponent(key511);
  };
  const q = (params) => new URLSearchParams(params).toString();

  return {
    async route() {
      return getJSON(`${workerBase}/api/route`, { headers: workerHeaders });
    },
    async pause() {
      return getJSON(`${workerBase}/api/pause`, { headers: workerHeaders });
    },
    async plan() {
      return null;
    },
    async alerts(agency) {
      const feed = decodeFeed(await getBytes(`${base511}/servicealerts?api_key=${k()}&${q({ agency })}`));
      return normalizeAlerts(feed, agency);
    },
    async tripUpdates(agency) {
      return normalizeTripUpdates(decodeFeed(await getBytes(`${base511}/tripupdates?api_key=${k()}&${q({ agency })}`)));
    },
    async stopVisits(agency, stopCode) {
      return normalizeStopVisits(
        await getJSON(`${base511}/StopMonitoring?api_key=${k()}&${q({ agency, stopcode: stopCode, format: 'json' })}`),
      );
    },
    async timetable(agency, stopCode) {
      // No time window: a ferry terminal only has a couple dozen departures a day, so we filter locally.
      return normalizeTimetable(
        await getJSON(
          `${base511}/stoptimetable?api_key=${k()}&${q({ operatorref: agency, monitoringref: stopCode, format: 'json' })}`,
        ),
      );
    },
    async nwsAlerts(zones) {
      return normalizeNwsAlerts(await getJSON(`${NWS}/alerts/active?${q({ zone: zones.join(',') })}`, { headers: NWS_HEADERS }));
    },
    async nwsMarine(zone) {
      return normalizeForecastPeriods(await getJSON(`${NWS}/zones/forecast/${zone}/forecast`, { headers: NWS_HEADERS }));
    },
    async nwsHourly(lat, lon) {
      const point = await getJSON(`${NWS}/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: NWS_HEADERS });
      return normalizeForecastPeriods(await getJSON(point.properties.forecastHourly, { headers: NWS_HEADERS }));
    },
  };
}
