// KV layout (one namespace, binding CG). Dates are Pacific commute dates (YYYY-MM-DD).
//
//   route                      saved route + schedule (shared/schedule.mjs documents the shape)
//   pause                      { dates: [...] } days the user is off
//   plan:<date>:<dir>          the Worker's re-plan of that day's trip (Transitous, the night before)
//   watch:<date>:<dir>         10-minute watch state: open issues, last poll, latest realtime
//   fires:<date>               when the Claude routine was woken for that commute day
//   checks:<date>              results (Claude's, or the Worker's own when Claude didn't answer)
//   pushstate:<date>           whether each result's push got through (the cron retries it)
//   events:<date>              everything pushed to the phone that day, newest last
//   push:subs                  Web Push subscriptions (one per installed app)
//   tt:<date>:<agency>:<stop>  that day's ferry timetable (fetched once a day)
//   use511:<UTC hour>          511 calls made this hour (the key allows 60/hour)
//   meta:origin                the site's URL, for notification links

const DAY = 86400;

export function createStore(kv) {
  const get = async (key, fallback = null) => (await kv.get(key, 'json')) ?? fallback;
  const put = (key, value, ttlDays) =>
    kv.put(key, JSON.stringify(value), ttlDays ? { expirationTtl: ttlDays * DAY } : undefined);
  return {
    get,
    put,
    route: () => get('route'),
    pause: () => get('pause', { dates: [] }),
    plan: (date, dir) => get(`plan:${date}:${dir}`),
    putPlan: (date, dir, plan) => put(`plan:${date}:${dir}`, plan, 3),
    watch: (date, dir) => get(`watch:${date}:${dir}`),
    putWatch: (date, dir, w) => put(`watch:${date}:${dir}`, w, 3),
    fires: (date) => get(`fires:${date}`, { checks: {}, alerts: [] }),
    putFires: (date, f) => put(`fires:${date}`, f, 3),
    checks: (date) => get(`checks:${date}`, []),
    // Delivery of each result's push, kept apart from the results so retries never rewrite them.
    pushStates: (date) => get(`pushstate:${date}`, {}),
    putPushStates: (date, states) => put(`pushstate:${date}`, states, 3),
    putChecks: (date, list) => put(`checks:${date}`, list, 30),
    events: (date) => get(`events:${date}`, []),
    putEvents: (date, list) => put(`events:${date}`, list, 30),
    subs: () => get('push:subs', []),
    putSubs: (list) => put('push:subs', list),
    origin: () => kv.get('meta:origin'),
    used511: async (now) => Number((await kv.get(`use511:${now.toISOString().slice(0, 13)}`)) ?? 0),
    async addUsed511(now, n) {
      if (!n) return;
      const key = `use511:${now.toISOString().slice(0, 13)}`;
      await kv.put(key, String(Number((await kv.get(key)) ?? 0) + n), { expirationTtl: DAY });
    },
  };
}

/** In-memory KV with the same get/put surface, for tests and local scripts. */
export function memoryKV() {
  const map = new Map();
  return {
    map,
    async get(key, type) {
      const v = map.get(key);
      if (v === undefined) return null;
      return type === 'json' ? JSON.parse(v) : v;
    },
    async put(key, value) {
      map.set(key, value);
    },
    async delete(key) {
      map.delete(key);
    },
  };
}
