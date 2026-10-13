import { existsSync, readFileSync } from 'node:fs';

/**
 * Load KEY=VALUE lines from a local .env (for running on the laptop).
 * In the routine's cloud environment these come from the environment settings instead.
 * Existing process.env values win.
 */
export function loadDotEnv(path = '.env') {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    const value = quoted ? quoted[2] : m[2].replace(/(^|\s+)#.*$/, '');
    if (value) process.env[m[1]] = value;
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, inline] = a.slice(2).split('=', 2);
    if (inline !== undefined) args[k] = inline;
    else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args[k] = argv[++i];
    else args[k] = true;
  }
  return args;
}

/** Headers for calls to our own Worker. In the cloud the agent proxy adds the token, so it may be absent. */
export function workerHeaders() {
  const token = process.env.CG_WRITE_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export function workerBase() {
  const base = process.env.CG_BASE_URL;
  if (!base) throw new Error('CG_BASE_URL is not set (e.g. https://commute-guard.<you>.workers.dev)');
  return base.replace(/\/+$/, '');
}
