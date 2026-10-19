// Everything that reaches the phone goes through notify(): it pushes each message to every
// installed copy of the app (Web Push) and, if NTFY_TOPIC is set, to ntfy as a backup channel,
// then logs the batch to the day's event list (the app's 「今天的通知」) in one KV write —
// KV allows one write per second per key, so per-message writes would fail on a busy poll.

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

/**
 * Open problems on today's trips that are still under way — the red badge on the app icon.
 * `override` replaces a direction's stored issues (the poll that is about to save them).
 */
export async function openCount(store, now, override = {}) {
  const date = pacificDate(now);
  if ((await store.pause()).dates.includes(date)) return 0;
  let n = 0;
  for (const dir of DIRS) {
    const w = await store.watch(date, dir);
    if (w?.windowEnd && now > new Date(w.windowEnd)) continue;
    n += openIssues(override[dir] ?? w?.issues).length;
  }
  return n;
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

async function putEvents(store, date, add) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await store.putEvents(date, [...(await store.events(date)), ...add].slice(-MAX_EVENTS));
      return;
    } catch (err) {
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1100));
      else console.error('event log write failed', err);
    }
  }
}

/**
 * msgs: one message or a list of { kind, level, title, body, dir?, date?, tag?, ttl?, badge? }
 * (kind: issue | worse | update | resolved | check | test).
 * Returns one result per message: { delivered, deliverable, webpush, ntfy }. With
 * `logFailed: false`, messages that could have been delivered but weren't are left out of the
 * log — the caller sends them again later.
 */
export async function notify(env, store, now, msgs, { log = true, logFailed = true } = {}) {
  const list = Array.isArray(msgs) ? msgs : [msgs];
  const vapid = vapidOf(env);
  let subs = await store.subs();
  const origin = await store.origin();
  const badge = list.some((m) => m.badge === undefined) ? await openCount(store, now) : null;
  const results = [];
  let subsChanged = false;

  for (const msg of list) {
    const payload = { title: msg.title, body: msg.body, tag: msg.tag ?? null, badge: msg.badge ?? badge, url: '/' };
    const opts = { ttl: msg.ttl ?? 3600, urgency: msg.level === 'green' ? 'normal' : 'high' };
    const sent = vapid
      ? await Promise.all(
          subs.map((s) => sendPush(s, payload, vapid, opts).catch((err) => ({ ok: false, gone: false, status: 'error', detail: String(err.message) }))),
        )
      : [];
    subs = subs
      .map((s, i) => {
        const r = sent[i];
        if (!r) return s;
        const fails = r.ok ? 0 : (s.fails ?? 0) + 1;
        if (fails !== (s.fails ?? 0)) subsChanged = true;
        return { ...s, fails, lastError: r.ok ? null : `${r.status} ${r.detail}`.trim() };
      })
      // Only the push service saying the subscription is gone (404/410) removes it. Other failures
      // (an outage, an old VAPID key) are counted and shown in the app, and the message is retried.
      .filter((s, i) => {
        if (sent[i]?.gone) subsChanged = true;
        return !sent[i]?.gone;
      });
    const ntfyResult = await ntfy(env, msg, origin);
    const ok = sent.filter((r) => r.ok).length;
    results.push({
      delivered: ok > 0 || ntfyResult === 'sent',
      deliverable: Boolean((vapid && sent.length) || env.NTFY_TOPIC),
      webpush: {
        sent: ok,
        failed: sent.length - ok,
        subscriptions: subs.length,
        errors: sent.filter((r) => !r.ok).slice(0, 3).map((r) => `${r.status} ${r.detail}`.trim()),
        ...(vapid ? {} : { error: 'VAPID keys not set' }),
      },
      ntfy: ntfyResult,
    });
  }
  // Failure counts are bookkeeping: a write conflict must not fail the delivery that already happened.
  if (subsChanged) await store.putSubs(subs).catch((err) => console.error('subs write failed', err));

  if (log) {
    const today = pacificDate(now);
    const add = list
      .map((msg, i) => ({ msg, r: results[i] }))
      .filter(({ r }) => logFailed || r.delivered || !r.deliverable)
      .map(({ msg, r }) => ({
        at: now.toISOString(),
        kind: msg.kind,
        level: msg.level,
        title: msg.title,
        body: msg.body,
        dir: msg.dir ?? null,
        date: msg.date ?? today,
        delivered: r.delivered,
      }));
    if (add.length) await putEvents(store, today, add);
  }
  return Array.isArray(msgs) ? results : results[0];
}
