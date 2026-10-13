# 通勤哨兵 (Commute Guard)

Personal commute alert for one user (Alameda → SF, SF Bay Ferry + Muni). UI text and push messages are Chinese. See README.md for deployment.

## Layout
- `shared/` — ES modules used by Node, the Worker, and the browser: Pacific-time helpers (`time.mjs`), the 4 check times (`schedule.mjs`), Transitous route planning (`transitous.mjs`). Wrangler's build step copies them to `worker/public/shared/` (gitignored) — never edit the copies.
- `checker/` — run by the Claude Code routines. `collect.mjs` (511 + NWS → `checker/out/digest.json`), `publish.mjs` (verdict → Worker). Pure logic lives in `lib/analyze.mjs`; `lib/gather.mjs` decides which upstream calls a mode needs.
- `worker/` — Cloudflare Worker + KV: route/pause/check storage, ntfy push, watchdog cron, static PWA in `public/`.
- `routine/PROMPT.md` — what Claude does on each scheduled run (judgement rules, verdict format).

## Conventions
- All times shown to the user are America/Los_Angeles; use `shared/time.mjs`, never the machine's local zone.
- Transit ids differ between 511 and Transitous by an `AGENCY:` prefix — compare with `idKey()` from `checker/lib/normalize.mjs`.
- 511 rate limit is 60 requests/hour per key; one check makes roughly 8–10 calls. Don't add per-alternative realtime calls.
- A failed data source must make the affected leg at least yellow, never silently green.

## Commands
- `npm test` — offline tests over `checker/fixtures/*` scenarios.
- `npm run dev` — local Worker on :8787 (needs `worker/.dev.vars`, see `.dev.vars.example`).
- `node checker/collect.mjs --mode <night|wake|leave|enroute> [--fixtures dir] [--now ISO] [--route file]`
