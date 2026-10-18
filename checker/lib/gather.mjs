// Decide which upstream calls a check needs, run them in parallel, and collect the results.
// A failed call becomes an entry in `errors` instead of failing the whole check.

// SF Bay marine zones on either side of the Bay Bridge, plus SF city and the bay shoreline.
export const NWS_ALERT_ZONES = ['PZZ530', 'PZZ531', 'CAZ006', 'CAZ508'];
export const NWS_MARINE_ZONE = 'PZZ530';
// Mid-bay point between Alameda and the Ferry Building, for the hourly forecast.
export const NWS_POINT = { lat: 37.803, lon: -122.34 };

const transitLegs = (it) => (it?.legs ?? []).filter((l) => l.transit);

/**
 * Which realtime lookups a mode uses: none the night before, ferry trip status from wake on,
 * line predictions once the user is about to leave. `monitor` is the Worker's 10-minute watch.
 */
export function realtimeKinds(mode) {
  return {
    ferry: mode !== 'night',
    line: mode !== 'night' && mode !== 'wake',
  };
}

/**
 * `alternatives: false` skips alerts for agencies only the alternatives use, and
 * `weather: false` skips NWS — the Worker's watch only needs the primary trip.
 */
export function planRequests(trip, mode, { alternatives = true } = {}) {
  const rt = realtimeKinds(mode);
  const agencies = new Set();
  for (const it of [trip.primary, ...(alternatives ? trip.alternatives ?? [] : [])]) {
    for (const leg of transitLegs(it)) if (leg.agencyId) agencies.add(leg.agencyId);
  }
  const stopVisits = new Map();
  const timetables = new Map();
  const tripUpdates = new Set();
  for (const leg of transitLegs(trip.primary)) {
    const code = leg.from?.stopCode || leg.from?.stopId;
    if (!leg.agencyId || !code) continue;
    const key = `${leg.agencyId}:${code}`;
    if (leg.mode === 'FERRY') {
      if (!rt.ferry) continue;
      tripUpdates.add(leg.agencyId);
      timetables.set(key, [leg.agencyId, code]);
      stopVisits.set(key, [leg.agencyId, code]);
    } else if (rt.line) {
      stopVisits.set(key, [leg.agencyId, code]);
    }
  }
  return { agencies: [...agencies], stopVisits, timetables, tripUpdates: [...tripUpdates] };
}

export const emptyGathered = () => ({
  data: { alerts: {}, tripUpdates: {}, stopVisits: {}, timetable: {}, weather: {} },
  errors: [],
});

export async function gather(source, trip, mode, { alternatives = true, weather = true } = {}) {
  const req = planRequests(trip, mode, { alternatives });
  const { data, errors } = emptyGathered();
  const jobs = [];
  const job = (label, fn) =>
    jobs.push(
      fn().catch((err) => {
        errors.push({ source: label, message: String(err?.message ?? err) });
      }),
    );

  for (const ag of req.agencies) {
    job(`511 alerts ${ag}`, async () => {
      data.alerts[ag] = await source.alerts(ag);
    });
  }
  for (const ag of req.tripUpdates) {
    job(`511 trip updates ${ag}`, async () => {
      data.tripUpdates[ag] = await source.tripUpdates(ag);
    });
  }
  for (const [key, [ag, code]] of req.stopVisits) {
    job(`511 stop monitoring ${key}`, async () => {
      data.stopVisits[key] = await source.stopVisits(ag, code);
    });
  }
  for (const [key, [ag, code]] of req.timetables) {
    job(`511 stop timetable ${key}`, async () => {
      data.timetable[key] = await source.timetable(ag, code);
    });
  }
  if (weather) {
    job('NWS alerts', async () => {
      data.weather.alerts = await source.nwsAlerts(NWS_ALERT_ZONES);
    });
    job('NWS marine forecast', async () => {
      data.weather.marine = await source.nwsMarine(NWS_MARINE_ZONE);
    });
    job('NWS hourly forecast', async () => {
      data.weather.hourly = await source.nwsHourly(NWS_POINT.lat, NWS_POINT.lon);
    });
  }

  await Promise.all(jobs);
  return { data, errors, requests: req };
}
