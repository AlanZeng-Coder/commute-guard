// Wake the Claude Code routine through its API trigger. The routine reads the parameters from
// the <routine-fire-payload> block (see routine/PROMPT.md), builds the digest from our
// /api/digest, judges it and posts the verdict back to /api/status.
//
// Secrets: ROUTINE_ID (trig_…) and ROUTINE_TOKEN (sk-ant-oat01-…, shown once when the API
// trigger is added on claude.ai). Each fire starts a new cloud session; there is no retry
// here on purpose — a duplicate would just be a second analysis.

const fireUrl = (id) => `https://api.anthropic.com/v1/claude_code/routines/${id}/fire`;

export const routineConfigured = (env) => Boolean(env.ROUTINE_ID && env.ROUTINE_TOKEN);

export async function fireRoutine(env, { mode, date, dir, reason }) {
  if (!routineConfigured(env)) return { ok: false, status: 'not-configured' };
  const text = [`MODE=${mode}`, `DATE=${date}`, `DIR=${dir}`, `REASON=${String(reason ?? '').replace(/\s+/g, ' ').slice(0, 500)}`].join('\n');
  try {
    const res = await fetch(fireUrl(env.ROUTINE_ID), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.ROUTINE_TOKEN}`,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ text }),
    });
    const data = await res.json().catch(() => null);
    if (res.ok) return { ok: true, status: res.status, url: data?.claude_code_session_url ?? null };
    return { ok: false, status: res.status, error: String(data?.error?.message ?? data?.error ?? '').slice(0, 200) };
  } catch (err) {
    return { ok: false, status: 'network', error: String(err?.message ?? err).slice(0, 200) };
  }
}
