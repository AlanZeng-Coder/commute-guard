import assert from 'node:assert/strict';
import { test } from 'node:test';
import { b64url, encryptPayload, generateVapidKeys, vapidAuthorization } from '../src/webpush.js';

// RFC 8291 Appendix A.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

async function rfcServerKeys() {
  const pub = b64url.decode(RFC.asPublic);
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: RFC.asPrivate,
    x: b64url.encode(pub.slice(1, 33)),
    y: b64url.encode(pub.slice(33, 65)),
  };
  const alg = { name: 'ECDH', namedCurve: 'P-256' };
  return {
    privateKey: await crypto.subtle.importKey('jwk', jwk, alg, false, ['deriveBits']),
    publicKey: await crypto.subtle.importKey('raw', pub, alg, true, []),
  };
}

test('push payload encryption matches the RFC 8291 example byte for byte', async () => {
  const body = await encryptPayload(
    RFC.plaintext,
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    { serverKeys: await rfcServerKeys(), salt: b64url.decode(RFC.salt) },
  );
  assert.equal(b64url.encode(body), RFC.body);
});

test('VAPID header carries a JWT the public key verifies', async () => {
  const keys = await generateVapidKeys();
  const header = await vapidAuthorization(
    'https://web.push.apple.com/QGuQyavXutnMH...',
    { ...keys, subject: 'https://example.com' },
    Date.UTC(2026, 9, 20, 13, 0),
  );
  const m = header.match(/^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/);
  assert.ok(m, header);
  const claims = JSON.parse(new TextDecoder().decode(b64url.decode(m[2])));
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: Date.UTC(2026, 9, 20, 13, 0) / 1000 + 12 * 3600, sub: 'https://example.com' });
  assert.equal(m[4], keys.publicKey);
  const pub = await crypto.subtle.importKey('raw', b64url.decode(keys.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    pub,
    b64url.decode(m[3]),
    new TextEncoder().encode(`${m[1]}.${m[2]}`),
  );
  assert.ok(ok);
});
