const id = location.pathname.split('/').pop();
const base = location.pathname.slice(0, location.pathname.lastIndexOf('/scene/'));
const host = document.getElementById('scene');
const status = {ready: false, error: null, pointerUpdates: 0, settingsError: null};
const defaults = Object.freeze({
  sceneLiveFps: 30, objectFit: 'cover', videoVolume: 0, videoAudioEnabled: true,
  wallpaperBlur: 0, backgroundBrightness: 100, backgroundContrast: 100,
  backgroundSaturate: 100, wallpaperOpacity: 0, flip: false,
  layerPositionX: 50, layerPositionY: 50, layerScale: 100,
  pauseOnHidden: true, pauseOnBlur: false, pauseOnBattery: false,
});
const settings = {...defaults};
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const NUMBERS = {
  videoVolume: [0, 1], wallpaperBlur: [0, 60], backgroundBrightness: [40, 160],
  backgroundContrast: [40, 200], backgroundSaturate: [0, 200], wallpaperOpacity: [0, 90],
  layerPositionX: [0, 100], layerPositionY: [0, 100], layerScale: [50, 150],
};
const BOOLEANS = new Set(['videoAudioEnabled', 'flip', 'pauseOnHidden', 'pauseOnBlur', 'pauseOnBattery']);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
let parentPaused = false;
let parentFocused = true;
let onBattery = false;
let disposed = false;
let pollPending = false;
let lastPayload = '';
let requestedProperties = Object.create(null);
let originalProperties = Object.create(null);
let battery = null;

document.body.dataset.sceneStatus = 'loading';
const inst = WebWallGL.createScene(host, {
  fit: 'cover', fps: 30, volume: 0, mountTimeoutMs: 60000,
  renderDpr: Math.min(devicePixelRatio, 1.5),
});
window.__sceneDiagnostics = status;

function notify(type, extra = {}) {
  if (parent !== window) parent.postMessage({type, ...extra}, '*');
}

function fail(error) {
  status.error = String(error?.message || error).slice(0, 500);
  document.body.dataset.sceneStatus = 'error';
  const el = document.getElementById('error');
  el.hidden = false;
  el.textContent = `此场景未能渲染：${status.error}`;
  notify('gpt-wallpaper:error', {message: status.error});
}

function syncPlayback() {
  if (disposed) return;
  const paused = parentPaused || (settings.pauseOnHidden && document.hidden)
    || (settings.pauseOnBlur && !parentFocused) || (settings.pauseOnBattery && onBattery);
  paused ? inst.pause() : inst.resume();
  status.paused = paused;
  status.userPaused = parentPaused;
}

function sanitizeProperties(value) {
  if (!plain(value) || Object.keys(value).length > 512) throw new TypeError('壁纸属性表无效');
  const result = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (!key || key.length > 128 || RESERVED.has(key) || /[\u0000-\u001f\u007f]/.test(key)) throw new TypeError('壁纸属性名称无效');
    if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))
        || (typeof item === 'string' && item.length <= 8192 && !item.includes('\0'))) result[key] = item;
    else throw new TypeError('壁纸属性必须为有限数字、布尔值或字符串');
  }
  return result;
}

function applySettings(payload) {
  if (!plain(payload) || !plain(payload.settings ?? {}) || !plain(payload.properties ?? {})) throw new TypeError('场景设置无效');
  const source = payload.settings ?? {};
  if (Object.keys(source).length > 2048) throw new TypeError('场景设置过大');
  // The host stores the complete DSH schema snapshot; only scene keys belong here.
  const next = {...settings};
  for (const [key, value] of Object.entries(source)) {
    if (RESERVED.has(key)) throw new TypeError('场景设置名称无效');
    if (Object.prototype.hasOwnProperty.call(NUMBERS, key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`设置 ${key} 需要有限数字`);
      next[key] = Math.min(NUMBERS[key][1], Math.max(NUMBERS[key][0], value));
    } else if (BOOLEANS.has(key)) {
      if (typeof value !== 'boolean') throw new TypeError(`设置 ${key} 需要布尔值`);
      next[key] = value;
    } else if (key === 'sceneLiveFps') {
      if (![15, 30, 60].includes(value)) throw new TypeError('场景帧率必须为 15、30 或 60');
      next.sceneLiveFps = value;
    } else if (key === 'objectFit') {
      if (!['cover', 'contain', 'center', 'fill'].includes(value)) throw new TypeError('画面取景方式无效');
      next.objectFit = value;
    }
  }
  const properties = sanitizeProperties(payload.properties ?? {});
  const signature = JSON.stringify({settings: next, properties});
  if (signature === lastPayload) return;
  Object.assign(settings, next);
  requestedProperties = properties;
  inst.setFps(settings.sceneLiveFps);
  inst.setFit(settings.objectFit === 'fill' ? 'stretch' : settings.objectFit === 'center' ? 'contain' : settings.objectFit);
  inst.setVolume(settings.videoAudioEnabled ? settings.videoVolume : 0);
  host.style.filter = `blur(${settings.wallpaperBlur}px) brightness(${settings.backgroundBrightness}%) contrast(${settings.backgroundContrast}%) saturate(${settings.backgroundSaturate}%)`;
  host.style.opacity = String(1 - settings.wallpaperOpacity / 100);
  const scale = settings.layerScale / 100;
  host.style.transform = `translate(${(settings.layerPositionX - 50) / 2}%, ${(settings.layerPositionY - 50) / 2}%) scale(${settings.flip ? -scale : scale}, ${scale})`;
  if (status.ready) inst.setProperties({...originalProperties, ...requestedProperties});
  lastPayload = signature;
  status.settingsError = null;
  syncPlayback();
}

