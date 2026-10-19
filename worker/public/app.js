import {
  Unauthorized,
  WEEKDAY,
  api,
  askPasscode,
  currentSubscription,
  enablePush,
  esc,
  pushSupport,
  registerSW,
  setBadge,
  subscriptionMatches,
} from './api.js';
import { DIR_LABEL } from './shared/schedule.mjs';
import { addDays, pacificToDate } from './shared/time.mjs';

const app = document.getElementById('app');
const LEVEL = { green: '🟢 正常', yellow: '🟡 注意', red: '🔴 别去', pending: '⏳ 待检查', paused: '⚪ 暂停' };
const EMOJI = { green: '🟢', yellow: '🟡', red: '🔴' };
const RANK = { info: 0, green: 0, yellow: 1, red: 2 };
const ICON = { WALK: '🚶', FERRY: '⛴', TRAM: '🚋', SUBWAY: '🚇', BUS: '🚌', RAIL: '🚆', CABLE_CAR: '🚡' };
const VERB = { morning: '出门', evening: '下班' };
const DEST = { morning: '公司', evening: '家' };
const CHIP = {
  done: (r) => `<span class="chip ${r.level}">${LEVEL[r.level] ?? r.level}</span>`,
  auto: (r) => `<span class="chip ${r.level}">${EMOJI[r.level] ?? ''} 自动</span>`,
  running: () => '<span class="chip">分析中…</span>',
  failed: () => '<span class="chip red">没启动</span>',
  skipped: () => '<span class="chip">跳过</span>',
  paused: () => '<span class="chip">已暂停</span>',
  pending: () => '<span class="chip">待运行</span>',
  missing: () => '<span class="chip red">没有结果！</span>',
  'before-setup': () => '<span class="chip">设置之前</span>',
};

let last = null;
let resubscribed = false;
let loadFailed = false;
// What the latest push said. A status read right after it can predate it (KV is cached at the
// edge for up to a minute), so until the status has caught up the page keeps the push's badge.
let pushed = { badge: null, at: 0 };
{
  const q = new URLSearchParams(location.search);
  if (q.has('pushAt')) {
    pushed = { badge: Number(q.get('pushBadge')), at: Number(q.get('pushAt')) };
    history.replaceState(null, '', location.pathname);
  }
}
const caughtUp = (s) =>
  !pushed.at ||
  Date.parse(s.now.iso) > pushed.at + 70000 ||
  s.events.some((e) => Date.parse(e.at) >= pushed.at - 120000);

const md = (date) => date.slice(5).replace('-', '/');
const clock = (iso) =>
  new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Los_Angeles' });
const shortLeg = (label) => (label ?? '').replace(/（.*?）$/, '');
const levelOf = (list) => list.reduce((l, i) => (RANK[i.level] > RANK[l] ? i.level : l), 'green');

// Judged on this phone's clock, so an old (cached or unreachable) status can't look current.
const windowActive = (seg) => Date.now() >= Date.parse(seg.window.startsAt) && Date.now() <= Date.parse(seg.window.endsAt);
function watchStale(seg) {
  if (!windowActive(seg)) return false;
  return Date.now() - Date.parse(seg.watch?.lastPollAt ?? seg.window.startsAt) > 21 * 60000;
}
const payloadAgeMin = (s) => Math.round((Date.now() - Date.parse(s.now.iso)) / 60000);

function ago(iso) {
  const m = Math.round((Date.now() - new Date(iso)) / 60000);
  if (m < 1) return '刚刚';
  return m < 60 ? `${m} 分钟前` : `${Math.floor(m / 60)} 小时 ${m % 60} 分钟前`;
}

