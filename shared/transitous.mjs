// Route planning through Transitous (free, open-source MOTIS instance), shared by the
// setup page (browser) and dev scripts (Node). The caller injects `fetchJSON` so the
// browser can rely on Referer while Node sends a User-Agent, as Transitous asks.
//
// Transitous serves the 511 regional GTFS feed, so agency ids (SB, SF, BA, AC), route ids
// ("SB:SEA") and stop codes line up with the 511 realtime APIs the checker uses.

import { pacificHHMM, pacificToDate } from './time.mjs';

export const TRANSITOUS = 'https://api.transitous.org';
export const ATTRIBUTION_URL = 'https://transitous.org/sources/';

const NON_TRANSIT = new Set(['WALK', 'BIKE', 'CAR', 'RENTAL', 'CAR_PARKING', 'CAR_DROPOFF', 'FLEX', 'ODM', 'DEBUG_BUS_ROUTE']);
const ICON = { FERRY: '⛴', TRAM: '🚋', SUBWAY: '🚇', BUS: '🚌', COACH: '🚌', RAIL: '🚆', REGIONAL_RAIL: '🚆', SUBURBAN: '🚆', CABLE_CAR: '🚡' };

/** "us-ca-SF-bayarea_AC:96" → "AC:96"; "20261014_06:03_us-ca-SFMTA_123" → "123". */
export function stripFeed(id) {
  if (!id) return null;
  return String(id)
    .replace(/^\d{8}_\d{2}:\d{2}_/, '')
    .replace(/^[a-z]{2}-[a-z]{2}-[^_]+_/i, '');
}

const local = (iso) => (iso ? pacificHHMM(new Date(iso)) : null);
const minutes = (a, b) => Math.round((new Date(b) - new Date(a)) / 60000);

function stop(s) {
  return {
    name: s?.name ?? '',
    stopId: stripFeed(s?.stopId),
    stopCode: s?.stopCode || null,
    lat: s?.lat ?? null,
    lon: s?.lon ?? null,
  };
}

export function normalizeLeg(l) {
  const start = l.scheduledStartTime ?? l.startTime;
  const end = l.scheduledEndTime ?? l.endTime;
  const base = {
    mode: l.mode,
    transit: !NON_TRANSIT.has(l.mode),
    depLocal: local(start),
    arrLocal: local(end),
    durationMin: minutes(start, end),
    from: stop(l.from),
    to: stop(l.to),
  };
  if (!base.transit) return base;
  return {
    ...base,
    agencyId: l.agencyId ?? null,
    agencyName: l.agencyName ?? null,
    routeId: stripFeed(l.routeId),
    routeShortName: l.routeShortName || l.displayName || null,
    routeLongName: l.routeLongName || null,
    routeColor: l.routeColor || null,
    headsign: l.headsign || null,
    tripId: stripFeed(l.tripId),
  };
}

function finish(legs) {
  const transit = legs.filter((l) => l.transit);
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    summary: transit.map((l) => `${ICON[l.mode] ?? '🚍'} ${l.routeShortName ?? l.mode}`).join(' → ') || '🚶 步行',
    startLocal: first?.depLocal,
    endLocal: last?.arrLocal,
    hasFerry: transit.some((l) => l.mode === 'FERRY'),
    transfers: Math.max(0, transit.length - 1),
    legs,
  };
}

export function normalizeItinerary(it) {
  const out = finish((it.legs ?? []).map(normalizeLeg));
  return { ...out, durationMin: Math.round((it.duration ?? 0) / 60) };
}

const toMin = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Leave home later when the way to the terminal is just walking: arrive 5 minutes before boarding. */
function shiftWalkAccess(accessLegs, boardLocal) {
  if (accessLegs.some((l) => l.transit) || !boardLocal) return accessLegs;
  const shift = toMin(boardLocal) - 5 - toMin(accessLegs[accessLegs.length - 1].arrLocal);
  if (shift <= 0) return accessLegs;
  return accessLegs.map((l) => ({ ...l, depLocal: fromMin(toMin(l.depLocal) + shift), arrLocal: fromMin(toMin(l.arrLocal) + shift) }));
}

