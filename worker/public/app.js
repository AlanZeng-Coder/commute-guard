import { api, askPasscode, esc, registerSW, Unauthorized, WEEKDAY } from './api.js';
import { checkByMode } from './shared/schedule.mjs';

const app = document.getElementById('app');
const LEVEL = { green: '🟢 正常', yellow: '🟡 注意', red: '🔴 别去' };
const STATUS_CHIP = {
  done: (r) => `<span class="chip ${r.level}">${LEVEL[r.level] ?? r.level}</span>`,
  skipped: () => '<span class="chip">跳过</span>',
  paused: () => '<span class="chip">已暂停</span>',
  pending: () => '<span class="chip">待运行</span>',
  missing: () => '<span class="chip red">没有运行！</span>',
};

function dayLabel(s) {
  const rel = s.focusDate === s.now.date ? '今天' : '下一个通勤日';
  return `${rel} · ${s.focusDate.slice(5).replace('-', '/')} ${WEEKDAY[s.focusWeekday]}`;
}

function verdictCard(r) {
  if (!r) return '';
  const legs = (r.legs ?? [])
    .map(
      (l) =>
        `<li><span class="chip ${l.level}">${LEVEL[l.level] ?? l.level}</span> <b>${esc(l.name)}</b><div class="small">${esc(l.note)}</div></li>`,
    )
    .join('');
  const time = new Date(r.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
  return `
    <section class="card verdict ${r.level}">
      <div class="row"><div class="level">${LEVEL[r.level] ?? r.level}</div><span class="spacer"></span>
        <span class="small muted">${esc(checkByMode(r.mode)?.label ?? '')} · ${time}</span></div>
      <div class="headline">${esc(r.headline)}</div>
      ${legs ? `<ul class="legs">${legs}</ul>` : ''}
      ${r.planB ? `<div class="planb"><b>Plan B：</b>${esc(r.planB)}</div>` : ''}
      ${r.details ? `<details class="small" style="margin-top:10px"><summary>详情</summary><p>${esc(r.details)}</p></details>` : ''}
      ${
        r.sources?.length
          ? `<p class="small">${r.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title ?? s.url)}</a>`).join(' · ')}</p>`
          : ''
      }
    </section>`;
}

function timelineCard(s) {
  const items = s.timeline
    .map((t) => {
      const when = t.runDate === s.focusDate ? t.time : `前一晚 ${t.time}`;
      const rec = t.record && t.status === 'done' ? `<div class="small">${esc(t.record.headline)}</div>` : '';
      return `<li><div class="time">${when}</div><div class="body"><b>${t.label}</b> <span class="muted small">${t.question}</span>${rec}</div>${STATUS_CHIP[t.status](t.record)}</li>`;
    })
    .join('');
  return `<section class="card"><h2>检查时间线</h2><ul class="timeline">${items}</ul></section>`;
}

function routeCard(s) {
  if (!s.route) {
    return `<section class="card"><h2>路线</h2><p>还没有设置通勤路线。</p><a class="btn primary" href="/setup">去设置路线</a></section>`;
  }
  const r = s.route;
  const pauseBtn = s.paused ? '恢复这天的检查' : '这天请假 / 暂停检查';
  const others = s.pause.dates.filter((d) => d !== s.focusDate);
  return `
    <section class="card">
      <h2>我的路线</h2>
      <div><b>${esc(r.summary)}</b></div>
      <div class="small muted">${esc(r.startLocal)} 出门 → ${esc(r.endLocal)} 到 · ${esc(r.home ?? '')} → ${esc(r.work ?? '')}</div>
      <div class="row" style="margin-top:12px">
        <button id="toggle-pause">${pauseBtn}</button>
        <button id="test-push">发送测试通知</button>
      </div>
      ${others.length ? `<p class="small muted">其他已暂停：${others.map(esc).join('、')}</p>` : ''}
      <p id="msg" class="small muted"></p>
    </section>`;
}

function render(s) {
  const missing = s.timeline.filter((t) => t.status === 'missing');
  const banner = missing.length
    ? `<div class="banner red">⚠️ ${missing.map((t) => `${t.label}（${t.time}）`).join('、')}没有运行。没消息≠没问题，出门前请自己看一眼 511 / Ferry / Muni 公告。</div>`
    : '';
  const noResult =
    !s.latest && s.route
      ? `<section class="card"><p>${s.paused ? '这天已暂停检查。' : '这一天还没有检查结果。'}</p>${
          s.paused ? '' : `<p class="small muted">下一次检查：${esc(s.timeline.find((t) => t.status === 'pending')?.label ?? '—')}</p>`
        }</section>`
      : '';
  app.innerHTML = `
    <p class="muted" style="margin:0 0 10px">${dayLabel(s)}</p>
    ${banner}
    ${verdictCard(s.latest)}
    ${noResult}
    ${timelineCard(s)}
    ${routeCard(s)}
    <p class="small muted" style="text-align:center">更新于 ${esc(s.now.time)}</p>`;

  document.getElementById('toggle-pause')?.addEventListener('click', async () => {
    const dates = s.paused ? s.pause.dates.filter((d) => d !== s.focusDate) : [...s.pause.dates, s.focusDate];
    await api('/api/pause', { method: 'PUT', body: { dates } });
    load();
  });
  document.getElementById('test-push')?.addEventListener('click', async () => {
    const msg = document.getElementById('msg');
    msg.textContent = '发送中…';
    const r = await api('/api/test-push', { method: 'POST' }).catch((e) => ({ pushed: e.message }));
    msg.textContent = r.pushed === 'sent' ? '已发送，看看手机的 ntfy 有没有收到' : `没发出去：${r.pushed}`;
  });
}

async function load() {
  try {
    render(await api('/api/status'));
  } catch (err) {
    if (err instanceof Unauthorized) askPasscode(app, load);
    else app.innerHTML = `<div class="banner red">加载失败：${esc(err.message)}（可能离线）</div>`;
  }
}

document.getElementById('refresh').addEventListener('click', load);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
registerSW();
load();
