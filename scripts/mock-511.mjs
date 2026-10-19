#!/usr/bin/env node
// Local stand-ins for 511 (fixture scenarios served as real protobuf / SIRI JSON) and for a
// browser push service (records and decrypts what the Worker sends), for trying the Worker
// end to end with `npm run dev`. In worker/.dev.vars set API_511_KEY=dev-mock (any non-empty
// value) and API_511_BASE=http://127.0.0.1:8788.
//   node scripts/mock-511.mjs
//   POST /__scenario?name=muni-down   switch the 511 scenario
//   GET  /__pushes                    decrypted push messages received so far
//   GET  /__sub                       a fake browser subscription (endpoint + keys) to register
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', 'checker', 'fixtures');
const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;
let scenario = 'normal';
const calls = [];
const pushes = [];

const b64u = (b) => Buffer.from(b).toString('base64url');
const ua = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
const uaPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ua.publicKey));
const auth = crypto.getRandomValues(new Uint8Array(16));
const sub = { endpoint: 'http://127.0.0.1:8788/push/dev', keys: { p256dh: b64u(uaPublic), auth: b64u(auth) } };

async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8));
}
async function decrypt(body) {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey }, ua.privateKey, 256));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode('WebPush: info\0'), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  if (plain.at(-1) !== 2) throw new Error('bad padding delimiter');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, -1)));
}

function fixture(name) {
  const p = join(FIX, scenario, name);
  if (existsSync(`${p}.error`)) return { error: readFileSync(`${p}.error`, 'utf8') };
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const send = (status, data, type = 'application/json') => {
    res.writeHead(status, { 'Content-Type': type });
    res.end(typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data));
  };
  if (url.pathname === '/__scenario') { scenario = url.searchParams.get('name'); return send(200, { scenario }); }
  if (url.pathname === '/__pushes') return send(200, pushes);
  if (url.pathname === '/__calls') return send(200, calls);
  if (url.pathname === '/__sub') return send(200, sub);
  if (url.pathname.startsWith('/push/')) {
    try {
      pushes.push({ headers: { auth: req.headers.authorization?.slice(0, 30), enc: req.headers['content-encoding'], ttl: req.headers.ttl, urgency: req.headers.urgency }, payload: await decrypt(new Uint8Array(body)) });
      return send(201, {});
    } catch (err) {
      pushes.push({ error: String(err) });
      return send(400, { error: String(err) });
    }
  }
  calls.push(`${url.pathname}?${[...url.searchParams].filter(([k]) => k !== 'api_key').map(([k, v]) => `${k}=${v}`).join('&')}`);
  const q = url.searchParams;
  const ag = q.get('agency') ?? q.get('operatorref');
  let data;
  if (url.pathname === '/servicealerts') data = fixture(`alerts-${ag}.json`) ?? { header: { gtfsRealtimeVersion: '2.0' }, entity: [] };
  else if (url.pathname === '/tripupdates') data = fixture(`tripupdates-${ag}.json`) ?? { header: { gtfsRealtimeVersion: '2.0' }, entity: [] };
  else if (url.pathname === '/StopMonitoring') data = fixture(`stopmonitoring-${ag}-${q.get('stopcode')}.json`) ?? {};
  else if (url.pathname === '/stoptimetable') data = fixture(`stoptimetable-${ag}-${q.get('monitoringref')}.json`) ?? {};
  else return send(404, { error: 'unknown' });
  if (data.error) return send(500, { error: data.error });
  if (url.pathname === '/servicealerts' || url.pathname === '/tripupdates') {
    data.header ??= { gtfsRealtimeVersion: '2.0' };
    return send(200, Buffer.from(FeedMessage.encode(FeedMessage.fromObject(data)).finish()), 'application/octet-stream');
  }
  // 511 prefixes its JSON with a BOM; keep that quirk.
  return send(200, '﻿' + JSON.stringify(data), 'application/json');
}).listen(8788, '127.0.0.1', () => console.log('mock 511 + push on :8788'));