const withDuration = (out) => ({ ...out, durationMin: minutes(`1970-01-01T${out.startLocal}:00Z`, `1970-01-01T${out.endLocal}:00Z`) });

function compose(access, main) {
  const board = main.legs.find((l) => l.transit)?.depLocal;
  return withDuration(finish([...shiftWalkAccess(access.legs, board), ...main.legs]));
}

/** `main` ends at a terminal; walk on from there (`egress` is a walking plan, re-timed to follow). */
function composeEgress(main, egress) {
  let t = toMin(main.endLocal);
  const legs = egress.legs.map((l) => {
    const out = { ...l, depLocal: fromMin(t), arrLocal: fromMin(t + l.durationMin) };
    t += l.durationMin;
    return out;
  });
  return withDuration(finish([...main.legs, ...legs]));
}

/** The lines a commute uses, in order ("SB:SEA>N") — what the user picks once per direction. */
export const patternOf = (it) =>
  it.legs
    .filter((l) => l.transit)
    .map((l) => l.routeId)
    .join('>');

// Same start time + same sequence of lines = the same commute for our purposes.
const signature = (it) => `${it.startLocal}|${patternOf(it)}`;


function haversineKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export const BAY_AREA = { lat: 37.79, lon: -122.3 };

// Transitous' geocoder matches "Webster Street" but not "Webster St", so spell suffixes out.
const SUFFIX = {
  st: 'Street', ave: 'Avenue', av: 'Avenue', blvd: 'Boulevard', dr: 'Drive', rd: 'Road', ln: 'Lane',
  ct: 'Court', pl: 'Place', pkwy: 'Parkway', hwy: 'Highway', ter: 'Terrace', cir: 'Circle', sq: 'Square', way: 'Way',
};
export const expandAddress = (text) =>
  text.replace(/\b(st|ave|av|blvd|dr|rd|ln|ct|pl|pkwy|hwy|ter|cir|sq)\b\.?(?=\s|,|$)/gi, (m, w) => SUFFIX[w.toLowerCase()]);

