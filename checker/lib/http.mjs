export const USER_AGENT = 'commute-guard/0.1 (personal commute checker; github.com/AlanZeng-Coder)';

export class HttpError extends Error {
  constructor(url, status, body) {
    super(`HTTP ${status} for ${redact(url)}${body ? `: ${body.slice(0, 200)}` : ''}`);
    this.status = status;
  }
}

/** Hide api keys / tokens when a URL ends up in an error message or the digest. */
export function redact(url) {
  return String(url).replace(/(api_key|token)=[^&]+/gi, '$1=***');
}

async function request(url, { headers = {}, timeoutMs = 20000, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { 'User-Agent': USER_AGENT, ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new HttpError(url, res.status, await res.text().catch(() => ''));
  return res;
}

export async function getJSON(url, opts) {
  const res = await request(url, opts);
  // 511 prefixes its JSON with a UTF-8 BOM, which JSON.parse rejects.
  const text = (await res.text()).replace(/^﻿/, '');
  return JSON.parse(text);
}

export async function getBytes(url, opts) {
  const res = await request(url, opts);
  return new Uint8Array(await res.arrayBuffer());
}

export async function sendJSON(url, method, data, { headers = {}, ...opts } = {}) {
  const res = await request(url, {
    ...opts,
    method,
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json', ...headers },
  });
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
