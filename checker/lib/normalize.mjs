// Turn raw 511 (GTFS-RT + SIRI JSON) and NWS payloads into small, uniform records.

/**
 * Comparable form of a transit id. 511 and Transitous disagree on prefixes
 * ("SB:OA" vs "OA", "SF:N" vs "N"), so strip any leading "AGENCY:" and lowercase.
 */
export function idKey(s) {
  if (s === null || s === undefined || s === '') return '';
  return String(s).trim().replace(/^[A-Za-z0-9]+:/, '').toLowerCase();
}

function text(translated) {
  const list = translated?.translation ?? [];
  const en = list.find((t) => !t.language || /^en/i.test(t.language));
  return (en ?? list[0])?.text?.trim() ?? '';
}

export function normalizeAlerts(feed, agency) {
  return (feed?.entity ?? [])
    .filter((e) => e.alert)
    .map((e) => {
      const a = e.alert;
      return {
        id: String(e.id),
        agency,
        header: text(a.headerText),
        description: text(a.descriptionText),
        url: text(a.url),
        cause: a.cause ?? 'UNKNOWN_CAUSE',
        effect: a.effect ?? 'UNKNOWN_EFFECT',
        activePeriods: (a.activePeriod ?? []).map((p) => ({ start: p.start || null, end: p.end || null })),
        informed: (a.informedEntity ?? []).map((ie) => ({
          agencyId: ie.agencyId ?? null,
          routeId: ie.routeId ?? ie.trip?.routeId ?? null,
          stopId: ie.stopId ?? null,
          tripId: ie.trip?.tripId ?? null,
        })),
      };
    });
}

export function normalizeTripUpdates(feed) {
  return (feed?.entity ?? [])
    .filter((e) => e.tripUpdate)
    .map((e) => {
      const tu = e.tripUpdate;
      return {
        tripId: tu.trip?.tripId ?? null,
        routeId: tu.trip?.routeId ?? null,
        startTime: tu.trip?.startTime ?? null,
        startDate: tu.trip?.startDate ?? null,
        relationship: tu.trip?.scheduleRelationship ?? 'SCHEDULED',
        stops: (tu.stopTimeUpdate ?? []).map((s) => ({
          stopId: s.stopId ?? null,
          relationship: s.scheduleRelationship ?? 'SCHEDULED',
          depTime: s.departure?.time ?? null,
          depDelay: s.departure?.delay ?? null,
          arrTime: s.arrival?.time ?? null,
          arrDelay: s.arrival?.delay ?? null,
        })),
      };
    });
}

/** Depth-first search for the first array stored under `key` anywhere in a SIRI payload. */
function findArray(obj, key) {
  if (!obj || typeof obj !== 'object') return null;
  if (Array.isArray(obj[key])) return obj[key];
  if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) return [obj[key]];
  for (const v of Object.values(obj)) {
    const found = findArray(v, key);
    if (found) return found;
  }
  return null;
}

const ts = (s) => (s ? new Date(s).getTime() / 1000 : null);

export function normalizeStopVisits(siri) {
  return (findArray(siri, 'MonitoredStopVisit') ?? []).map((v) => {
    const j = v.MonitoredVehicleJourney ?? {};
    const c = j.MonitoredCall ?? {};
    return {
      line: j.LineRef ?? null,
      lineName: j.PublishedLineName ?? null,
      destination: j.DestinationName ?? null,
      journeyRef: j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ?? null,
      aimed: ts(c.AimedDepartureTime ?? c.AimedArrivalTime),
      expected: ts(c.ExpectedDepartureTime ?? c.ExpectedArrivalTime),
    };
  });
}

export function normalizeTimetable(siri) {
  return (findArray(siri, 'TimetabledStopVisit') ?? []).map((v) => {
    const j = v.TargetedVehicleJourney ?? {};
    const c = j.TargetedCall ?? {};
    return {
      line: j.LineRef ?? null,
      journeyRef: j.DatedVehicleJourneyRef ?? j.FramedVehicleJourneyRef?.DatedVehicleJourneyRef ?? null,
      aimed: ts(c.AimedDepartureTime ?? c.AimedArrivalTime),
    };
  });
}

export function normalizeNwsAlerts(geo) {
  return (geo?.features ?? []).map((f) => {
    const p = f.properties ?? {};
    return {
      event: p.event ?? '',
      severity: p.severity ?? '',
      headline: p.headline ?? '',
      description: (p.description ?? '').slice(0, 600),
      onset: p.onset ?? p.effective ?? null,
      ends: p.ends ?? p.expires ?? null,
      area: p.areaDesc ?? '',
    };
  });
}

export function normalizeForecastPeriods(geo) {
  return (geo?.properties?.periods ?? []).map((p) => ({
    name: p.name ?? '',
    start: p.startTime ?? null,
    end: p.endTime ?? null,
    temperature: p.temperature ?? null,
    windSpeed: p.windSpeed ?? '',
    windDirection: p.windDirection ?? '',
    short: p.shortForecast ?? '',
    detailed: p.detailedForecast ?? '',
  }));
}
