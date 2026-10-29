import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import {WINDOWS_MEDIA_BRIDGE, verifyExecutableFile, ensureTrustedMediaBridge, createMediaRpc, summarizeMediaProbe} from '../plugins/gpt-wallpaper/scripts/media-bridge.mjs';
import {MEDIA_BRIDGE_TAG, MEDIA_BRIDGE_SHA256} from '../plugins/gpt-wallpaper/vendor/dsh-engine/source/packages/media-bridge/lib/provision.js';
import {createBridgeSupervisor} from '../plugins/gpt-wallpaper/vendor/dsh-engine/source/packages/media-bridge/lib/supervisor.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gpt-media-bridge-test-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}
const rejectedCode = code => error => error.code === code;

test('Windows artifact pin agrees with the exact vendored DSH release manifest', () => {
  assert.equal(WINDOWS_MEDIA_BRIDGE.tag, MEDIA_BRIDGE_TAG);
  assert.equal(WINDOWS_MEDIA_BRIDGE.sha256, MEDIA_BRIDGE_SHA256[WINDOWS_MEDIA_BRIDGE.asset]);
  assert.equal(WINDOWS_MEDIA_BRIDGE.url, `https://github.com/oneincase/media-bridge/releases/download/${MEDIA_BRIDGE_TAG}/${WINDOWS_MEDIA_BRIDGE.asset}`);
  assert.equal(Object.isFrozen(WINDOWS_MEDIA_BRIDGE), true);
});

test('file verification requires exact SHA, Windows magic, finite size, and absolute ordinary path', async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'fixture.exe');
  const bytes = Buffer.from('MZ\0\0fixture executable bytes');
  await fs.writeFile(file, bytes);
  const policy = {sha256: hash(bytes), minBytes: 2, maxBytes: 1024};
  assert.equal((await verifyExecutableFile(file, policy)).bytes, bytes.length);
  await assert.rejects(verifyExecutableFile(file, {...policy, sha256: '0'.repeat(64)}), rejectedCode('executable-sha256-rejected'));
  await assert.rejects(verifyExecutableFile(file, {...policy, minBytes: bytes.length + 1}), rejectedCode('executable-size-rejected'));
  await assert.rejects(verifyExecutableFile(file, {...policy, maxBytes: bytes.length - 1}), rejectedCode('executable-size-rejected'));
  await assert.rejects(verifyExecutableFile('relative.exe', policy), rejectedCode('absolute-path-required'));
  await assert.rejects(verifyExecutableFile(directory, policy), rejectedCode('ordinary-file-required'));
  await fs.writeFile(file, Buffer.from('ELF is not the pinned Windows artifact'));
  await assert.rejects(verifyExecutableFile(file, {...policy, sha256: hash(await fs.readFile(file))}), rejectedCode('windows-executable-magic-rejected'));
});

test('linked directory ancestry is rejected before reading an executable', async t => {
  const directory = await temporary(t);
  const real = path.join(directory, 'real');
  const link = path.join(directory, 'linked');
  await fs.mkdir(real);
  const bytes = Buffer.from('MZ ordinary bytes');
  await fs.writeFile(path.join(real, 'fixture.exe'), bytes);
  await fs.symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyExecutableFile(path.join(link, 'fixture.exe'), {sha256: hash(bytes), minBytes: 2, maxBytes: 1024}), rejectedCode('linked-path-rejected'));
});

test('provisioning rejects untrusted candidates and never writes the original DSH directory', {skip: process.platform !== 'win32'}, async t => {
  const directory = await temporary(t);
  const file = path.join(directory, 'fake.exe');
  await fs.writeFile(file, Buffer.from('MZ fake'));
  await assert.rejects(ensureTrustedMediaBridge({dataDir: path.join(directory, 'codex'), candidatePaths: [file], reuseOriginalDsh: false, allowDownload: false}), rejectedCode('trusted-media-bridge-unavailable'));
  await assert.rejects(ensureTrustedMediaBridge({dataDir: path.join(os.homedir(), '.dsh-wallpaper-engine', 'bin'), allowDownload: false}), rejectedCode('original-dsh-directory-is-read-only'));
});

test('download only follows official HTTPS asset redirects and rejects size claims before writing', {skip: process.platform !== 'win32'}, async t => {
  const directory = await temporary(t);
  let calls = 0;
  await assert.rejects(ensureTrustedMediaBridge({dataDir: directory, reuseOriginalDsh: false, fetchImpl: async url => {
    calls++;
    assert.equal(url, WINDOWS_MEDIA_BRIDGE.url);
    return new Response(null, {status: 302, headers: {location: 'https://example.invalid/untrusted.exe'}});
  }}), rejectedCode('untrusted-download-redirect'));
  assert.equal(calls, 1);
  await assert.rejects(ensureTrustedMediaBridge({dataDir: directory, reuseOriginalDsh: false, fetchImpl: async () => new Response('oversize', {headers: {'content-length': String(WINDOWS_MEDIA_BRIDGE.maxBytes + 1)}})}), rejectedCode('download-size-rejected'));
  const cache = path.join(directory, 'bin', 'media-bridge', WINDOWS_MEDIA_BRIDGE.tag);
  assert.deepEqual(await fs.readdir(cache), []);
});