function duration(min) {
  if (min < 60) return `${min} 分钟`;
  return `${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分钟` : ''}`;
}

function dayName(s, date) {
  if (date === s.now.date) return '今天';
  if (date === addDays(s.now.date, 1)) return '明天';
  return '下一个通勤日';
}

function focusSeg(s) {
  const day = s.focus && s.days.find((d) => d.date === s.focus.date);
  return day ? { day, seg: day.dirs[s.focus.dir] } : null;
}

// ---------- focus card ----------

function legStatus(rt) {
  if (!rt) return { cls: '', text: '' };
  if (rt.kind === 'ferry') {
    const next = rt.nextDep ? ` · 下一班 ${rt.nextDep}` : '';
    if (rt.status === 'canceled') return { cls: 'red', text: `已取消${next}` };
    if (rt.status === 'skips-your-stop') return { cls: 'red', text: `不停这站${next}` };
    if (rt.delayMin >= 10) return { cls: rt.delayMin >= 30 ? 'red' : 'yellow', text: `预计晚 ${rt.delayMin} 分钟` };
    if (rt.status === 'tracked') return { cls: 'green', text: rt.delayMin > 0 ? `晚 ${rt.delayMin} 分钟` : '准点' };
    return { cls: '', text: '还没有这班船的实时数据' };
  }
  const next = (rt.upcoming ?? [])
    .map((u) => u.expected)
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
  switch (rt.status) {
    case 'running':
    case 'running-now':
      return { cls: 'green', text: next ? `在跑 · 下一班 ${next}` : '在跑' };
    case 'sparse':
      return { cls: '', text: next ? `下一班 ${next}` : '班次很少' };
    case 'no-predictions':
      return { cls: 'yellow', text: '这条线没有实时班次' };
    case 'no-data':
      return { cls: 'yellow', text: '站点没有数据' };
    case 'too-early':
      return { cls: '', text: '还早，临近时再看' };
    default:
      return { cls: 'yellow', text: '数据出错' };
  }
}

/** The big line: countdown before leaving, ETA once on the way. */
function phase(s, day, seg) {
  const w = seg.watch;
  // A watch with no ETA means a leg is down: don't show the timetable arrival as if it were live.
  const etaUnknown = w?.timing && !w.timing.eta;
  const arrive = etaUnknown ? '到达时间没法估计（有一段走不通）' : `预计 ${w?.timing?.eta ?? seg.plan.endLocal} 到${DEST[seg.dir]}`;
  const leaveIn = Math.round((pacificToDate(day.date, seg.leaveAt) - Date.now()) / 60000);
  const late = w?.timing?.lateMin > 0 ? `，比要求晚 ${w.timing.lateMin} 分钟` : '';
  const by = seg.arriveBy ? `（要求 ${seg.arriveBy} 前）` : '';
  if (day.paused) return { big: '这天已暂停', sub: '请假/放假：不检查，也不推送' };
  if (leaveIn > 0) {
    return {
      big: leaveIn > 180 ? `${dayName(s, day.date)} ${seg.leaveAt} ${VERB[seg.dir]}` : `距${VERB[seg.dir]}还有 ${duration(leaveIn)}`,
      sub: `${seg.leaveAt} ${VERB[seg.dir]} · ${arrive}${by}${late}`,
    };
  }
  return { big: `在路上 · ${arrive}`, sub: `${seg.leaveAt} ${VERB[seg.dir]}${by}${late}` };
}

function focusCard(s) {
  const f = focusSeg(s);
  if (!f?.seg) return '';
  const { day, seg } = f;
  const w = seg.watch;
  const issues = w?.issues ?? [];
  const record = day.latest && (day.latest.dir ?? 'morning') === seg.dir ? day.latest : null;
  // The worse of the watch (rules, realtime) and Claude's latest verdict (which also reads the
  // news and the weather the watch doesn't).
  // A verdict older than the watch's last change (e.g. a recovery it has pushed since) no longer counts.
  const counts = record && (issues.length || !w?.lastEventAt || record.checkedAt >= w.lastEventAt);
  const judged = [...issues, ...(w ? [{ level: w.level }] : []), ...(counts ? [{ level: record.level }] : [])];
  const level = day.paused ? 'paused' : judged.length ? levelOf(judged) : 'pending';
  const ph = phase(s, day, seg);
  const legs = seg.plan.legs
    .map((l, i) => {
      const st = legStatus(w?.legs?.[i]?.realtime);
      return `<li><span class="t">${esc(l.depLocal)}</span><span class="ic">${ICON[l.mode] ?? '🚍'}</span>
        <div class="body"><b>${esc(l.route ?? '')}</b> ${esc(l.from)} → ${esc(l.to)}
        ${st.text ? `<div class="small st ${st.cls}">${esc(st.text)}</div>` : ''}</div></li>`;
    })
    .join('');
  const issueList = issues.length
    ? `<ul class="issues">${issues
        .map(
          (i) =>
            `<li class="${i.level}">${EMOJI[i.level]} <b>${esc(shortLeg(i.leg) || '整趟')}</b>：${esc(i.text)} <span class="muted small">${clock(i.since)} 发现</span></li>`,
        )
        .join('')}</ul>`
    : '';
  const stale = watchStale(seg);
  let watchLine;
  if (w) watchLine = `${stale ? '⚠️ ' : ''}最后检查 ${ago(w.lastPollAt)} · 通勤时每 10 分钟查一次`;
  else if (windowActive(seg)) watchLine = '马上开始检查…';
  else watchLine = `${seg.window.start} 开始每 10 分钟查一次`;
  return `
    <section class="card focus ${level}">
      <div class="row small"><span class="muted">${dayName(s, day.date)} · ${WEEKDAY[day.weekday]} ${md(day.date)} · ${DIR_LABEL[seg.dir]}</span>
        <span class="spacer"></span><span class="chip ${level}">${LEVEL[level] ?? level}</span></div>
      <div class="big" id="focus-big">${esc(ph.big)}</div>
      <div class="small muted" id="focus-sub">${esc(ph.sub)}</div>
      ${issueList}
      <ul class="trip">${legs}</ul>
      <div class="row small foot"><span class="${stale ? 'warn' : 'muted'}">${watchLine}</span><span class="spacer"></span>
        ${day.date === s.now.date && !day.paused ? '<button id="check-now" class="ghost">立即检查</button>' : ''}</div>
    </section>`;
}

// ---------- other cards ----------

function verdictCard(r) {
  if (!r) return '';
  const legs = (r.legs ?? [])
    .map(
      (l) =>
        `<li><span class="chip ${l.level}">${LEVEL[l.level] ?? l.level}</span> <b>${esc(l.name)}</b><div class="small">${esc(l.note)}</div></li>`,
    )
    .join('');
  const label = r.mode === 'alert' ? '突发分析' : (last?.days.flatMap((d) => d.checkpoints).find((c) => c.mode === r.mode)?.label ?? '');
  return `
    <section class="card verdict ${r.level}">
      <div class="row"><div class="level">${LEVEL[r.level] ?? r.level}</div><span class="spacer"></span>
        <span class="small muted">${r.auto ? '自动检查' : 'Claude'} · ${esc(label)} · ${clock(r.checkedAt)}</span></div>
      <div class="headline">${esc(r.headline)}</div>
      ${legs ? `<ul class="legs">${legs}</ul>` : ''}
      ${r.planB ? `<div class="planb"><b>Plan B：</b>${esc(r.planB)}</div>` : ''}
      ${r.details ? `<details class="small" style="margin-top:10px"><summary>判断依据</summary><p>${esc(r.details)}</p></details>` : ''}
      ${
        r.sources?.length
          ? `<p class="small">${r.sources.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title ?? x.url)}</a>`).join(' · ')}</p>`
          : ''
      }
    </section>`;
}

