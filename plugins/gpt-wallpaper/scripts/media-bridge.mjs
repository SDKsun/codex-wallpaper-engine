// Trust boundary for the pinned DSH Windows media helper. Never execute an
// environment override or an unverified package-local binary.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {StringDecoder} from 'node:string_decoder';
import {bridgeServeArgs} from '../vendor/dsh-engine/source/packages/media-bridge/lib/supervisor.js';

export const WINDOWS_MEDIA_BRIDGE = Object.freeze({
  tag: 'v0.1.5',
  asset: 'media-bridge-win32-x64.exe',
  sha256: '61a7f6dd5d9b012aceebc4180d9b429b17cd519764c92ea217acf3e63407ee0c',
  url: 'https://github.com/oneincase/media-bridge/releases/download/v0.1.5/media-bridge-win32-x64.exe',
  minBytes: 3 * 1024 * 1024,
  maxBytes: 32 * 1024 * 1024,
});

function fail(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
function absolute(value) {
  if (typeof value !== 'string' || value.includes('\0') || !path.isAbsolute(value)) throw fail('absolute-path-required');
  if (process.platform === 'win32' && value.startsWith('\\\\')) throw fail('local-path-required');
  return path.resolve(value);
}

// Check every component: lstat(file) alone would allow a directory junction.
async function plainPath(value, {file = false, create = false} = {}) {
  const target = absolute(value);
  const root = path.parse(target).root;
  let current = root;
  for (const piece of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, piece);
    let stat;
    try { stat = await fs.lstat(current); } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
      try { await fs.mkdir(current); } catch (mkdirError) { if (mkdirError.code !== 'EEXIST') throw mkdirError; }
      stat = await fs.lstat(current);
    }
    if (stat.isSymbolicLink()) throw fail('linked-path-rejected');
    const finalFile = current === target && file;
    if (finalFile ? !stat.isFile() : !stat.isDirectory()) throw fail(finalFile ? 'ordinary-file-required' : 'ordinary-directory-required');
  }
  if (normalize(await fs.realpath(target)) !== normalize(target)) throw fail('redirected-path-rejected');
  return target;
}

export async function verifyExecutableFile(file, {sha256 = WINDOWS_MEDIA_BRIDGE.sha256, minBytes = WINDOWS_MEDIA_BRIDGE.minBytes, maxBytes = WINDOWS_MEDIA_BRIDGE.maxBytes} = {}) {
  if (!/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(minBytes) || !Number.isSafeInteger(maxBytes) || minBytes < 2 || maxBytes < minBytes || maxBytes > WINDOWS_MEDIA_BRIDGE.maxBytes) throw fail('invalid-verification-policy');
  const verifiedPath = await plainPath(file, {file: true});
  const handle = await fs.open(verifiedPath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size < minBytes || before.size > maxBytes) throw fail('executable-size-rejected');
    const buffer = Buffer.alloc(256 * 1024);
    const hash = createHash('sha256');
    let bytes = 0;
    for (;;) {
      const {bytesRead} = await handle.read(buffer, 0, Math.min(buffer.length, maxBytes - bytes + 1), null);
      if (!bytesRead) break;
      if (bytes === 0 && (buffer[0] !== 0x4d || buffer[1] !== 0x5a)) throw fail('windows-executable-magic-rejected');
      bytes += bytesRead;
      if (bytes > maxBytes) throw fail('executable-size-rejected');
      hash.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const digest = hash.digest('hex');
    if (bytes !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw fail('executable-changed-during-verification');
    if (digest !== sha256) throw fail('executable-sha256-rejected');
    return {path: verifiedPath, bytes, sha256: digest};
  } finally { await handle.close(); }
}

async function boundedCopy(source, destination) {
  const input = await fs.open(await plainPath(source, {file: true}), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  let output;
  try {
    output = await fs.open(destination, 'wx', 0o600);
    let bytes = 0;
    const buffer = Buffer.alloc(256 * 1024);
    for (;;) {
      const {bytesRead} = await input.read(buffer, 0, Math.min(buffer.length, WINDOWS_MEDIA_BRIDGE.maxBytes - bytes + 1), null);
      if (!bytesRead) break;
      bytes += bytesRead;
      if (bytes > WINDOWS_MEDIA_BRIDGE.maxBytes) throw fail('executable-size-rejected');
      let offset = 0;
      while (offset < bytesRead) offset += (await output.write(buffer, offset, bytesRead - offset)).bytesWritten;
    }
    await output.sync();
  } finally { await Promise.allSettled([input.close(), output?.close()]); }
}

const DOWNLOAD_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);
function officialDownloadUrl(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !DOWNLOAD_HOSTS.has(url.hostname)) throw fail('untrusted-download-redirect');
  return url.href;
}