async function refreshSettings() {
  if (disposed || pollPending || document.hidden) return;
  pollPending = true;
  try {
    const response = await fetch(`${base}/scene-settings/${id}`, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    // Older hosts can still render with the original settings.
    if (response.status === 404) return;
    if (!response.ok) throw new Error(`读取场景设置失败（${response.status}）`);
    const text = await response.text();
    if (text.length > 1024 * 1024) throw new Error('场景设置过大');
    if (!disposed) applySettings(JSON.parse(text));
  } catch (error) {
    if (!disposed) status.settingsError = String(error?.message || error).slice(0, 240);
  } finally { pollPending = false; }
}

function pushPointer(u, v, buttons = 0, mods = 0) {
  const scale = settings.layerScale / 100;
  const localU = ((u - 0.5 - (settings.layerPositionX - 50) / 200) / scale) * (settings.flip ? -1 : 1) + 0.5;
  const localV = (v - 0.5 - (settings.layerPositionY - 50) / 200) / scale + 0.5;
  inst.pushPointer(Math.min(1, Math.max(0, localU)), Math.min(1, Math.max(0, localV)),
    Number.isInteger(buttons) ? buttons & 31 : 0, Number.isInteger(mods) ? mods & 15 : 0);
  status.pointerUpdates++;
}

function directPointer(event) {
  if (!Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)) return;
  const mods = (event.ctrlKey ? 1 : 0) | (event.shiftKey ? 2 : 0) | (event.altKey ? 4 : 0) | (event.metaKey ? 8 : 0);
  pushPointer(event.clientX / Math.max(1, innerWidth), event.clientY / Math.max(1, innerHeight), event.buttons, mods);
}
inst.canvas.addEventListener('pointermove', directPointer, {passive: true});
inst.canvas.addEventListener('pointerdown', directPointer, {passive: true});
inst.canvas.addEventListener('pointerup', directPointer, {passive: true});

window.addEventListener('message', event => {
  if (event.source !== parent || parent === window || !plain(event.data)) return;
  const message = event.data;
  if (message.type === 'gpt-wallpaper:pointer' && Number.isFinite(message.u) && Number.isFinite(message.v)) {
    pushPointer(message.u, message.v, message.buttons, message.mods);
  } else if (message.type === 'gpt-wallpaper:leave') inst.pointerLeave();
  else if (message.type === 'gpt-wallpaper:pause' && typeof message.paused === 'boolean') {
    parentPaused = message.paused;
    syncPlayback();
  } else if (message.type === 'gpt-wallpaper:focus' && typeof message.focused === 'boolean') {
    parentFocused = message.focused;
    syncPlayback();
  } else if (message.type === 'gpt-wallpaper:settings') {
    try { applySettings(message); }
    catch (error) { status.settingsError = String(error?.message || error).slice(0, 240); }
  }
});

document.addEventListener('visibilitychange', () => {
  syncPlayback();
  if (!document.hidden) void refreshSettings();
});
// An iframe blur means the user clicked chat chrome, not that Codex lost focus.
// Embedded hosts forward their actual window focus state explicitly.
if (parent === window) {
  window.addEventListener('focus', () => { parentFocused = true; syncPlayback(); });
  window.addEventListener('blur', () => { parentFocused = false; syncPlayback(); });
}

function batteryChanged() { onBattery = battery ? !battery.charging : false; syncPlayback(); }
if (typeof navigator.getBattery === 'function') {
  navigator.getBattery().then(value => {
    if (disposed) return;
    battery = value;
    status.batteryAvailable = true;
    battery.addEventListener('chargingchange', batteryChanged);
    batteryChanged();
  }).catch(() => { status.batteryAvailable = false; });
} else status.batteryAvailable = false;

inst.on('error', fail);
void refreshSettings().finally(() => {
  if (disposed) return;
  inst.load(WebWallGL.httpSource(`${location.origin}${base}/project/${id}`)).then(() => {
    if (disposed) return;
    try { originalProperties = sanitizeProperties(inst.getProperties?.() ?? {}); }
    catch { originalProperties = Object.create(null); }
    inst.setProperties({...originalProperties, ...requestedProperties});
    status.ready = true;
    document.body.dataset.sceneStatus = 'ready';
    syncPlayback();
    notify('gpt-wallpaper:ready');
  }).catch(fail);
});

const settingsTimer = setInterval(() => { void refreshSettings(); }, 2000);
const metricsTimer = setInterval(() => {
  status.stats = inst.stats;
  document.body.dataset.sceneFps = String(inst.stats?.fps ?? 0);
  document.body.dataset.sceneRunning = String(!!inst.stats?.running);
  document.body.dataset.pointerUpdates = String(status.pointerUpdates);
  notify('gpt-wallpaper:metrics', {fps: inst.stats?.fps ?? 0, running: !!inst.stats?.running, pointerUpdates: status.pointerUpdates});
}, 1000);

window.addEventListener('pagehide', () => {
  disposed = true;
  clearInterval(settingsTimer);
  clearInterval(metricsTimer);
  battery?.removeEventListener('chargingchange', batteryChanged);
  inst.destroy({releasePkgCache: true});
});
