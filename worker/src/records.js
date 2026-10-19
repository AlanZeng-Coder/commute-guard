// Check results: Claude's verdicts (POSTed by the routine) and the Worker's own rule-based
// result when Claude didn't answer in time. Both are stored per commute day and pushed alike.

import { DEFAULT_NOTIFY, LEVELS, MODES, checkByMode } from '../../shared/schedule.mjs';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const LEVEL_EMOJI = { green: '🟢', yellow: '🟡', red: '🔴', skip: '⚪' };

export function validRecord(r) {
  if (!MODES.includes(r?.mode)) return `mode must be one of ${MODES.join('/')}`;
  if (!DATE_RE.test(r.targetDate ?? '')) return 'targetDate must be YYYY-MM-DD';
  if (!LEVELS.includes(r.level)) return `level must be one of ${LEVELS.join('/')}`;
  if (!String(r.headline ?? '').trim()) return 'headline is required';
  return null;
}

/**
 * Store a result; a later result for the same check replaces the earlier one — except that the
 * Worker's automatic result never replaces Claude's. Returns false when nothing was saved.
 */
export async function saveRecord(store, record) {
  const existing = await store.checks(record.targetDate);
  if (record.auto && existing.some((r) => r.mode === record.mode && !r.auto)) return false;
  const list = existing.filter((r) => r.mode !== record.mode);
  list.push(record);
  list.sort((a, b) => MODES.indexOf(a.mode) - MODES.indexOf(b.mode));
  await store.putChecks(record.targetDate, list);
  return true;
}

/** Problems always reach the phone; a green result only for the checks the user wants. */
export function shouldPush(record, route) {
  if (record.level === 'skip') return false;
  if (record.mode === 'alert' || record.level !== 'green') return true;
  return ({ ...DEFAULT_NOTIFY, ...route?.notify })[record.mode] !== false;
}

export function recordMessage(record) {
  const check = checkByMode(record.mode);
  const lines = [];
  for (const leg of record.legs ?? []) {
    if (leg.level !== 'green') lines.push(`${LEVEL_EMOJI[leg.level] ?? ''} ${leg.name}：${leg.note}`);
  }
  if (record.planB) lines.push(`Plan B：${record.planB}`);
  lines.push(`${check?.label ?? record.mode}${record.auto ? '（自动检查）' : ''} · ${record.targetDate.slice(5).replace('-', '/')}`);
  return {
    kind: 'check',
    level: record.level,
    title: `${LEVEL_EMOJI[record.level] ?? ''} ${record.headline}`,
    body: lines.join('\n').slice(0, 900),
    dir: record.dir ?? check?.dir ?? null,
    date: record.targetDate,
    tag: `check:${record.targetDate}:${record.mode}`,
    // The night check matters until the morning even if the phone was off overnight.
    ttl: record.mode === 'night' ? 10 * 3600 : 3600,
  };
}

/** The Worker's own result from a digest, sent when the routine didn't post one in time. */
export function autoRecord(digest, why, now = new Date()) {
  const base = { mode: digest.mode, dir: digest.dir, targetDate: digest.targetDate, checkedAt: now.toISOString(), auto: true };
  if (digest.skip) return { ...base, level: 'skip', headline: digest.skip.message };
  const level = digest.suggestedLevel;
  const eta = digest.timing?.eta;
  // Notification titles are short: drop the agency name the digest adds for Claude.
  const short = (text) => text.replace(/（[^）]*）/, '');
  const headline =
    level === 'green'
      ? `没发现问题${eta ? `，预计 ${eta} 到` : ''}`
      : short(digest.reasons[0].replace(/^(?:🔴|🟡) /, ''));
  return {
    ...base,
    level,
    headline: headline.slice(0, 120),
    legs: (digest.legs ?? []).map((l) => {
      const problems = l.flags.filter((f) => f.level !== 'info').map((f) => f.text);
      return {
        name: `${short(l.label)} ${l.depLocal}`,
        level: l.level === 'info' ? 'green' : l.level,
        note: problems.join('；') || '没有发现问题',
      };
    }),
    planB: null,
    details: `Claude 的分析没有按时完成（${why}），这是按规则做的自动检查，没有 Plan B 建议。`,
    sources: [],
    suggestedLevel: level,
    reasons: (digest.reasons ?? []).slice(0, 8),
    errors: (digest.errors ?? []).map((e) => `${e.source}: ${e.message}`).slice(0, 6),
  };
}
