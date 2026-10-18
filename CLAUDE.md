# 通勤哨兵 (Commute Guard)

Personal commute alert for one user (Alameda → SF, SF Bay Ferry + Muni). UI text and push messages are Chinese. See README.md for deployment.

## Layout
- `shared/` — ES modules used by Node, the Worker, and the browser: Pacific-time helpers (`time.mjs`), the user's per-weekday schedule → checkpoints / watch windows / the day's trip (`schedule.mjs`), Transitous route planning (`transitous.mjs`). Wrangler's build step copies them to `worker/public/shared/` (gitignored) — never edit the copies.
- `checker/lib/` — the rules, shared by Node and the Worker: `source.mjs` (live 511/NWS, normalized), `gather.mjs` (which calls a mode needs), `analyze.mjs` (digest + arrival estimate), `digest.mjs` (one check end to end), `issues.mjs` (diff problems between polls). `fixtures.mjs` is the Node-only test source.
- `checker/collect.mjs` / `publish.mjs` — run by the Claude routine: `--remote` fetches the digest from the Worker; publish posts the verdict.
- `worker/` — Cloudflare Worker + KV: `monitor.js` is the 5-minute cron (wake the routine at checkpoints, poll 511 during commutes, push new/worse/recovered problems, fallback when Claude doesn't answer, nightly re-plan); `webpush.js` (RFC 8291/8292, no deps); `notify.js`; `status.js` (home screen payload); static PWA in `public/`.
- `routine/PROMPT.md` — what Claude does on each API-triggered run (judgement rules, verdict format).

## Conventions
- All times shown to the user are America/Los_Angeles; use `shared/time.mjs`, never the machine's local zone.
- Transit ids differ between 511 and Transitous by an `AGENCY:` prefix — compare with `idKey()` from `checker/lib/normalize.mjs`.
- 511 rate limit is 60 requests/hour per key, shared by the Worker's watch (~5 calls per poll, every 10 min) and Claude runs (which reuse the watch's snapshot). Don't add per-alternative realtime calls.
- A failed data source must make the affected leg at least yellow, never silently green.

## Commands
- `npm test` — offline tests over `checker/fixtures/*` scenarios.
- `npm run dev` — local Worker on :8787 (needs `worker/.dev.vars`, see `.dev.vars.example`); `node scripts/mock-511.mjs` serves fixture scenarios as fake 511 + a fake push service.
- `node checker/collect.mjs --mode <night|wake|leave|enroute|offwork|alert> [--date D] [--dir morning|evening] [--remote | --fixtures dir] [--now ISO] [--route file]`
- Free-plan Workers get ~10 ms CPU per run: keep one heavy job (511 poll, fallback digest, re-plan) per cron run.
