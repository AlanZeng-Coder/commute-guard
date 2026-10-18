// Everything that reaches the phone goes through notify(): it logs the message to the day's
// event list (the app's 「今天的消息」), pushes it to every installed copy of the app (Web
// Push) and, if NTFY_TOPIC is set, to ntfy as a backup channel.

import { openIssues } from '../../checker/lib/issues.mjs';
import { DIRS } from '../../shared/schedule.mjs';
import { pacificDate } from '../../shared/time.mjs';
import { sendPush } from './webpush.js';

const NTFY_PRIORITY = { green: 2, yellow: 3, red: 5 };
const MAX_EVENTS = 80;

export function vapidOf(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_JWK) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateJwk: env.VAPID_PRIVATE_JWK,
    // Apple requires a contact URL or mailto: in the token; the repo page avoids sharing an address.
    subject: env.VAPID_SUBJECT || 'https://github.com/AlanZeng-Coder/commute-guard',
  };
}

/** Open problems across today's trips — shown as the red badge on the app icon. */
export async function openCount(store, date) {
  const watches = await Promise.all(DIRS.map((d) => store.watch(date, d)));
  return watches.reduce((n, w) => n + openIssues(w?.issues).length, 0);
}

async function pushAll(env, store, payload, opts) {
  const vapid = vapidOf(env);
  const subs = await store.subs();
  if (!vapid) return { sent: 0, failed: 0, subscriptions: subs.length, error: 'VAPID keys not set' };
  const results = await Promise.all(
    subs.map((s) => sendPush(s, payload, vapid, opts).catch((err) => ({ ok: false, gone: false, status: 'error', detail: String(err.message) }))),
  );
  const alive = subs.filter((_, i) => !results[i].gone);
  if (alive.length !== subs.length) await store.putSubs(alive);
  const failed = results.filter((r) => !r.ok);
  return {
    sent: results.length - failed.length,
    failed: failed.length,
    removed: subs.length - alive.length,
    subscriptions: alive.length,
    errors: failed.slice(0, 3).map((r) => `${r.status} ${r.detail}`.trim()),
  };
}

async function ntfy(env, msg, click) {
  if (!env.NTFY_TOPIC) return null;
  const res = await fetch(`${env.NTFY_SERVER || 'https://ntfy.sh'}/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      topic: env.NTFY_TOPIC,
      title: msg.title,
      message: msg.body,
      priority: NTFY_PRIORITY[msg.level] ?? 3,
      ...(click ? { click } : {}),
    }),
  }).catch(() => null);
  return res?.ok ? 'sent' : `ntfy ${res?.status ?? 'network error'}`;
}

/**
 * msg: { kind, level, title, body, dir?, date?, tag?, ttl? }
 * kind: issue | worse | resolved | check | test. Returns delivery details for the API caller.
 */
export async function notify(env, store, now, msg, { log = true } = {}) {
  const today = pacificDate(now);
  if (log) {
    const events = await store.events(today);
    events.push({
      at: now.toISOString(),
      kind: msg.kind,
      level: msg.level,
      title: msg.title,
      body: msg.body,
      dir: msg.dir ?? null,
      date: msg.date ?? today,
    });
    await store.putEvents(today, events.slice(-MAX_EVENTS));
  }
  const origin = await store.origin();
  const payload = { title: msg.title, body: msg.body, tag: msg.tag ?? null, badge: await openCount(store, today), url: '/' };
  const [webpush, ntfyResult] = await Promise.all([
    pushAll(env, store, payload, { ttl: msg.ttl ?? 3600, urgency: msg.level === 'green' ? 'normal' : 'high' }),
    ntfy(env, msg, origin),
  ]);
  return { webpush, ntfy: ntfyResult };
}