function eventsCard(s) {
  if (!s.events.length) return '';
  const items = s.events
    .slice(0, 12)
    .map(
      (e) => `<li class="${e.level}"><div class="time">${clock(e.at)}</div><div class="body"><b>${esc(e.title)}</b>
        <div class="small muted pre">${esc(e.body)}</div></div></li>`,
    )
    .join('');
  return `<section class="card"><h2>今天的通知</h2><ul class="events">${items}</ul></section>`;
}

function timelineCard(s) {
  const f = focusSeg(s);
  if (!f) return '';
  const items = f.day.checkpoints
    .map((t) => {
      const when = t.runDate === f.day.date ? t.time : `前一晚 ${t.time}`;
      const rec = t.record && t.status !== 'skipped' ? `<div class="small">${esc(t.record.headline)}</div>` : '';
      return `<li><div class="time">${when}</div><div class="body"><b>${t.label}</b> <span class="muted small">${t.question}</span>${rec}</div>${CHIP[t.status](t.record)}</li>`;
    })
    .join('');
  return `<section class="card"><h2>${dayName(s, f.day.date)}的检查</h2><ul class="timeline">${items}</ul></section>`;
}

/** The other trip of the focus day (or the next day's morning), one line each. */
function laterCard(s) {
  const f = focusSeg(s);
  const rows = [];
  for (const day of s.days) {
    if (day.paused) continue;
    for (const seg of Object.values(day.dirs)) {
      if (!seg || (day.date === f?.day.date && seg.dir === f?.seg?.dir)) continue;
      if (new Date(seg.window.endsAt) < new Date(s.now.iso)) continue;
      const issues = seg.watch?.issues ?? [];
      rows.push(`<li><b>${dayName(s, day.date)} ${DIR_LABEL[seg.dir]}</b> ${seg.leaveAt} ${VERB[seg.dir]} · ${esc(seg.plan.summary)} · ${seg.plan.endLocal} 到
        ${issues.length ? `<span class="chip ${levelOf(issues)}">${issues.length} 个问题</span>` : ''}</li>`);
    }
  }
  return rows.length ? `<section class="card"><h2>接下来</h2><ul class="plain">${rows.slice(0, 2).join('')}</ul></section>` : '';
}