async function downloadPinned(destination, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let handle;
  let reader;
  try {
    let url = WINDOWS_MEDIA_BRIDGE.url;
    let response;
    for (let redirects = 0; redirects <= 3; redirects++) {
      response = await fetchImpl(officialDownloadUrl(url), {redirect: 'manual', credentials: 'omit', signal: controller.signal, headers: {'User-Agent': 'gpt-wallpaper-media-bridge', 'Accept-Encoding': 'identity'}});
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects === 3) throw fail('download-redirect-limit');
        url = officialDownloadUrl(new URL(location, url).href);
        continue;
      }
      break;
    }
    if (response.status !== 200 || !response.body) throw fail('download-http-error', `media bridge download HTTP ${response.status}`);
    const declared = response.headers.get('content-length');
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > WINDOWS_MEDIA_BRIDGE.maxBytes || Number(declared) < WINDOWS_MEDIA_BRIDGE.minBytes)) throw fail('download-size-rejected');
    reader = response.body.getReader();
    handle = await fs.open(destination, 'wx', 0o600);
    let bytes = 0;
    for (;;) {
      const {done, value} = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > WINDOWS_MEDIA_BRIDGE.maxBytes) throw fail('download-size-rejected');
      let offset = 0;
      while (offset < value.byteLength) offset += (await handle.write(value, offset, value.byteLength - offset)).bytesWritten;
    }
    await handle.sync();
  } finally {
    clearTimeout(timer);
    controller.abort();
    try { await reader?.cancel(); } catch {}
    if (handle) await handle.close();
  }
}

