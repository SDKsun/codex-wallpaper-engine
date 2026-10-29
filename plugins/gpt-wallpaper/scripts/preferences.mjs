// DSH schema is vendored unchanged; see ../vendor/dsh/LICENSE and package.json.
// This store persists intent. A host adapter must apply returned settings/assets.
import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {resolveSharedLocal} from './paths.mjs';
import {
  DEFAULTS, KINDS, FONTSET_KEYS, PROFILE_PRESET_KEYS, PROFILE_PRESET_SCHEMA_TAG,
  sanitizeFromSchema, serializeSettings, sanitizePresetValues, sanitizePresetAssets,
  isGlassPresetId, ROPE_FORM_VALUES,
} from '../vendor/dsh/settings-schema.js';

export {
  DEFAULTS, KINDS, FONTSET_KEYS, PROFILE_PRESET_KEYS, PROFILE_PRESET_SCHEMA_TAG,
  SETTINGS_NAMESPACES, SETTINGS_NAMESPACE_NAMES, RESET_MODULES, RESET_TABS,
} from '../vendor/dsh/settings-schema.js';

export const PREFERENCES_MAX_BYTES = 1024 * 1024;
const hostKeys = new Set(Object.keys(sanitizeFromSchema({}, 'host')));
const presetKeys = new Set(PROFILE_PRESET_KEYS);
const queues = new Map();
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const clone = value => JSON.parse(JSON.stringify(value));
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
function hostSettings(raw) {
  const serialized = serializeSettings(sanitizeFromSchema(raw, 'host'));
  return Object.fromEntries(Object.entries(serialized).filter(([key, value]) => hostKeys.has(key) && value !== undefined));
}

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error(`${label} 必须是普通对象`);
  return value;
}
function safeJson(value, label = '数据', seen = new Set(), depth = 0) {
  if (depth > 30) throw new Error(`${label} 嵌套过深`);
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error(`${label} 包含无效数字`); return; }
  if (typeof value !== 'object') throw new Error(`${label} 必须是 JSON 数据`);
  if (Object.getOwnPropertySymbols(value).length) throw new Error(`${label} 包含不安全字段`);
  if (seen.has(value)) throw new Error(`${label} 包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    if (Object.getPrototypeOf(value) !== Array.prototype) throw new Error(`${label} 数组原型无效`);
    if (value.length > 10000) throw new Error(`${label} 数组过长`);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key) || descriptor.get || descriptor.set || !descriptor.enumerable)) throw new Error(`${label} 数组包含不安全字段`);
    }
    for (const child of value) safeJson(child, label, seen, depth + 1);
  } else {
    plain(value, label);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (forbidden.has(key) || descriptor.get || descriptor.set || !descriptor.enumerable) throw new Error(`${label} 包含不安全字段`);
      safeJson(descriptor.value, label, seen, depth + 1);
    }
  }
  seen.delete(value);
}
function keysOnly(value, allowed, label) {
  plain(value, label); safeJson(value, label);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${label} 包含未知字段: ${key}`);
}
function bounded(value) {
  safeJson(value);
  const json = JSON.stringify(value, null, 2) + '\n';
  if (Buffer.byteLength(json) > PREFERENCES_MAX_BYTES) throw new Error('配置文件超过 1 MiB 上限');
  return json;
}
function presetId(id) {
  if (!isGlassPresetId(id) || forbidden.has(id)) throw new Error('无效预设 ID');
  return id;
}
function presetName(name) {
  if (typeof name !== 'string' || !name.trim() || /[\u0000-\u001f\u007f]/.test(name)) throw new Error('预设名称无效');
  return name.trim().slice(0, 64);
}
function validateAssetImage(image, label) {
  keysOnly(image, new Set(['file', 'data', ...(label === 'mascot' ? ['box'] : [])]), label);
  if (typeof image.file !== 'string' || !/^[A-Za-z0-9_-]+\.(png|jpe?g|webp|gif)$/i.test(image.file)) throw new Error('预设图片文件名无效');
  if (image.data !== undefined && (typeof image.data !== 'string' ||
      (image.data && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(image.data) || Buffer.from(image.data, 'base64').toString('base64') !== image.data)))) throw new Error('预设图片不是合法 base64');
}
function assetValues(raw) {
  if (raw === undefined) return {};
  keysOnly(raw, new Set(['font', 'mascot', 'avatar', 'theme']), '预设资产');
  if (raw.font != null) {
    keysOnly(raw.font, new Set(['name', 'values']), '预设字体');
    keysOnly(raw.font.values, new Set(FONTSET_KEYS), '预设字体值');
  }
  if (raw.mascot != null) {
    if (typeof raw.mascot === 'string') {
      if (!ROPE_FORM_VALUES.includes(raw.mascot)) throw new Error('预设吉祥物形态无效');
    } else validateAssetImage(raw.mascot, 'mascot');
  }
  if (raw.avatar != null) {
    keysOnly(raw.avatar, new Set(['user', 'ai']), '预设头像');
    for (const side of Object.keys(raw.avatar)) validateAssetImage(raw.avatar[side], side);
  }
  if (raw.theme !== undefined) {
    keysOnly(raw.theme, new Set(['preference']), '预设主题');
    if (!['dark', 'light'].includes(raw.theme.preference)) throw new Error('预设主题无效');
  }
  const sanitized = sanitizePresetAssets(raw);
  // Reject inputs that schema would silently discard (invalid image name/box, etc.).
  for (const key of ['mascot', 'avatar']) {
    if (raw[key] != null && typeof raw[key] === 'object') {
      const original = key === 'mascot' ? [raw[key]] : Object.values(raw[key]);
      const normalized = key === 'mascot' ? [sanitized[key]] : Object.values(sanitized[key] || {});
      if (original.some((entry, i) => !normalized[i] || normalized[i].file !== entry.file)) throw new Error('预设图片文件名不符合宿主格式');
    }
  }
  return sanitized;
}
function documentOf(raw) {
  keysOnly(raw, new Set(['$schema', 'id', 'name', 'values', 'assets']), '预设');
  if (raw.$schema !== PROFILE_PRESET_SCHEMA_TAG) throw new Error(`不支持的预设版本，需要 ${PROFILE_PRESET_SCHEMA_TAG}`);
  keysOnly(raw.values, presetKeys, '预设值');
  const assets = assetValues(raw.assets);
  const result = {$schema:PROFILE_PRESET_SCHEMA_TAG, id:presetId(raw.id), name:presetName(raw.name), values:sanitizePresetValues(raw.values)};
  if (Object.keys(assets).length) result.assets = assets;
  bounded(result);
  return result;
}

