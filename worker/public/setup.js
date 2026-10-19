import { Unauthorized, WEEKDAY, api, askPasscode, esc, registerSW } from './api.js';
import { CHECKS, DEFAULT_NOTIFY, DEFAULT_SCHEDULE, HHMM, preferredBoarding, toMin } from './shared/schedule.mjs';
import { addDays, pacificDate, weekdayOf } from './shared/time.mjs';
import { geocode, nearbyFerryTerminals, patternOf, planDay, planOptionsDetailed } from './shared/transitous.mjs';

const app = document.getElementById('app');
const ICON = { WALK: '🚶', FERRY: '⛴', TRAM: '🚋', SUBWAY: '🚇', BUS: '🚌', RAIL: '🚆', CABLE_CAR: '🚡' };
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];
const DIR = {
  morning: { title: '去程：家 → 公司', field: 'leaveHome', verb: '出门', dest: '到公司' },
  evening: { title: '回程：公司 → 家', field: 'leaveWork', verb: '下班', dest: '到家' },
};

// The browser sends a Referer, which Transitous accepts in place of a User-Agent.
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Transitous HTTP ${res.status}`);
  return res.json();
}

const clone = (o) => JSON.parse(JSON.stringify(o));
const state = {
  home: null,
  work: null,
  terminals: [],
  schedule: clone(DEFAULT_SCHEDULE),
  notify: { ...DEFAULT_NOTIFY },
  morning: null,
  evening: null,
  choosing: { morning: null, evening: null }, // { time, date, options, picked }
  saved: false,
  planning: 0, // bumped when the addresses change, so a plan still in flight is discarded
};

// ---------- schedule helpers ----------

const days = () => state.schedule.days;
const timesFor = (dir) => [...new Set(DAY_ORDER.map((d) => days()[d]?.[DIR[dir].field]).filter((t) => HHMM.test(t ?? '')))];

/** The next date (from tomorrow) whose weekday uses `time` for `dir` — Transitous plans real dates. */
function dateFor(dir, time) {
  for (let i = 1; i <= 7; i++) {
    const date = addDays(pacificDate(), i);
    if (days()[weekdayOf(date)]?.[DIR[dir].field] === time) return date;
  }
  return addDays(pacificDate(), 1);
}

/** Terminals near home: walked to in the morning, walked home from in the evening. */
function endpoints(dir) {
  if (dir === 'morning') return { from: state.home, to: state.work, terminals: state.terminals, terminalSide: 'from' };
  return { from: state.work, to: state.home, terminals: state.terminals, terminalSide: 'to' };
}

// ---------- rendering ----------

function legLine(l) {
  if (!l.transit) return `${ICON[l.mode] ?? '·'} ${l.depLocal} 步行 ${l.durationMin} 分钟 → ${esc(l.to.name || '目的地')}`;
  return `${ICON[l.mode] ?? '🚍'} ${l.depLocal} <b>${esc(l.routeShortName ?? '')}</b> ${esc(l.agencyName ?? '')}：${esc(l.from.name)} → ${esc(l.to.name)}（${l.arrLocal} 到）`;
}

const boardLine = (it) => {
  const first = it.legs.find((l) => l.transit && l.mode === 'FERRY') ?? it.legs.find((l) => l.transit);
  return first ? `${ICON[first.mode] ?? '🚍'} ${first.depLocal} ${esc(first.routeShortName ?? '')}` : '';
};

function addressCard() {
  return `
    <section class="card" id="addr">
      <h2>1 · 家和公司</h2>
      <label for="home-q">家地址</label>
      <form class="row" data-target="home"><input id="home-q" placeholder="例如 1600 Webster St, Alameda" style="flex:1" value="${esc(state.home?.label ?? '')}" /><button>查找</button></form>
      <ul class="suggestions hidden" id="home-list"></ul>
      <div class="picked" id="home-picked">${state.home ? `✓ ${esc(state.home.label)}` : ''}</div>
      <label for="work-q">公司地址</label>
      <form class="row" data-target="work"><input id="work-q" placeholder="例如 1 Market St, San Francisco" style="flex:1" value="${esc(state.work?.label ?? '')}" /><button>查找</button></form>
      <ul class="suggestions hidden" id="work-list"></ul>
      <div class="picked" id="work-picked">${state.work ? `✓ ${esc(state.work.label)}` : ''}</div>
    </section>`;
}

function timesCard() {
  const rows = DAY_ORDER.map((d) => {
    const t = days()[d];
    const on = Boolean(t);
    const input = (field, value) =>
      `<input type="time" data-day="${d}" data-field="${field}" value="${esc(value ?? '')}" ${on ? '' : 'disabled'} />`;
    return `<div class="sched-row ${on ? '' : 'off'}">
      <label class="day"><input type="checkbox" data-day="${d}" data-field="on" ${on ? 'checked' : ''} />${WEEKDAY[d]}</label>
      ${input('leaveHome', t?.leaveHome)}${input('arriveBy', t?.arriveBy)}${input('leaveWork', t?.leaveWork)}</div>`;
  }).join('');
  return `
    <section class="card" id="times">
      <h2>2 · 每天的时间</h2>
      <p class="small muted">勾上要通勤的日子。「最晚到」用来提醒你会不会迟到；「下班」不填就不检查回程。</p>
      <div class="sched-row head"><span></span><span>出门</span><span>最晚到</span><span>下班</span></div>
      ${rows}
      <div class="row" style="margin-top:10px">
        <button id="copy-monday">把周一的时间复制到周二–周五</button>
      </div>
      <div class="grid2"><div><label for="night">睡前检查时间</label><input id="night" type="time" value="${esc(state.schedule.nightCheck ?? '21:30')}" /></div></div>
      <p class="small muted">睡前检查要在 12:00 之后；设成 00:00–03:59 就是过了午夜、当天凌晨再查。</p>
    </section>`;
}

/** Per-day trips for a direction, as saved (or still to be planned). */
function dayTable(dir) {
  const set = state[dir];
  const rows = DAY_ORDER.filter((d) => days()[d]).map((d) => {
    const t = days()[d];
    const time = t[DIR[dir].field];
    if (!HHMM.test(time ?? '')) return `<li><b>${WEEKDAY[d]}</b> <span class="muted">没填${DIR[dir].verb}时间，不检查</span></li>`;
    const plan = set?.byTime?.[time];
    if (!plan) return `<li><b>${WEEKDAY[d]}</b> ${time} ${DIR[dir].verb} · <span class="muted">保存时自动排班次</span></li>`;
    const it = plan.primary;
    const warn = [];
    if (patternOf(it) !== set.pattern) warn.push('⚠️ 这个时间没有同样的走法，换成了这条');
    if (dir === 'morning' && t.arriveBy && toMin(it.endLocal) > toMin(t.arriveBy)) warn.push(`⚠️ ${it.endLocal} 才到，晚于 ${t.arriveBy}`);
    return `<li><b>${WEEKDAY[d]}</b> ${time} ${DIR[dir].verb} → ${boardLine(it)} → ${it.endLocal} ${DIR[dir].dest}
      ${warn.length ? `<div class="small warn">${warn.join('；')}</div>` : ''}</li>`;
  });
  return rows.length ? `<ul class="plain">${rows.join('')}</ul>` : '<p class="small muted">先在上面勾选通勤日。</p>';
}

function dirCard(dir, n) {
  const set = state[dir];
  const ch = state.choosing[dir];
  const current = set ? Object.values(set.byTime)[0]?.primary : null;
  const needs = dir === 'evening' && !timesFor('evening').length;
  let body;
  if (needs) body = '<p class="small muted">没有填「下班」时间，不检查回程。</p>';
  else if (ch?.options) {
    body = `
      <p class="small muted">按 ${ch.date.slice(5)}（${WEEKDAY[weekdayOf(ch.date)]}）${ch.time} ${DIR[dir].verb}查到的方案。选你实际走的那条；其余存为 Plan B 备选。</p>
      ${ch.options
        .map(
          (o, i) => `
        <div class="option ${i === ch.picked ? 'sel' : ''}" data-dir="${dir}" data-i="${i}">
          <div class="row"><span class="sum">${esc(o.summary)}</span>${o.hasFerry ? '<span class="chip green">渡轮</span>' : ''}<span class="spacer"></span>
            <span class="small muted">${o.startLocal} → ${o.endLocal} · ${o.durationMin} 分钟</span></div>
          <ol>${o.legs.map((l) => `<li>${legLine(l)}</li>`).join('')}</ol>
        </div>`,
        )
        .join('')}
      <div class="row"><button class="primary" data-use="${dir}">用这条路线</button><button data-cancel="${dir}">取消</button></div>`;
  } else {
    body = `
      ${current ? `<div><b>${esc(current.summary)}</b> <span class="small muted">每天按你的时间自动排班次</span></div>${dayTable(dir)}` : '<p class="small muted">还没有选。</p>'}
      <div class="row" style="margin-top:10px"><button class="${current ? '' : 'primary'}" data-choose="${dir}">${current ? '换一条路线' : '查找路线'}</button>
        ${dir === 'evening' && current ? '<button data-clear="evening">不检查回程</button>' : ''}</div>`;
  }
  return `<section class="card" id="dir-${dir}"><h2>${n} · ${DIR[dir].title}</h2>${body}<p class="small muted" id="msg-${dir}"></p></section>`;
}

function notifyCard() {
  const rows = CHECKS.map(
    (c) => `<label class="check"><input type="checkbox" data-notify="${c.mode}" ${state.notify[c.mode] !== false ? 'checked' : ''} />
      <span><b>${c.label}</b> <span class="muted small">${c.question}</span></span></label>`,
  ).join('');
  return `
    <section class="card" id="notify">
      <h2>5 · 正常时也通知</h2>
      <p class="small muted">有问题、问题恢复、可能迟到，都会<b>马上</b>通知你，不能关。下面勾选的检查在一切正常时也发一条「🟢 正常」。</p>
      ${rows}
    </section>`;
}

function render() {
  app.innerHTML = `
    ${state.saved ? '<div class="banner info">✓ 已保存。之后每天按这些时间检查。</div>' : ''}
    ${addressCard()}
    ${timesCard()}
    ${dirCard('morning', 3)}
    ${dirCard('evening', 4)}
    ${notifyCard()}
    <div class="savebar"><button class="primary" id="save">保存</button><span id="save-msg" class="small muted"></span></div>`;
  bind();
}

function rerender(id, html) {
  const el = document.getElementById(id);
  if (el) el.outerHTML = html;
  bind();
}

/** Any edit after a save: the "已保存" banner would claim unsaved changes are saved. */
function edited() {
  if (!state.saved) return;
  state.saved = false;
  document.querySelector('.banner.info')?.remove();
}

// ---------- events ----------

function bind() {
  app.oninput = edited;
  app.onchange = edited;
  for (const form of app.querySelectorAll('form[data-target]')) form.onsubmit = onSearch;
  for (const el of app.querySelectorAll('#times input')) el.onchange = onTimeChange;
  document.getElementById('copy-monday').onclick = () => {
    const mon = days()[1];
    if (!mon) return;
    edited();
    for (const d of [2, 3, 4, 5]) days()[d] = { ...mon };
    rerender('times', timesCard());
    refreshDirs();
  };
  document.getElementById('night').onchange = (e) => {
    const v = e.target.value;
    if (HHMM.test(v) && (v < '04:00' || v >= '12:00')) state.schedule.nightCheck = v;
    else e.target.value = state.schedule.nightCheck ?? '21:30';
  };
  for (const b of app.querySelectorAll('[data-choose]')) b.onclick = () => onChoose(b.dataset.choose);
  for (const b of app.querySelectorAll('[data-use]')) b.onclick = () => onUse(b.dataset.use);
  for (const b of app.querySelectorAll('[data-cancel]')) {
    b.onclick = () => {
      state.choosing[b.dataset.cancel] = null;
      refreshDirs();
    };
  }
  for (const b of app.querySelectorAll('[data-clear]')) {
    b.onclick = () => {
      edited();
      state.evening = null;
      refreshDirs();
    };
  }
  for (const el of app.querySelectorAll('.option[data-dir]')) {
    el.onclick = () => {
      state.choosing[el.dataset.dir].picked = Number(el.dataset.i);
      refreshDirs();
    };
  }
  for (const el of app.querySelectorAll('[data-notify]')) el.onchange = () => (state.notify[el.dataset.notify] = el.checked);
  document.getElementById('save').onclick = onSave;
}

function refreshDirs() {
  rerender('dir-morning', dirCard('morning', 3));
  rerender('dir-evening', dirCard('evening', 4));
}

function onTimeChange(e) {
  const d = Number(e.target.dataset.day);
  const field = e.target.dataset.field;
  if (field === 'on') {
    if (e.target.checked) days()[d] = { ...(days()[1] ?? DEFAULT_SCHEDULE.days[1]) };
    else delete days()[d];
    rerender('times', timesCard());
  } else {
    days()[d][field] = e.target.value || null;
  }
  // Without any 下班 time the evening card hides its options; don't leave a hidden choice open.
  if (!timesFor('evening').length) state.choosing.evening = null;
  refreshDirs();
}

async function onSearch(e) {
  e.preventDefault();
  const target = e.currentTarget.dataset.target;
  const q = document.getElementById(`${target}-q`).value.trim();
  const list = document.getElementById(`${target}-list`);
  if (!q) return;
  list.classList.remove('hidden');
  list.innerHTML = '<li class="muted">查找中…</li>';
  try {
    const results = (await geocode(q, fetchJSON)).slice(0, 6);
    if (!results.length) {
      list.innerHTML = '<li class="muted">没找到，试试写完整一点（门牌号 + 街道 + 城市）</li>';
      return;
    }
    list.innerHTML = results
      .map((r, i) => `<li data-i="${i}">${esc(r.label)} <span class="chip">${r.type === 'STOP' ? '站点' : r.type === 'ADDRESS' ? '地址' : '地点'}</span></li>`)
      .join('');
    list.querySelectorAll('li[data-i]').forEach((li) =>
      li.addEventListener('click', async () => {
        const r = results[Number(li.dataset.i)];
        state[target] = { label: r.label, lat: r.lat, lon: r.lon };
        list.classList.add('hidden');
        document.getElementById(`${target}-q`).value = r.label;
        document.getElementById(`${target}-picked`).textContent = `✓ ${r.label}`;
        // A new address invalidates the trips (and any open options) planned from the old one.
        state.morning = null;
        state.evening = null;
        state.choosing = { morning: null, evening: null };
        state.planning++;
        edited();
        if (target === 'home') {
          state.terminals = []; // the old home's terminals must not be used meanwhile
          const run = state.planning;
          const found = await nearbyFerryTerminals(state.home, fetchJSON, { limit: 2 }).catch(() => []);
          if (run === state.planning) state.terminals = found;
        }
        refreshDirs();
      }),
    );
  } catch (err) {
    list.innerHTML = `<li class="muted">查找失败：${esc(err.message)}</li>`;
  }
}

async function onChoose(dir) {
  const msg = (t) => (document.getElementById(`msg-${dir}`).textContent = t);
  if (!state.home || !state.work) return msg('先填好家和公司地址');
  const time = timesFor(dir)[0];
  if (!time) return msg(`先在「每天的时间」里填${DIR[dir].verb}时间`);
  const date = dateFor(dir, time);
  msg('规划中…（会查几次 Transitous，稍等）');
  try {
    const run = state.planning;
    if (!state.terminals.length) state.terminals = await nearbyFerryTerminals(state.home, fetchJSON, { limit: 2 }).catch(() => []);
    const { options, failed } = await planOptionsDetailed({ ...endpoints(dir), date, departTime: time, fetchJSON });
    if (run !== state.planning) return; // the address changed meanwhile
    if (!options.length) return msg(failed ? 'Transitous 查询失败，稍后再试' : '没有找到方案，换个时间试试');
    state.choosing[dir] = { time, date, options, picked: 0 };
    refreshDirs();
    // Some requests failing usually means the ferry options are the ones missing.
    if (failed) msg(`有 ${failed} 个查询失败，渡轮方案可能没列出来：没看到你坐的那条就稍后再查一次`);
  } catch (err) {
    msg(`规划失败：${err.message}`);
  }
}

/**
 * Plan every departure time the schedule uses that has no trip yet, on the chosen lines and
 * boarding the boat closest to the one picked. Throws when a time can't be planned (planner
 * error, or nothing found) so Save never stores a wrong or missing trip silently.
 */
async function planMissing(dir, report) {
  const set = state[dir];
  if (!set) return;
  for (const time of timesFor(dir)) {
    if (set.byTime[time]) continue;
    report(`${DIR[dir].title.slice(0, 2)} ${time} 排班次…`);
    const r = await planDay({
      ...endpoints(dir),
      date: dateFor(dir, time),
      time,
      pattern: set.pattern,
      board: preferredBoarding(set, time),
      fetchJSON,
    });
    if (r.primary) set.byTime[time] = { primary: r.primary, alternatives: r.alternatives };
    else if (r.options.length) set.byTime[time] = { primary: r.options[0], alternatives: r.options.slice(1, 5) };
    else throw new Error(`${DIR[dir].title.slice(0, 2)} ${time} 查不到任何路线，换个时间试试`);
  }
  // Drop trips for times no longer used.
  for (const time of Object.keys(set.byTime)) if (!timesFor(dir).includes(time)) delete set.byTime[time];
}

async function onUse(dir) {
  const ch = state.choosing[dir];
  const primary = ch.options[ch.picked];
  state[dir] = {
    pattern: patternOf(primary),
    byTime: { [ch.time]: { primary, alternatives: ch.options.filter((_, i) => i !== ch.picked).slice(0, 4) } },
  };
  state.choosing[dir] = null;
  edited();
  refreshDirs();
  const msg = document.getElementById(`msg-${dir}`);
  try {
    await planMissing(dir, (t) => (msg.textContent = t));
    msg.textContent = '';
    refreshDirs();
  } catch (err) {
    refreshDirs();
    document.getElementById(`msg-${dir}`).textContent = `${err.message}（保存时会再试）`;
  }
}

async function onSave() {
  const msg = document.getElementById('save-msg');
  const button = document.getElementById('save');
  if (!state.home || !state.work) return (msg.textContent = '先填好家和公司地址');
  if (!Object.keys(days()).length) return (msg.textContent = '至少勾选一个通勤日');
  const noTime = DAY_ORDER.filter((d) => days()[d] && !HHMM.test(days()[d].leaveHome ?? ''));
  if (noTime.length) return (msg.textContent = `${noTime.map((d) => WEEKDAY[d]).join('、')}没填出门时间`);
  const open = ['morning', 'evening'].filter((d) => state.choosing[d]?.options && timesFor(d).length);
  if (open.length) return (msg.textContent = `${open.map((d) => DIR[d].title.slice(0, 2)).join('、')}的路线还没确认：先点「用这条路线」或「取消」`);
  if (!state.morning) return (msg.textContent = '先选去程路线');
  button.disabled = true;
  try {
    await planMissing('morning', (t) => (msg.textContent = t));
    if (state.evening && timesFor('evening').length) await planMissing('evening', (t) => (msg.textContent = t));
    else state.evening = null;
    msg.textContent = '保存中…';
    await api('/api/route', {
      method: 'PUT',
      body: {
        home: state.home,
        work: state.work,
        terminals: state.terminals,
        schedule: state.schedule,
        notify: state.notify,
        morning: state.morning,
        evening: state.evening,
      },
    });
    state.saved = true;
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`;
  } finally {
    button.disabled = false;
  }
}

async function load() {
  try {
    const route = await api('/api/route');
    if (route?.schedule) {
      Object.assign(state, {
        home: route.home,
        work: route.work,
        terminals: route.terminals ?? [],
        schedule: route.schedule,
        notify: { ...DEFAULT_NOTIFY, ...route.notify },
        morning: route.morning,
        evening: route.evening,
      });
    }
    render();
  } catch (err) {
    if (err instanceof Unauthorized) askPasscode(app, load);
    else app.innerHTML = `<div class="banner red">加载失败：${esc(err.message)}</div>`;
  }
}

registerSW();
load();
