// Web Push from the Worker with no dependencies, so notifications come from the 通勤哨兵 app
// itself (iOS 16.4+ home-screen web apps, Android, desktop): payload encryption per RFC 8291
// (aes128gcm, RFC 8188) and VAPID authentication per RFC 8292, all with Web Crypto.

const enc = new TextEncoder();

export const b64url = {
  encode(bytes) {
    let s = '';
    for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4));
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
  },
};

const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

const RECORD_SIZE = 4096;

/**
 * Encrypt one push message for a subscription's keys ({ p256dh, auth }, base64url).
 * `serverKeys` and `salt` are random per message; tests pass fixed ones.
 */
export async function encryptPayload(plaintext, { p256dh, auth }, { serverKeys, salt } = {}) {
  const uaPublic = b64url.decode(p256dh);
  const authSecret = b64url.decode(auth);
  serverKeys ??= await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  salt ??= crypto.getRandomValues(new Uint8Array(16));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', serverKeys.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, serverKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const body = typeof plaintext === 'string' ? enc.encode(plaintext) : plaintext;
  // A single record: content, then the 0x02 "last record" padding delimiter.
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, concat(body, new Uint8Array([2]))));

  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

/** `Authorization` header for one push service (the JWT audience is the endpoint's origin). */
export async function vapidAuthorization(endpoint, { publicKey, privateJwk, subject }, now = Date.now()) {
  const json = (o) => b64url.encode(enc.encode(JSON.stringify(o)));
  const unsigned = `${json({ typ: 'JWT', alg: 'ES256' })}.${json({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 3600,
    sub: subject,
  })}`;
  const jwk = typeof privateJwk === 'string' ? JSON.parse(privateJwk) : privateJwk;
  const key = await crypto.subtle.importKey('jwk', { ...jwk, key_ops: ['sign'] }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(unsigned));
  return `vapid t=${unsigned}.${b64url.encode(sig)}, k=${publicKey}`;
}

/** A fresh VAPID key pair: the public key goes to browsers, the private JWK stays a Worker secret. */
export async function generateVapidKeys() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  return {
    publicKey: b64url.encode(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
  };
}

/**
 * Send one message. `gone` means the subscription is dead (app removed from the home screen,
 * permission revoked) and should be deleted.
 */
export async function sendPush(subscription, payload, vapid, { ttl = 3600, urgency = 'high' } = {}) {
  const body = await encryptPayload(JSON.stringify(payload), subscription.keys);
  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidAuthorization(subscription.endpoint, vapid),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  const detail = res.ok ? '' : (await res.text().catch(() => '')).slice(0, 200);
  return { status: res.status, ok: res.ok, gone: res.status === 404 || res.status === 410, detail };
}
