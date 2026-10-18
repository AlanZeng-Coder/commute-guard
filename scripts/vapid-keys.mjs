#!/usr/bin/env node
// Print a fresh VAPID key pair for Web Push as .env lines (scripts/setup-cloudflare.sh runs this once).
//   node scripts/vapid-keys.mjs >> .env

import { generateVapidKeys } from '../worker/src/webpush.js';

const keys = await generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_JWK=${keys.privateJwk}`);
