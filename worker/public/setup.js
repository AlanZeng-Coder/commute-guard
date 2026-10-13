import { api, askPasscode, esc, registerSW, Unauthorized, WEEKDAY } from './api.js';
import { DEFAULT_WORKDAYS } from './shared/schedule.mjs';
import { addDays, pacificDate, weekdayOf } from './shared/time.mjs';
import { geocode, nearbyFerryTerminals, planOptions } from './shared/transitous.mjs';

const app = document.getElementById('app');
const ICON = { WALK: '🚶', FERRY: '⛴', TRAM: '🚋', SUBWAY: '🚇', BUS: '🚌', RAIL: '🚆', CABLE_CAR: '🚡' };

// The browser sends a Referer, which Transitous accepts in place of a User-Agent.
async function fetchJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Transitous HTTP ${res.status}`);
  return res.json();
}

const state = { home: null, work: null, options: [], picked: 0, current: null };

function nextWeekday() {
  let d = addDays(pacificDate(), 1);
  while (!DEFAULT_WORKDAYS.includes(weekdayOf(d))) d = addDays(d, 1);
  return d;
}

function legLine(l) {
  if (!l.transit) return `${ICON[l.mode] ?? '·'} ${l.depLocal} 步行 ${l.durationMin} 分钟 → ${esc(l.to.name || '目的地')}`;
  return `${ICON[l.mode] ?? '🚍'} ${l.depLocal} <b>${esc(l.routeShortName ?? '')}</b> ${esc(l.agencyName ?? '')}：${esc(l.from.name)} → ${esc(l.to.name)}（${l.arrLocal} 到）`;
}

function currentCard() {
  const r = state.current;
  if (!r?.primary) return '';
  return `
    <section class="card">
      <h2>当前路线</h2>
      <div><b>${esc(r.primary.summary)}</b> <span class="muted small">${esc(r.primary.startLocal)} → ${esc(r.primary.endLocal)}</span></div>
      <ol class="small muted" style="padding-left:20px;margin:8px 0 0">${r.primary.legs.map((l) => `<li>${legLine(l)}</li>`).join('')}</ol>
      <p class="small muted">${esc(r.home?.label ?? '')} → ${esc(r.work?.label ?? '')} · 通勤日：${(r.workdays ?? []).map((d) => WEEKDAY[d]).join(' ')}</p>
    </section>`;
}

function render() {
  const workdays = state.current?.workdays ?? DEFAULT_WORKDAYS;
  app.innerHTML = `
    ${currentCard()}
    <section class="card">
      <h2>${state.current?.primary ? '重新选择路线' : '第一步：家和公司'}</h2>
      <label for="home-q">家地址</label>
      <form class="row" data-target="home"><input id="home-q" placeholder="例如 1600 Webster St, Alameda" style="flex:1" value="${esc(state.home?.label ?? '')}" /><button>查找</button></form>
      <ul class="suggestions hidden" id="home-list"></ul>
      <div class="picked" id="home-picked"></div>

      <label for="work-q">公司地址</label>
      <form class="row" data-target="work"><input id="work-q" placeholder="例如 1 Market St, San Francisco" style="flex:1" value="${esc(state.work?.label ?? '')}" /><button>查找</button></form>
      <ul class="suggestions hidden" id="work-list"></ul>
      <div class="picked" id="work-picked"></div>

      <div class="grid2">
        <div><label for="depart">出门时间</label><input id="depart" type="time" value="${esc(state.current?.departTime ?? '06:30')}" /></div>
        <div><label for="date">按哪天的班表查</label><input id="date" type="date" value="${nextWeekday()}" /></div>
      </div>
      <label>通勤日</label>
      <div class="days">${[1, 2, 3, 4, 5, 6, 0]
        .map((d) => `<label><input type="checkbox" name="wd" value="${d}" ${workdays.includes(d) ? 'checked' : ''}/>${WEEKDAY[d]}</label>`)
        .join('')}</div>
      <div class="row" style="margin-top:14px"><button class="primary" id="plan" disabled>第二步：查找路线</button><span id="plan-msg" class="small muted"></span></div>
    </section>
    <section id="options"></section>`;

  for (const form of app.querySelectorAll('form[data-target]')) form.addEventListener('submit', onSearch);
  app.querySelector('#plan').addEventListener('click', onPlan);
  updatePicked();
}

function updatePicked() {
  for (const k of ['home', 'work']) {
    const el = document.getElementById(`${k}-picked`);
    if (el) el.textContent = state[k] ? `✓ ${state[k].label}` : '';
  }
  const btn = document.getElementById('plan');
  if (btn) btn.disabled = !(state.home && state.work);
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
      li.addEventListener('click', () => {
        const r = results[Number(li.dataset.i)];
        state[target] = { label: r.label, lat: r.lat, lon: r.lon };
        list.classList.add('hidden');
        document.getElementById(`${target}-q`).value = r.label;
        updatePicked();
      }),
    );
  } catch (err) {
    list.innerHTML = `<li class="muted">查找失败：${esc(err.message)}</li>`;
  }
}

async function onPlan() {
  const msg = document.getElementById('plan-msg');
  const box = document.getElementById('options');
  const departTime = document.getElementById('depart').value || '06:30';
  const date = document.getElementById('date').value || nextWeekday();
  msg.textContent = '找附近的渡轮码头…';
  box.innerHTML = '';
  try {
    const terminals = await nearbyFerryTerminals(state.home, fetchJSON, { limit: 2 });
    msg.textContent = `规划中（含 ${terminals.map((t) => t.name.replace(' Ferry Terminal', '')).join('、') || '无渡轮码头'}）…`;
    state.options = await planOptions({ from: state.home, to: state.work, date, departTime, terminals, fetchJSON });
    state.picked = 0;
    msg.textContent = state.options.length ? '' : '没有找到方案，换个出门时间或日期试试';
    renderOptions();
  } catch (err) {
    msg.textContent = `规划失败：${err.message}`;
  }
}

function renderOptions() {
  const box = document.getElementById('options');
  if (!state.options.length) return;
  box.innerHTML = `
    <section class="card">
      <h2>第三步：选你实际走的路线</h2>
      <p class="small muted">选中的是<b>主路线</b>（每天检查它）；其余方案会存为<b>备选</b>，出问题时用来给 Plan B。</p>
      ${state.options
        .map(
          (o, i) => `
        <div class="option ${i === state.picked ? 'sel' : ''}" data-i="${i}">
          <div class="row"><span class="sum">${esc(o.summary)}</span>${o.hasFerry ? '<span class="chip green">渡轮</span>' : ''}<span class="spacer"></span>
            <span class="small muted">${o.startLocal} → ${o.endLocal} · ${o.durationMin} 分钟</span></div>
          <ol>${o.legs.map((l) => `<li>${legLine(l)}</li>`).join('')}</ol>
        </div>`,
        )
        .join('')}
      <div class="row"><button class="primary" id="save">保存为我的路线</button><span id="save-msg" class="small muted"></span></div>
    </section>`;
  box.querySelectorAll('.option').forEach((el) =>
    el.addEventListener('click', () => {
      state.picked = Number(el.dataset.i);
      renderOptions();
    }),
  );
  box.querySelector('#save').addEventListener('click', onSave);
}

async function onSave() {
  const msg = document.getElementById('save-msg');
  const workdays = [...document.querySelectorAll('input[name=wd]:checked')].map((c) => Number(c.value));
  const primary = state.options[state.picked];
  const body = {
    home: state.home,
    work: state.work,
    departTime: document.getElementById('depart').value || '06:30',
    workdays: workdays.length ? workdays : DEFAULT_WORKDAYS,
    primary,
    alternatives: state.options.filter((_, i) => i !== state.picked).slice(0, 4),
  };
  msg.textContent = '保存中…';
  try {
    await api('/api/route', { method: 'PUT', body });
    state.current = await api('/api/route');
    msg.textContent = '';
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } catch (err) {
    msg.textContent = `保存失败：${err.message}`;
  }
}

async function load() {
  try {
    state.current = await api('/api/route');
    if (state.current) {
      state.home = state.current.home ?? null;
      state.work = state.current.work ?? null;
    }
    render();
  } catch (err) {
    if (err instanceof Unauthorized) askPasscode(app, load);
    else app.innerHTML = `<div class="banner red">加载失败：${esc(err.message)}</div>`;
  }
}

registerSW();
load();