function inside(parent, child) {
  const relative = path.relative(normalize(parent), normalize(child));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

/** Resolve only the pinned Windows artifact. Does not mutate process.env. */
export async function ensureTrustedMediaBridge({dataDir, candidatePaths = [], reuseOriginalDsh = true, allowDownload = true, fetchImpl = globalThis.fetch, downloadTimeoutMs = 45000} = {}) {
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw fail('windows-media-bridge-platform-required');
  const directory = absolute(dataDir);
  const originalDshDirectory = path.join(os.homedir(), '.dsh-wallpaper-engine');
  if (inside(originalDshDirectory, directory)) throw fail('original-dsh-directory-is-read-only');
  if (!Array.isArray(candidatePaths) || candidatePaths.length > 16 || typeof reuseOriginalDsh !== 'boolean' || typeof allowDownload !== 'boolean' || !Number.isInteger(downloadTimeoutMs) || downloadTimeoutMs < 100 || downloadTimeoutMs > 60000) throw fail('invalid-provisioning-options');
  const cacheDirectory = await plainPath(path.join(directory, 'bin', 'media-bridge', WINDOWS_MEDIA_BRIDGE.tag), {create: true});
  const target = path.join(cacheDirectory, WINDOWS_MEDIA_BRIDGE.asset);
  const result = (verified, source) => ({...verified, source, tag: WINDOWS_MEDIA_BRIDGE.tag, asset: WINDOWS_MEDIA_BRIDGE.asset, env: {
    DSH_WE_MEDIA_BRIDGE: verified.path,
    DSH_WE_MEDIA_BRIDGE_SHA256: WINDOWS_MEDIA_BRIDGE.sha256,
    DSH_WE_MEDIA_BRIDGE_TAG: WINDOWS_MEDIA_BRIDGE.tag,
  }});
  try { return result(await verifyExecutableFile(target), 'codex-cache'); } catch (error) {
    if (['linked-path-rejected', 'redirected-path-rejected', 'ordinary-file-required'].includes(error.code)) throw error;
  }
  const candidates = [...candidatePaths, ...(reuseOriginalDsh ? [path.join(originalDshDirectory, 'bin', 'media-bridge', WINDOWS_MEDIA_BRIDGE.tag, WINDOWS_MEDIA_BRIDGE.asset)] : [])];
  let candidate = null;
  for (const file of candidates) {
    try { candidate = (await verifyExecutableFile(file)).path; break; } catch {}
  }
  if (!candidate && !allowDownload) throw fail('trusted-media-bridge-unavailable');
  const staging = path.join(cacheDirectory, `.${WINDOWS_MEDIA_BRIDGE.asset}.${randomUUID()}.part`);
  try {
    if (candidate) await boundedCopy(candidate, staging);
    else await downloadPinned(staging, fetchImpl, downloadTimeoutMs);
    await verifyExecutableFile(staging);
    // Recheck the cache ancestry immediately before the atomic publication.
    await plainPath(cacheDirectory);
    await fs.rename(staging, target);
    return result(await verifyExecutableFile(target), candidate ? 'verified-local-copy' : 'official-github-release');
  } finally { await fs.unlink(staging).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}

/** Bounded NDJSON RPC; event lines can appear before any numbered response. */
export function createMediaRpc(input, output, {onEvent = () => {}, maxLineBytes = 256 * 1024, maxTotalBytes = 4 * 1024 * 1024} = {}) {
  let sequence = 0;
  let buffer = '';
  let bytes = 0;
  let stopped = null;
  const decoder = new StringDecoder('utf8');
  const pending = new Map();
  const stop = error => {
    if (stopped) return;
    stopped = error || fail('media-rpc-closed');
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(stopped); }
    pending.clear();
  };
  const onData = chunk => {
    if (stopped) return;
    bytes += chunk.length;
    if (bytes > maxTotalBytes) { stop(fail('media-rpc-output-limit')); return; }
    buffer += decoder.write(chunk);
    for (;;) {
      const newline = buffer.indexOf('\n');
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > maxLineBytes) { stop(fail('media-rpc-line-limit')); return; }
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { stop(fail('media-rpc-invalid-json')); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message)) { stop(fail('media-rpc-invalid-message')); return; }
      if (typeof message.event === 'string') { try { onEvent(message); } catch (error) { stop(error); } continue; }
      const item = pending.get(message.id);
      if (!item) continue;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.ok === true) item.resolve(message.result);
      else item.reject(fail('media-rpc-rejected', String(message.error?.code || 'media-rpc-rejected').slice(0, 100)));
    }
    if (Buffer.byteLength(buffer) > maxLineBytes) stop(fail('media-rpc-line-limit'));
  };
  const onEnd = () => stop(fail('media-rpc-ended'));
  const onError = error => stop(error);
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onError);
  output.on('error', onError);
  return {
    call(method, params = {}, timeoutMs = 8000) {
      if (stopped) return Promise.reject(stopped);
      if (typeof method !== 'string' || method.length > 40 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) return Promise.reject(fail('invalid-media-rpc-call'));
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => { pending.delete(id); reject(fail('media-rpc-timeout', `${method} timed out`)); }, timeoutMs);
        pending.set(id, {resolve, reject, timer});
        try { output.write(JSON.stringify({id, method, params}) + '\n'); } catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
      });
    },
    dispose(error) {
      stop(error);
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onError);
      output.off('error', onError);
    },
  };
}

function sourceAvailability(source, disabled = false) {
  if (disabled) return 'disabled';
  if (['error', 'unavailable', 'unsupported', 'denied'].includes(source?.state)) return 'unavailable';
  if (['running', 'idle', 'available', 'ready'].includes(source?.state)) return 'available';
  return 'pending';
}

