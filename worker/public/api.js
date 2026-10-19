// Tiny API client shared by both pages, plus the notification setup. The passcode lives in
// localStorage on this device only.

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
  // The service worker answered from its cache because the network didn't.
  if (data && typeof data === 'object' && res.headers.get('X-From-Cache')) data.fromCache = true;
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

// ---------- notifications (Web Push) ----------

export const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * 'needs-install' — iPhone Safari only allows push for apps opened from the home screen;
 * 'unsupported' | 'default' | 'granted' | 'denied' otherwise.
 */
export function pushSupport() {
  if (!('serviceWorker' in navigator)) return 'unsupported';
  if (isIOS() && !isStandalone()) return 'needs-install';
  if (!('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  return Notification.permission;
}

function keyBytes(b64url) {
  const s = atob(b64url.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((b64url.length + 3) % 4));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export async function currentSubscription() {
  if (!('serviceWorker' in navigator)) return null;
  const reg = await navigator.serviceWorker.ready;
  return reg.pushManager?.getSubscription() ?? null;
}

/** Whether a subscription was made with this VAPID public key (pushes to it would otherwise fail). */
export function subscriptionMatches(sub, publicKey) {
  if (!sub) return false;
  const own = sub.options?.applicationServerKey;
  if (!own) return true; // the browser doesn't say; assume it matches
  const a = new Uint8Array(own);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Must run from a tap the first time (iOS only shows the permission prompt for a user gesture). */
export async function enablePush(publicKey) {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') {
    throw new Error(perm === 'denied' ? '通知被关掉了：到 iPhone「设置 → 通知 → 通勤哨兵」打开允许通知' : '没有允许通知');
  }
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  const key = keyBytes(publicKey);
  if (sub && !subscriptionMatches(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await api('/api/push/subscribe', { method: 'POST', body: sub.toJSON() });
  return sub;
}

/** Show the number of open problems on the home-screen icon. */
export function setBadge(n) {
  try {
    if (n > 0) navigator.setAppBadge?.(n);
    else navigator.clearAppBadge?.();
  } catch {
    /* not supported */
  }
}