function notifyCard(s, state) {
  if (!s.configured.push) {
    return `<section class="card"><h2>通知</h2><p class="small">服务器还没配置推送密钥（VAPID），先按 README 运行部署脚本。</p></section>`;
  }
  if (state === 'needs-install') {
    return `<section class="card notice"><h2>📲 先把通勤哨兵装到主屏幕</h2>
      <p class="small">iPhone 只允许主屏幕上的 App 发通知：在 Safari 底部点 <b>分享</b> → <b>添加到主屏幕</b>，然后<b>从主屏幕的图标打开</b>，回到这里点「开启通知」。</p></section>`;
  }
  if (state === 'unsupported') return `<section class="card"><h2>通知</h2><p class="small">这个浏览器不支持推送通知。iPhone 需要 iOS 16.4 以上。</p></section>`;
  if (state === 'denied') {
    return `<section class="card notice"><h2>🔕 通知被关掉了</h2><p class="small">到 iPhone「设置 → 通知 → 通勤哨兵」打开「允许通知」，再回来刷新。</p></section>`;
  }
  if (state === 'default' || !s.push.subscriptions || (mySub && !s.push.endpoints.includes(mySub))) {
    return `<section class="card notice"><h2>🔔 开启通知</h2>
      <p class="small">路线出问题时马上提醒你，问题解决了也会告诉你。</p>
      <div class="row"><button class="primary" id="enable-push">开启通知</button><span id="push-msg" class="small muted"></span></div></section>`;
  }
  return '';
}

function actionsCard(s, state) {
  const f = focusSeg(s);
  if (!s.route) return '';
  const date = f?.day.date;
  const resume = s.pause.dates
    .map((d) => `<button data-resume="${d}">恢复 ${md(d)}（${WEEKDAY[new Date(`${d}T12:00:00Z`).getUTCDay()]}）的检查</button>`)
    .join('');
  return `
    <section class="card">
      <h2>操作</h2>
      <div class="row">
        ${date ? `<button id="toggle-pause" data-date="${date}">${md(date)} 请假 / 暂停</button>` : ''}
        ${resume}
        ${s.configured.routine ? '<button id="analyze">让 Claude 看一下</button>' : ''}
        ${state === 'granted' && s.push.subscriptions ? '<button id="test-push">测试通知</button>' : ''}
      </div>
      <p id="msg" class="small muted"></p>
      <p class="small muted">
        ${state === 'granted' && s.push.subscriptions ? '🔔 通知已开启。' : ''}
        ${s.configured.routine ? '' : 'Claude 分析还没接上：现在推送的是自动检查结果。'}
        ${s.configured.data511 ? '' : '⚠️ 服务器还没有 511 token，查不了实时数据。'}
        ${pushFailing(s) ? '⚠️ 最近的通知没发到这台手机上：点上面的「测试通知」，或到 iPhone 设置里确认允许通知。' : ''}
      </p>
    </section>`;
}

