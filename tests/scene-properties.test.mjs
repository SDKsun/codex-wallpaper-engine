import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {describeSceneProperties, readSceneProperties, sanitizePropertyOverrides} from '../plugins/gpt-wallpaper/scripts/scene-properties.mjs';

const project = {
  general: {
    localization: {
      'zh-CHS': {amount: '数量', choice: '选项', mixed: '中文标签'},
      'en-US': {enabled: 'Enabled in English', optionOne: 'Numeric one'},
    },
    properties: {
      choice: {type: 'combo', text: 'Raw', order: 1.5, value: 1, condition: 'enabled == true', options: [{label: 'optionOne', value: 1}, {label: 'String one', value: '1'}, {label: 'No', value: false}]},
      amount: {type: 'slider', order: 1.25, value: '3.5', min: 0, max: 8, step: 0.25, precision: 2},
      enabled: {type: 'bool', order: 1.5, value: true},
      color: {type: 'color', order: 2, value: '0.2 0.4 0.6'},
      title: {type: 'text', order: 3, text: '<b>Section</b><br>Details'},
      caption: {type: 'textinput', order: 4, value: 'Hello'},
      file: {type: 'file', order: 5, value: 'materials/image.png', fileType: 'image'},
      internal: {type: 'slider', editable: false, value: 7},
      missingType: {value: 10},
    },
  },
};

test('scene property descriptors preserve float ordering, per-key localization and combo primitive types', () => {
  const result = describeSceneProperties(project);
  assert.deepEqual(result.descriptors.map(item => item.name), ['amount', 'choice', 'enabled', 'color', 'title', 'caption', 'file']);
  const byName = Object.fromEntries(result.descriptors.map(item => [item.name, item]));
  assert.equal(byName.amount.text, '数量');
  assert.equal(byName.enabled.text, 'Enabled in English');
  assert.equal(byName.title.text, 'Section\nDetails');
  assert.equal(byName.choice.options[0].label, 'Numeric one');
  assert.deepEqual(byName.choice.options.map(item => item.value), [1, '1', false]);
  assert.equal(byName.choice.condition, 'enabled == true');
  assert.equal(result.defaults.amount, 3.5);
  assert.equal(Object.hasOwn(result.defaults, 'title'), false);
  assert.equal(Object.hasOwn(result.defaults, 'internal'), false);
  const ties = describeSceneProperties({general: {properties: {b: {type: 'bool', order: 1, value: true}, A: {type: 'bool', order: 1, value: false}}}});
  assert.deepEqual(ties.descriptors.map(item => item.name), ['A', 'b']);
});

test('typed property overrides clamp sliders and preserve all declared values regardless of display condition', () => {
  const result = describeSceneProperties(project, {amount: 999, enabled: false, choice: '1', color: '#ff8000', caption: 'Line 1\nLine 2'});
  assert.equal(result.properties.amount, 8);
  assert.equal(result.properties.enabled, false);
  assert.equal(result.properties.choice, '1');
  assert.equal(typeof result.properties.choice, 'string');
  assert.equal(result.properties.color, '1 0.50196078 0');
  assert.equal(result.properties.file, 'materials/image.png');
  assert.equal(result.descriptors.find(item => item.name === 'choice').overridden, true);
  assert.equal(result.descriptors.find(item => item.name === 'choice').condition, 'enabled == true');
  assert.equal(sanitizePropertyOverrides(result.descriptors, {choice: false}).choice, false);
  assert.equal(sanitizePropertyOverrides(result.descriptors, {amount: -2}).amount, 0);
  assert.equal(describeSceneProperties(project, {removedByAuthor: true, amount: 4}).properties.amount, 4);
  assert.equal(Object.hasOwn(describeSceneProperties(project, {removedByAuthor: true}).properties, 'removedByAuthor'), false);
  assert.throws(() => describeSceneProperties(project, {removedByAuthor: true}, {strict: true}));
});

