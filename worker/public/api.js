// Tiny API client shared by both pages. The passcode lives in localStorage on this device only.

const KEY = 'cg-passcode';

export function passcode() {
  try {
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

function savePasscode(v) {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* private mode: the user will be asked again next time */
  }
}

export class Unauthorized extends Error {}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: {
      Authorization: `Bearer ${passcode()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) throw new Unauthorized('passcode');
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error ?? `HTTP ${res.status}`);
  return data;
}

/** Show the passcode form inside `container`; resolves once a passcode works. */
export function askPasscode(container, onReady) {
  container.innerHTML = `
    <div class="card">
      <h2>输入访问密码</h2>
      <p class="muted small">这个网站只给你自己用。密码就是部署时设置的 APP_PASSCODE，只保存在这台设备上。</p>
      <form id="pc-form" class="row">
        <input id="pc" type="password" autocomplete="current-password" placeholder="访问密码" style="flex:1" />
        <button class="primary">进入</button>
      </form>
      <p id="pc-err" class="small" style="color:var(--red)"></p>
    </div>`;
  container.querySelector('#pc-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    savePasscode(container.querySelector('#pc').value.trim());
    try {
      await api('/api/pause');
      onReady();
    } catch (err) {
      container.querySelector('#pc-err').textContent = err instanceof Unauthorized ? '密码不对' : String(err.message);
    }
  });
}

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function registerSW() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}