export function summarizeMediaProbe({hello, status, now, bands = [], spectrumFrames = 0, audio = true}) {
  if (hello?.protocol !== 1) throw fail('unsupported-media-bridge-protocol');
  const sources = Array.isArray(status?.sources) ? status.sources.slice(0, 16).map(source => ({name: String(source?.name || '').slice(0, 50), state: String(source?.state || '').slice(0, 50)})) : [];
  const source = name => sources.find(item => item.name === name);
  const values = bands.slice(0, 64).filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
  const peak = values.length ? Math.max(...values) : null;
  const capabilities = {};
  if (now?.capabilities && typeof now.capabilities === 'object') {
    for (const [name, value] of Object.entries(now.capabilities)) if (/^[a-zA-Z][a-zA-Z0-9]{0,39}$/.test(name) && typeof value === 'boolean') capabilities[name] = value;
  }
  return {
    ok: true,
    backend: 'bridge',
    bridge: {protocol: hello.protocol, version: String(hello.version || '').slice(0, 30), platform: String(hello.platform || '').slice(0, 30), arch: String(hello.arch || '').slice(0, 30), provider: String(hello.provider || '').slice(0, 50), features: Array.isArray(hello.features) ? hello.features.filter(value => typeof value === 'string').slice(0, 32).map(value => value.slice(0, 100)) : []},
    audio: {availability: sourceAvailability(source('audio'), !audio), state: source('audio')?.state || 'unknown', bandCount: values.length, spectrumFrames, peak, signal: peak === null ? 'not-sampled' : peak > 0 ? 'present' : 'silence'},
    nowPlaying: {availability: sourceAvailability(source('metadata')), hasMedia: now?.hasMedia === true, playbackState: typeof now?.playback?.state === 'string' ? now.playback.state.slice(0, 30) : null, capabilities},
    lyrics: {availability: sourceAvailability(source('lyrics')), online: false},
    sources,
  };
}

/** Real Windows provider probe. Read-only RPCs only; no player control or online lyrics. */
export async function probeTrustedMediaBridge({binPath, cacheDir, audio = true, timeoutMs = 25000, sampleMs = 1000} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30000 || !Number.isInteger(sampleMs) || sampleMs < 100 || sampleMs > 3000) throw fail('invalid-probe-budget');
  const binary = await verifyExecutableFile(binPath);
  const cache = await plainPath(cacheDir, {create: true});
  const child = spawn(binary.path, bridgeServeArgs({cacheDir: cache, audio, online: false}), {windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe']});
  const deadline = Date.now() + timeoutMs;
  let closed = false;
  let stderrBytes = 0;
  let spectrumFrames = 0;
  let bands = [];
  let latestStatus = null;
  let result;
  let rpc;
  const closedPromise = new Promise(resolve => child.once('close', () => { closed = true; resolve(); }));
  rpc = createMediaRpc(child.stdout, child.stdin, {onEvent(event) {
    if (event.event === 'spectrum' && Array.isArray(event.frame?.bands)) { bands = event.frame.bands; spectrumFrames++; }
    if (event.event === 'status' && Array.isArray(event.status?.sources)) latestStatus = event.status;
  }});
  child.on('error', error => rpc.dispose(error));
  child.stdin.on('error', () => {});
  child.stderr.on('data', chunk => { stderrBytes += chunk.length; if (stderrBytes > 64 * 1024) rpc.dispose(fail('media-rpc-stderr-limit')); });
  const call = (method, params = {}) => rpc.call(method, params, Math.max(1, Math.min(method === 'hello' ? timeoutMs : 8000, deadline - Date.now())));
  try {
    const hello = await call('hello');
    if (hello?.protocol !== 1) throw fail('unsupported-media-bridge-protocol');
    await call('subscribe', {events: ['status', ...(audio ? ['spectrum'] : [])], intervalMs: 50});
    const now = await call('now', {interpolate: false});
    await new Promise(resolve => setTimeout(resolve, Math.min(sampleMs, Math.max(0, deadline - Date.now()))));
    const status = await call('status');
    if (audio && !bands.length) {
      const frame = await call('spectrum');
      bands = Array.isArray(frame?.bands) ? frame.bands : [];
      if (bands.length) spectrumFrames++;
    }
    result = summarizeMediaProbe({hello, status: Array.isArray(status?.sources) ? status : latestStatus, now, bands, spectrumFrames, audio});
  } finally {
    rpc.dispose();
    // Close only this newly spawned helper, never any existing desktop process.
    child.stdin.end();
    await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 1500))]);
    if (!closed) child.kill();
    await Promise.race([closedPromise, new Promise(resolve => setTimeout(resolve, 1000))]);
    if (result) result.helperStopped = closed;
  }
  return result;
}