test('property sanitization rejects prototype keys, type confusion, nonfinite values and project escapes', () => {
  const descriptors = describeSceneProperties(project).descriptors;
  for (const value of [[], null, new Date(), Object.assign(Object.create({inherited: true}), {amount: 1})]) {
    assert.throws(() => sanitizePropertyOverrides(descriptors, value));
  }
  for (const value of [JSON.parse('{"__proto__":1}'), {constructor: 1}, {undeclared: 1}, {amount: Infinity}, {amount: '1'}, {enabled: 1}, {choice: true}, {choice: {}}, {color: '1 2 3'}, {title: 'Not input'}, {caption: 'x\0y'}, {file: '../outside.png'}, {file: 'C:\\private.png'}, {file: 'https://example.com/image.png'}]) {
    assert.throws(() => sanitizePropertyOverrides(descriptors, value));
  }
  assert.deepEqual({...sanitizePropertyOverrides(descriptors, {amount: 5, unknown: true, enabled: 'false'}, {strict: false})}, {amount: 5});
  const parsed = describeSceneProperties(JSON.parse('{"general":{"properties":{"__proto__":{"type":"slider","value":1},"constructor":{"type":"bool","value":true},"ok":{"type":"bool","value":false}}}}'));
  assert.deepEqual(parsed.descriptors.map(item => item.name), ['ok']);
  assert.equal({}.polluted, undefined);
});

test('scene project metadata has a 1 MiB bound and cannot be read through a redirected project root', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scene-properties-'));
  const root = path.join(temp, 'project');
  await fs.mkdir(root);
  try {
    await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(project));
    const read = await readSceneProperties(await fs.realpath(root), {amount: 6});
    assert.equal(read.properties.amount, 6);
    await fs.writeFile(path.join(root, 'project.json'), ' '.repeat(1024 * 1024 + 1));
    await assert.rejects(readSceneProperties(await fs.realpath(root)), /1 MiB/);
    await fs.writeFile(path.join(root, 'project.json'), JSON.stringify(project));
    const linked = path.join(temp, 'linked');
    await fs.symlink(root, linked, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(readSceneProperties(linked));
  } finally { await fs.rm(temp, {recursive: true, force: true}); }
});

function events(target = {}) {
  const handlers = new Map();
  target.addEventListener = (name, callback) => { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(callback); };
  target.removeEventListener = (name, callback) => { handlers.set(name, (handlers.get(name) ?? []).filter(item => item !== callback)); };
  target.dispatch = (name, event = {}) => { for (const callback of handlers.get(name) ?? []) callback(event); };
  return target;
}

