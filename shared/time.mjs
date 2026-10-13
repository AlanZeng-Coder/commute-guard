// Pacific-time helpers shared by the checker (Node) and the Worker.
// Everything user-facing is America/Los_Angeles wall-clock time; storage uses ISO/UTC.

export const TZ = 'America/Los_Angeles';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

export function pacificParts(date = new Date()) {
  const p = {};
  for (const { type, value } of partsFmt.formatToParts(date)) p[type] = value;
  return {
    y: Number(p.year),
    m: Number(p.month),
    d: Number(p.day),
    hh: Number(p.hour),
    mm: Number(p.minute),
    ss: Number(p.second),
  };
}

const pad = (n) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' of the given instant in Pacific time. */
export function pacificDate(date = new Date()) {
  const p = pacificParts(date);
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`;
}

/** 'HH:MM' of the given instant in Pacific time. */
export function pacificHHMM(date = new Date()) {
  const p = pacificParts(date);
  return `${pad(p.hh)}:${pad(p.mm)}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** 0 = Sunday … 6 = Saturday, for a calendar date string. */
export function weekdayOf(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

function offsetMinutes(date) {
  const p = pacificParts(date);
  return (Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(date.getTime() / 1000) * 1000) / 60000;
}

/** Instant for a Pacific wall-clock date + 'HH:MM' (handles PST/PDT). */
export function pacificToDate(dateStr, hhmm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [H, M] = hhmm.split(':').map(Number);
  const naive = Date.UTC(y, m - 1, d, H, M);
  let t = naive;
  for (let i = 0; i < 2; i++) t = naive - offsetMinutes(new Date(t)) * 60000;
  return new Date(t);
}

/** Minutes between two 'HH:MM' strings (b - a). */
export function minutesBetween(a, b) {
  const [ah, am] = a.split(':').map(Number);
  const [bh, bm] = b.split(':').map(Number);
  return bh * 60 + bm - (ah * 60 + am);
}