test('untrusted downloaded bytes are removed without publishing an executable', {skip: process.platform !== 'win32'}, async t => {
  const directory = await temporary(t);
  const bytes = Buffer.alloc(WINDOWS_MEDIA_BRIDGE.minBytes, 7);
  bytes.write('MZ');
  await assert.rejects(ensureTrustedMediaBridge({dataDir: directory, reuseOriginalDsh: false, fetchImpl: async () => new Response(bytes)}), rejectedCode('executable-sha256-rejected'));
  assert.deepEqual(await fs.readdir(path.join(directory, 'bin', 'media-bridge', WINDOWS_MEDIA_BRIDGE.tag)), []);
});

test('NDJSON multiplexes events and out-of-order responses with fragmented Unicode', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const events = [];
  const requests = [];
  output.on('data', chunk => requests.push(JSON.parse(chunk.toString())));
  const rpc = createMediaRpc(input, output, {onEvent: value => events.push(value)});
  try {
    const hello = rpc.call('hello');
    const status = rpc.call('status');
    assert.deepEqual(requests.map(item => item.id), [1, 2]);
    const bytes = Buffer.from('{"event":"status","text":"音频"}\n{"id":2,"ok":true,"result":{"sources":[]}}\n{"id":1,"ok":true,"result":{"protocol":1}}\n');
    const split = bytes.indexOf(Buffer.from('音')) + 1;
    input.write(bytes.subarray(0, split));
    input.write(bytes.subarray(split));
    assert.equal((await hello).protocol, 1);
    assert.deepEqual(await status, {sources: []});
    assert.equal(events[0].text, '音频');
  } finally { rpc.dispose(); input.destroy(); output.destroy(); }
});

test('NDJSON rejects bounded overflow, malformed responses and timeouts', async () => {
  for (const [options, payload, code] of [
    [{maxLineBytes: 16}, 'x'.repeat(17), 'media-rpc-line-limit'],
    [{maxTotalBytes: 16}, ' '.repeat(17), 'media-rpc-output-limit'],
    [{}, 'not JSON\n', 'media-rpc-invalid-json'],
  ]) {
    const input = new PassThrough();
    const output = new PassThrough();
    const rpc = createMediaRpc(input, output, options);
    const response = rpc.call('hello');
    input.write(payload);
    await assert.rejects(response, rejectedCode(code));
    rpc.dispose(); input.destroy(); output.destroy();
  }
  const input = new PassThrough();
  const output = new PassThrough();
  const rpc = createMediaRpc(input, output);
  await assert.rejects(rpc.call('hello', {}, 15), rejectedCode('media-rpc-timeout'));
  rpc.dispose(); input.destroy(); output.destroy();
});

test('diagnostics distinguish silence, no playback, unavailable providers and disabled audio without track details', () => {
  const base = {hello: {protocol: 1, provider: 'windows'}, status: {sources: [{name: 'audio', state: 'running'}, {name: 'metadata', state: 'idle'}, {name: 'lyrics', state: 'idle'}]}, now: {hasMedia: false, track: {title: 'private title', artist: 'private artist'}}, bands: Array(64).fill(0), spectrumFrames: 3};
  const quiet = summarizeMediaProbe(base);
  assert.equal(quiet.audio.availability, 'available');
  assert.equal(quiet.audio.signal, 'silence');
  assert.equal(quiet.audio.bandCount, 64);
  assert.equal(quiet.nowPlaying.availability, 'available');
  assert.equal(quiet.nowPlaying.hasMedia, false);
  assert.equal(JSON.stringify(quiet).includes('private'), false);
  assert.equal(summarizeMediaProbe({...base, bands: [21, ...Array(63).fill(0)]}).audio.signal, 'present');
  const absent = summarizeMediaProbe({...base, status: {sources: [{name: 'audio', state: 'error'}, {name: 'metadata', state: 'unsupported'}]}, bands: []});
  assert.equal(absent.audio.availability, 'unavailable');
  assert.equal(absent.audio.signal, 'not-sampled');
  assert.equal(absent.nowPlaying.availability, 'unavailable');
  assert.equal(summarizeMediaProbe({...base, audio: false}).audio.availability, 'disabled');
  assert.equal(summarizeMediaProbe({...base, status: {sources: []}}).nowPlaying.availability, 'pending');
  assert.throws(() => summarizeMediaProbe({...base, hello: {protocol: 2}}), rejectedCode('unsupported-media-bridge-protocol'));
});

test('verified official helper controls only its mock provider and confirms state readback', {skip: process.platform !== 'win32' || process.env.GPT_MEDIA_BRIDGE_INTEGRATION !== '1', timeout: 35000}, async t => {
  const directory = await temporary(t);
  const provision = await ensureTrustedMediaBridge({dataDir: path.join(directory, 'dsh'), allowDownload: false});
  const bridge = createBridgeSupervisor({binPath: provision.path, cacheDir: path.join(directory, 'mock-cache')});
  try {
    assert.equal(await bridge.start({audio: false, online: false, mock: true}), true);
    // Never send a control action unless the real helper confirms the mock provider.
    assert.equal(bridge.info()?.provider, 'mock');
    assert.equal((await bridge.control('pause')).ok, true);
    assert.equal(bridge.nowPlaying().state, 2);
    assert.equal((await bridge.control('play')).ok, true);
    assert.equal(bridge.nowPlaying().state, 1);
    const previousTrack = bridge.nowPlaying().title;
    assert.equal((await bridge.control('skipNext')).ok, true);
    assert.notEqual(bridge.nowPlaying().title, previousTrack);
    assert.deepEqual(await bridge.control('seek'), {ok: false, error: 'unknown-action'});
    assert.equal(bridge.status().audio.status, 'off');
  } finally {
    const ownPid = bridge.info()?.pid;
    bridge.stop();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (ownPid) assert.throws(() => process.kill(ownPid, 0));
  }
});