async function runtime(payload = {settings: {}, properties: {}}, responseStatus = 200) {
  const source = await fs.readFile(new URL('../plugins/gpt-wallpaper/ui/scene.js', import.meta.url), 'utf8');
  const host = {style: {}};
  const error = {hidden: true, textContent: ''};
  const canvas = events({});
  const document = events({hidden: false, body: {dataset: {}}, getElementById: name => name === 'scene' ? host : error});
  const window = events({});
  const messages = [];
  const parent = {postMessage: message => messages.push(message)};
  const calls = {paused: false, fps: 30, properties: {}, pointers: [], disposed: false};
  const intervals = new Map();
  let nextTimer = 0;
  let scope;
  const instance = {
    canvas, pause() { calls.paused = true; }, resume() { calls.paused = false; },
    setFps(value) { calls.fps = value; }, setFit(value) { calls.fit = value; }, setVolume(value) { calls.volume = value; },
    setProperties(value) { calls.properties = JSON.parse(JSON.stringify(value)); }, getProperties() { return vm.runInContext('({amount:2,embedded:false})', scope); },
    pushPointer(...value) { calls.pointers.push(value); }, pointerLeave() { calls.left = true; },
    on() {}, load() { calls.loaded = true; return Promise.resolve(); }, destroy() { calls.disposed = true; },
    get stats() { return {fps: calls.fps, running: !calls.paused}; },
  };
  let currentPayload = payload;
  scope = vm.createContext({
    window, parent, document, navigator: {}, location: {origin: 'http://127.0.0.1:1234', pathname: '/s/' + 'a'.repeat(64) + '/scene/' + 'b'.repeat(24)},
    devicePixelRatio: 1, innerWidth: 1000, innerHeight: 500, AbortSignal,
    WebWallGL: {createScene: () => instance, httpSource: url => url},
    fetch: async () => ({ok: responseStatus === 200, status: responseStatus, text: async () => JSON.stringify(currentPayload)}),
    setInterval: (callback, delay) => { const id = ++nextTimer; intervals.set(id, {callback, delay}); return id; },
    clearInterval: id => intervals.delete(id),
  });
  vm.runInContext(source, scope);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  await settle();
  return {
    calls, host, document, window, parent, messages, intervals,
    send(value, fromParent = true) {
      const data = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify(value))})`, scope);
      window.dispatch('message', {source: fromParent ? parent : {}, origin: 'http://127.0.0.1:1234', data});
    },
    async poll(value) { currentPayload = value; [...intervals.values()].find(item => item.delay === 2000).callback(); await settle(); },
    async visible(value) { document.hidden = !value; document.dispatch('visibilitychange'); await settle(); },
    status: window.__sceneDiagnostics,
  };
}

test('scene runtime applies the DSH playback keys and hot property values without reloading the scene', async () => {
  const env = await runtime({settings: {sceneLiveFps: 60, objectFit: 'fill', videoVolume: 0.7, videoAudioEnabled: false, wallpaperBlur: 12, backgroundBrightness: 120, backgroundContrast: 150, backgroundSaturate: 80, wallpaperOpacity: 25, flip: true, layerPositionX: 60, layerScale: 120}, properties: {amount: 6, choice: false}});
  assert.equal(env.status.ready, true);
  assert.equal(env.calls.fps, 60);
  assert.equal(env.calls.fit, 'stretch');
  assert.equal(env.calls.volume, 0);
  assert.equal(env.host.style.filter, 'blur(12px) brightness(120%) contrast(150%) saturate(80%)');
  assert.equal(env.host.style.opacity, '0.75');
  assert.equal(env.host.style.transform, 'translate(5%, 0%) scale(-1.2, 1.2)');
  assert.deepEqual(env.calls.properties, {amount: 6, embedded: false, choice: false});
  await env.poll({settings: {sceneLiveFps: 15, videoAudioEnabled: true}, properties: {}});
  assert.equal(env.calls.fps, 15); assert.equal(env.calls.volume, 0.7);
  assert.deepEqual(env.calls.properties, {amount: 2, embedded: false});
  assert.equal(env.messages.some(item => item.type === 'gpt-wallpaper:ready'), true);
});

test('user pause survives visibility and focus changes and malformed settings cannot alter playback', async () => {
  const env = await runtime();
  env.send({type: 'gpt-wallpaper:pause', paused: true});
  await env.visible(false); await env.visible(true);
  assert.equal(env.calls.paused, true);
  env.send({type: 'gpt-wallpaper:settings', settings: {pauseOnBlur: true}, properties: {}});
  env.send({type: 'gpt-wallpaper:focus', focused: true});
  assert.equal(env.calls.paused, true);
  env.send({type: 'gpt-wallpaper:pause', paused: false});
  assert.equal(env.calls.paused, false);
  env.send({type: 'gpt-wallpaper:focus', focused: false});
  assert.equal(env.calls.paused, true);
  env.send({type: 'gpt-wallpaper:focus', focused: true});
  assert.equal(env.calls.paused, false);
  env.send({type: 'gpt-wallpaper:pause', paused: true}, false);
  assert.equal(env.calls.paused, false);
  env.send({type: 'gpt-wallpaper:pause', paused: 'true'});
  assert.equal(env.calls.paused, false);
  env.send({type: 'gpt-wallpaper:settings', settings: {sceneLiveFps: '60'}, properties: {}});
  assert.equal(env.calls.fps, 30); assert.match(env.status.settingsError, /帧率/);
  env.send({type: 'gpt-wallpaper:settings', settings: {}, properties: JSON.parse('{"__proto__":1}')});
  assert.match(env.status.settingsError, /名称/);
});

test('scene pointer forwarding follows mirroring and page teardown releases timers and GPU resources', async () => {
  const env = await runtime({}, 404);
  assert.equal(env.status.ready, true);
  env.send({type: 'gpt-wallpaper:settings', settings: {flip: true}, properties: {}});
  env.send({type: 'gpt-wallpaper:pointer', u: 0.2, v: 0.4, buttons: 1, mods: 2});
  assert.deepEqual(env.calls.pointers.at(-1), [0.8, 0.4, 1, 2]);
  const before = env.calls.pointers.length;
  env.send({type: 'gpt-wallpaper:pointer', u: 0.5, v: 0.5}, false);
  assert.equal(env.calls.pointers.length, before);
  env.send({type: 'gpt-wallpaper:leave'}); assert.equal(env.calls.left, true);
  assert.equal(env.intervals.size, 2);
  env.window.dispatch('pagehide');
  assert.equal(env.intervals.size, 0); assert.equal(env.calls.disposed, true);
});