/** Address/place search, biased to (and limited to) the Bay Area — unbiased results wander abroad. */
export async function geocode(text, fetchJSON, near = BAY_AREA, { maxKm = 120 } = {}) {
  const q = new URLSearchParams({ text: expandAddress(text), place: `${near.lat},${near.lon}`, placeBias: '5' });
  const res = await fetchJSON(`${TRANSITOUS}/api/v1/geocode?${q}`);
  const seen = new Set();
  return (res ?? [])
    .filter((m) => haversineKm(BAY_AREA, m) <= maxKm)
    .map((m) => ({
      id: m.id,
      type: m.type,
      label: [
        [m.houseNumber?.split(';')[0], m.street].filter(Boolean).join(' ') || m.name,
        m.areas?.find((a) => a.default)?.name,
      ]
        .filter(Boolean)
        .join(', '),
      name: m.name,
      lat: m.lat,
      lon: m.lon,
      modes: m.modes ?? [],
    }))
    // The same address often comes back several times (one per OSM object); keep the first.
    .filter((g) => {
      const key = `${g.type}|${g.label.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export async function nearbyFerryTerminals(home, fetchJSON, { maxKm = 15, limit = 3 } = {}) {
  const q = new URLSearchParams({ text: 'ferry terminal', type: 'STOP', place: `${home.lat},${home.lon}`, placeBias: '5' });
  const res = await fetchJSON(`${TRANSITOUS}/api/v1/geocode?${q}`);
  return (res ?? [])
    .filter((m) => (m.modes ?? []).includes('FERRY'))
    .map((m) => ({ id: m.id, name: m.name, lat: m.lat, lon: m.lon, km: haversineKm(home, m) }))
    .filter((m) => m.km <= maxKm)
    .sort((a, b) => a.km - b.km)
    .slice(0, limit);
}

async function plan(fetchJSON, params) {
  const q = new URLSearchParams(params);
  const res = await fetchJSON(`${TRANSITOUS}/api/v5/plan?${q}`);
  return res ?? { itineraries: [], direct: [] };
}

const place = (p) => (p.id && !p.lat ? p.id : `${p.lat},${p.lon}`);

/**
 * Candidate commutes for a weekday: the planner's own best options, plus options stitched
 * through each nearby ferry terminal. The planner rarely offers the boat on its own when the
 * terminal is just a walk from either end, so:
 *   terminalSide 'from' (to work):  walk to the terminal + "terminal → destination"
 *   terminalSide 'to' (home):       "origin → terminal" + walk home
 * (Transitous' `via` parameter lets a trip stay aboard through the via stop, which gives odd results.)
 */
export async function planOptions({ from, to, date, departTime, terminals = [], terminalSide = 'from', fetchJSON, slackMin = 45 }) {
  const time = pacificToDate(date, departTime).toISOString();
  const results = [];

  const direct = plan(fetchJSON, { fromPlace: place(from), toPlace: place(to), time, numItineraries: '4' }).then((r) =>
    (r.itineraries ?? []).map(normalizeItinerary),
  );

  const viaFrom = async (t) => {
    const access = await plan(fetchJSON, { fromPlace: place(from), toPlace: t.id, time, numItineraries: '2' });
    const accessOptions = [...(access.direct ?? []), ...(access.itineraries ?? [])]
      .map(normalizeItinerary)
      .filter((it) => it.legs.length)
      .sort((a, b) => a.endLocal.localeCompare(b.endLocal));
    const reach = accessOptions[0];
    if (!reach) return [];
    const at = new Date(pacificToDate(date, reach.endLocal).getTime() + 3 * 60000).toISOString();
    const main = await plan(fetchJSON, {
      fromPlace: t.id,
      toPlace: place(to),
      time: at,
      numItineraries: '3',
      maxPreTransitTime: '60',
    });
    return (main.itineraries ?? []).map((it) => compose(reach, normalizeItinerary(it)));
  };

  const viaTo = async (t) => {
    const [main, egress] = await Promise.all([
      plan(fetchJSON, { fromPlace: place(from), toPlace: t.id, time, numItineraries: '3' }),
      plan(fetchJSON, { fromPlace: t.id, toPlace: place(to), time, numItineraries: '1' }),
    ]);
    const walk = (egress.direct ?? []).map(normalizeItinerary).find((it) => it.legs.length && !it.legs.some((l) => l.transit));
    if (!walk) return [];
    return (main.itineraries ?? [])
      .map(normalizeItinerary)
      .filter((it) => it.hasFerry)
      .map((it) => composeEgress(it, walk));
  };

  const viaTerminals = terminals.map(terminalSide === 'to' ? viaTo : viaFrom);
  for (const r of await Promise.allSettled([direct, ...viaTerminals])) {
    if (r.status === 'fulfilled') results.push(...r.value);
  }

  // Keep the earliest arrival per signature, then drop options that arrive much later than
  // the best one of the same kind (ferry vs. not), so the list stays short and sensible.
  const seen = new Set();
  const unique = results
    // Overnight or absurdly long results (the planner's fallback when nothing runs) are not commutes.
    .filter((it) => it.durationMin > 0 && it.durationMin <= 240 && it.endLocal > it.startLocal)
    .sort((a, b) => a.endLocal.localeCompare(b.endLocal))
    .filter((it) => {
      const sig = signature(it);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  const best = {};
  for (const it of unique) best[it.hasFerry] ??= toMin(it.endLocal);
  return unique
    .filter((it) => toMin(it.endLocal) <= best[it.hasFerry] + slackMin)
    .sort((a, b) => Number(b.hasFerry) - Number(a.hasFerry) || a.endLocal.localeCompare(b.endLocal))
    .slice(0, 8);
}

/**
 * Plan one departure time and pick the option that uses the same lines the user chose.
 * Returns { primary: null, options } when that combination isn't offered at this time.
 */
export async function planDay({ from, to, date, time, terminals, terminalSide, pattern, fetchJSON }) {
  const options = await planOptions({ from, to, date, departTime: time, terminals, terminalSide, fetchJSON });
  const i = options.findIndex((o) => patternOf(o) === pattern);
  if (i < 0) return { primary: null, alternatives: [], options };
  return { primary: options[i], alternatives: options.filter((_, j) => j !== i).slice(0, 4), options };
}