/** Check every existing component, including the root's ancestors, for redirects. */
async function safePath(target, allowMissing = false) {
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const component of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) throw new Error('拒绝通过链接或重定向路径访问配置');
    if (!samePath(await fs.realpath(current), current)) throw new Error('配置路径发生重定向');
  }
}

/**
 * All paths are private to stateRoot; no method accepts an arbitrary file path.
 * Queue scope includes all store instances in this Node process.
 */
export class PreferencesStore {
  constructor({stateRoot} = {}) {
    const local = resolveSharedLocal();
    this.stateRoot = path.resolve(stateRoot ?? (local ? path.join(local, 'GPTWallpaper') : path.join(os.homedir(), '.gpt-wallpaper')));
    this.settingsPath = path.join(this.stateRoot, 'preferences.json');
    this.presetsPath = path.join(this.stateRoot, 'presets');
  }
  async #directory(directory) {
    await safePath(directory, true);
    await fs.mkdir(directory, {recursive:true, mode:0o700});
    await safePath(directory);
  }
  async #read(file) {
    await safePath(file);
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > PREFERENCES_MAX_BYTES) throw new Error('配置文件无效或超过 1 MiB 上限');
      const bytes = Buffer.alloc(stat.size + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(bytes, count, bytes.length - count, count);
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      if (count > PREFERENCES_MAX_BYTES || count !== stat.size) throw new Error('读取期间配置文件发生变化');
      const value = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes.subarray(0,count)));
      safeJson(value);
      return value;
    } finally { await handle.close(); }
  }
  async #write(file, value, createOnly = false) {
    const json = bounded(value);
    await this.#directory(path.dirname(file));
    await safePath(file, true);
    const temporary = path.join(path.dirname(file), `.${path.basename(file)}-${randomUUID()}.tmp`);
    let created = false;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600); created = true;
      try { await handle.writeFile(json, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await safePath(file, true);
      // link is atomic and cannot replace another process's imported preset.
      // The temporary link is removed in finally; updates use atomic rename.
      if (createOnly) await fs.link(temporary, file);
      else await fs.rename(temporary, file);
    } finally { if (created) await fs.unlink(temporary).catch(error => {if (error.code !== 'ENOENT') throw error;}); }
  }
  async #serial(action) {
    const previous = queues.get(this.stateRoot) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(this.stateRoot, current);
    try { return await current; }
    finally { if (queues.get(this.stateRoot) === current) queues.delete(this.stateRoot); }
  }
  #presetPath(id) { return path.join(this.presetsPath, `${presetId(id)}.json`); }
  async readSettings() {
    let stored;
    try { stored = await this.#read(this.settingsPath); }
    catch (error) { if (error.code !== 'ENOENT') throw error; stored = {}; }
    keysOnly(stored, hostKeys, '配置');
    return clone(hostSettings(stored));
  }
  async patchSettings(patch) {
    keysOnly(patch, hostKeys, '配置补丁');
    if ('settingsVersion' in patch && patch.settingsVersion !== DEFAULTS.settingsVersion) throw new Error('配置版本由系统管理');
    bounded(patch);
    return this.#serial(async () => {
      const current = await this.readSettings();
      const settings = hostSettings({...current, ...clone(patch)});
      await this.#write(this.settingsPath, settings);
      return clone(settings);
    });
  }
  async resetSettings(keys = null) {
    if (keys === null) return this.#serial(async () => {
      const settings = hostSettings({});
      await this.#write(this.settingsPath, settings); return clone(settings);
    });
    if (!Array.isArray(keys) || keys.some(key => typeof key !== 'string' || !hostKeys.has(key))) throw new Error('重置字段无效');
    const defaults = sanitizeFromSchema({}, 'host');
    return this.patchSettings(Object.fromEntries(keys.map(key => [key, defaults[key]])));
  }
  async listPresets() {
    try { await safePath(this.presetsPath); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const entries = await fs.readdir(this.presetsPath, {withFileTypes:true});
    if (entries.length > 256) throw new Error('预设目录项目过多');
    const presets = [];
    for (const entry of entries.sort((a,b) => a.name.localeCompare(b.name))) {
      if (!entry.name.endsWith('.json')) continue;
      if (entry.isSymbolicLink() || !entry.isFile()) throw new Error('预设目录包含不安全项目');
      const preset = await this.readPreset(entry.name.slice(0,-5));
      presets.push({id:preset.id, name:preset.name, assets:Object.keys(preset.assets || {})});
    }
    return presets;
  }
  async readPreset(id) {
    const preset = documentOf(await this.#read(this.#presetPath(id)));
    if (preset.id !== id) throw new Error('预设内容与文件 ID 不一致');
    return preset;
  }
  async createPreset(input = {}) {
    keysOnly(input, new Set(['id', 'name', 'values', 'assets']), '创建预设');
    const {id = `preset-${randomUUID()}`, name, values, assets} = input;
    const current = values === undefined ? await this.readSettings() : values;
    const settings = {};
    keysOnly(current, hostKeys, '配置快照');
    for (const key of PROFILE_PRESET_KEYS) if (Object.hasOwn(current,key)) settings[key] = current[key];
    return this.importPreset({$schema:PROFILE_PRESET_SCHEMA_TAG, id, name, values:settings, ...(assets === undefined ? {} : {assets})});
  }
  async importPreset(document, options = {}) {
    // Import only adds to the library; applying is always an explicit method.
    keysOnly(options, new Set(['id']), '导入选项');
    safeJson(document, '预设');
    const {id} = options;
    const preset = documentOf(id === undefined ? document : {...plain(document,'预设'), id:presetId(id)});
    return this.#serial(async () => {
      const file = this.#presetPath(preset.id);
      await safePath(file, true);
      try { await fs.lstat(file); throw new Error('此预设 ID 已存在，请使用新 ID'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      await this.#write(file, preset, true);
      return clone(preset);
    });
  }
  async exportPreset(id) { return clone(await this.readPreset(id)); }
  async applyPreset(id) {
    return this.#serial(async () => {
      const preset = await this.readPreset(id);
      const current = await this.readSettings();
      const settings = hostSettings({...current, ...preset.values});
      await this.#write(this.settingsPath, settings);
      return {settings:clone(settings), assets:clone(preset.assets || {}), preset:clone(preset)};
    });
  }
  async deletePreset(id) {
    return this.#serial(async () => {
      const file = this.#presetPath(id);
      await safePath(file); await this.readPreset(id); await fs.unlink(file);
      return {deleted:id};
    });
  }
}

export const createPreferencesStore = options => new PreferencesStore(options);