function banners(s) {
  const f = focusSeg(s);
  const out = [];
  const missing = (f?.day.checkpoints ?? []).filter((t) => t.status === 'missing' || t.status === 'failed');
  if (missing.length) {
    out.push(
      `⚠️ ${missing.map((t) => `${t.label}（${t.time}）`).join('、')}没有结果。没消息≠没问题，出门前请自己看一眼 511 / Ferry / Muni 公告。`,
    );
  }
  if (f?.seg && watchStale(f.seg)) out.push('⚠️ 已经 20 分钟以上没有检查了，系统可能出问题：请自己看一眼 511。');
  if (loadFailed || payloadAgeMin(s) > 3) {
    out.push(`⚠️ 没连上服务器：显示的是 ${s.now.time} 的数据，可能不是最新的。出门前请自己看一眼 511。`);
  }
  const html = out.map((t) => `<div class="banner red">${esc(t)}</div>`).join('');
  return caughtUp(s) ? html : `${html}<div class="banner info">刚收到新通知，页面数据还在更新（最多约 1 分钟）…</div>`;
}

// ---------- page ----------

function render(s) {
  last = s;
  const fs = focusSeg(s);
  shownStale = fs?.seg ? watchStale(fs.seg) : false;
  const state = pushSupport();
  const issues = s.days.flatMap((d) => Object.values(d.dirs).flatMap((x) => x?.watch?.issues ?? []));
  // An old or offline status must not overwrite the badge a newer push set.
  if (!caughtUp(s)) {
    if (pushed.badge !== null) setBadge(pushed.badge);
  } else if (!loadFailed && payloadAgeMin(s) <= 3) {
    setBadge(issues.length);
    pushed = { badge: null, at: 0 };
  }
  if (!s.route) {
    app.innerHTML = `${notifyCard(s, state)}<section class="card"><h2>开始</h2><p>还没有设置通勤路线和时间。</p><a class="btn primary" href="/setup">去设置</a></section>`;
  } else {
    const f = focusSeg(s);
    const verdict = f?.day.latest;
    app.innerHTML = `
      ${banners(s)}
      ${notifyCard(s, state)}
      ${focusCard(s) || '<section class="card"><p>最近 7 天没有通勤日。</p></section>'}
      ${verdictCard(verdict)}
      ${eventsCard(s)}
      ${timelineCard(s)}
      ${laterCard(s)}
      ${actionsCard(s, state)}
      <p class="small muted" style="text-align:center">更新于 ${esc(s.now.time)}</p>`;
  }
  bind(s);
  // Permission granted but the server doesn't know this phone's subscription (a reset, or new
  // push keys after a redeploy — pushes to the old one fail): subscribe again.
  if (state === 'granted' && s.configured.push && !resubscribed) {
    currentSubscription()
      .then((sub) => {
        mySub = sub?.endpoint ?? null;
        const ok = sub && s.push.endpoints.includes(sub.endpoint) && subscriptionMatches(sub, s.push.publicKey) && !pushFailing(s, sub.endpoint);
        if (ok) return;
        resubscribed = true;
        return enablePush(s.push.publicKey).then((fresh) => {
          mySub = fresh.endpoint;
          return load();
        });
      })
      .catch(() => {});
  }
}

/** Whether pushes to this phone (or any, before its subscription is known) are failing. */
function pushFailing(s, endpoint = mySub) {
  return (s.push.failing ?? []).some((f) => !endpoint || f.endpoint === endpoint);
}
let mySub = null;
currentSubscription()
  .then((sub) => (mySub = sub?.endpoint ?? null))
  .catch(() => {});

function bind(s) {
  const msg = (t) => {
    const el = document.getElementById('msg');
    if (el) el.textContent = t;
  };
  document.getElementById('enable-push')?.addEventListener('click', async () => {
    const out = document.getElementById('push-msg');
    out.textContent = '请求权限…';
    try {
      mySub = (await enablePush(s.push.publicKey)).endpoint;
      out.textContent = '已开启，正在发测试通知…';
      await api('/api/test-push', { method: 'POST' });
      load();
    } catch (err) {
      out.textContent = err.message;
    }
  });
  // Each button sends the whole list, so all of them wait until the page has reloaded.
  const pauseButtons = [...app.querySelectorAll('#toggle-pause, [data-resume]')];
  const savePause = async (dates) => {
    for (const b of pauseButtons) b.disabled = true;
    await api('/api/pause', { method: 'PUT', body: { dates } }).catch((err) => alert(err.message));
    await load();
  };
  document.getElementById('toggle-pause')?.addEventListener('click', (e) =>
    savePause([...new Set([...s.pause.dates, e.currentTarget.dataset.date])]),
  );
  for (const b of pauseButtons.filter((x) => x.dataset.resume)) {
    b.addEventListener('click', () => savePause(s.pause.dates.filter((d) => d !== b.dataset.resume)));
  }
  document.getElementById('test-push')?.addEventListener('click', async () => {
    msg('发送中…');
    const r = await api('/api/test-push', { method: 'POST' }).catch((e) => ({ error: e.message }));
    const wp = r.pushed?.webpush;
    msg(wp?.sent ? '已发送，看看手机有没有收到' : `没发出去：${r.error ?? wp?.errors?.join('；') ?? wp?.error ?? '未知错误'}`);
  });
  document.getElementById('check-now')?.addEventListener('click', async (e) => {
    e.currentTarget.disabled = true;
    e.currentTarget.textContent = '检查中…';
    const r = await api('/api/check-now', { method: 'POST' }).catch((err) => ({ message: err.message }));
    if (r.message) alert(r.message);
    load();
  });
  document.getElementById('analyze')?.addEventListener('click', async () => {
    msg('正在叫醒 Claude…');
    const r = await api('/api/analyze', { method: 'POST' }).catch((e) => ({ error: e.message }));
    msg(r.ok ? `Claude 开始分析 ${md(r.date)} 的${DIR_LABEL[r.dir]}了，几分钟后会推送结果。` : `没启动：${r.error ?? r.status}`);
  });
}

/** Keep the countdown current between refreshes without redrawing the page. */
let shownStale = false;
function tickClock() {
  const f = last && focusSeg(last);
  if (!f?.seg) return;
  // Redraw when the "no check for 20 minutes" state flips while the page sits open (e.g. a hung request).
  if (watchStale(f.seg) !== shownStale) return render(last);
  const ph = phase(last, f.day, f.seg);
  const big = document.getElementById('focus-big');
  const sub = document.getElementById('focus-sub');
  if (big) big.textContent = ph.big;
  if (sub) sub.textContent = ph.sub;
}

async function load() {
  try {
    const s = await api('/api/status');
    loadFailed = Boolean(s.fromCache);
    render(s);
  } catch (err) {
    if (err instanceof Unauthorized) return askPasscode(app, load);
    loadFailed = true;
    if (last) render(last);
    else app.innerHTML = `<div class="banner red">加载失败：${esc(err.message)}（可能离线）</div>`;
  }
}

document.getElementById('refresh').addEventListener('click', load);
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && load());
// After a push: refresh now, and again a minute later — the status can lag the push by up to
// a minute (KV caches each key at the edge).
navigator.serviceWorker?.addEventListener('message', (e) => {
  if (e.data?.type !== 'refresh') return;
  if (typeof e.data.badge === 'number') pushed = { badge: e.data.badge, at: e.data.at ?? Date.now() };
  load();
  setTimeout(load, 65000);
});
setInterval(() => document.visibilityState === 'visible' && load(), 120000);
setInterval(tickClock, 20000);
registerSW();
load();
