import fs from 'node:fs/promises';
import {safeProjectFile} from './steam.mjs';

// The descriptor shape and the type/order/localization rules follow DSH's
// lib/we-props.js. In particular, text is explanatory content; textinput is an
// editable string. Combo values keep their original JSON primitive type.
const MAX_PROJECT_BYTES = 1024 * 1024;
const MAX_PROPERTIES = 512;
const RESERVED = new Set(['__proto__', 'prototype', 'constructor']);
const TYPES = new Set(['color', 'bool', 'slider', 'combo', 'text', 'textinput', 'file', 'directory', 'group', 'other']);
const LANGUAGES = ['zh-chs', 'zh-cht', 'en-us'];
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [null, Object.prototype].includes(Object.getPrototypeOf(value));
const safeName = value => typeof value === 'string' && value.length > 0 && value.length <= 128
  && !RESERVED.has(value) && !/[\u0000-\u001f\u007f]/.test(value);
const scalar = value => typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))
  || (typeof value === 'string' && value.length <= 8192 && !value.includes('\0'));

function cleanText(value, fallback = '') {
  if (typeof value !== 'string') return fallback;
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#0?39;|&apos;/gi, "'")
    .replace(/\0/g, '').trim().slice(0, 2048) || fallback;
}

function label(project, raw, key, fallback) {
  const table = project?.general?.localization;
  if (plain(table)) {
    const languages = new Map(Object.entries(table).map(([name, values]) => [name.toLowerCase(), values]));
    for (const language of LANGUAGES) {
      const values = languages.get(language);
      if (plain(values) && own(values, key) && typeof values[key] === 'string' && values[key].trim()) {
        return cleanText(values[key], fallback);
      }
    }
  }
  return cleanText(raw, fallback);
}

function finiteField(definition, key) {
  if (!own(definition, key) || definition[key] === null || definition[key] === '') return undefined;
  const value = Number(definition[key]);
  return Number.isFinite(value) ? value : undefined;
}

function condition(value) {
  return typeof value === 'string' && value.length <= 2048 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
    ? value.trim() : undefined;
}

function colorValue(value) {
  if (typeof value !== 'string') throw new TypeError('颜色属性需要 RGB 字符串');
  const hex = /^#([\da-f]{6})$/i.exec(value);
  const parts = hex ? [0, 2, 4].map(offset => parseInt(hex[1].slice(offset, offset + 2), 16) / 255)
    : value.trim().split(/\s+/).map(Number);
  if (parts.length !== 3 || !parts.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
    throw new TypeError('颜色属性需要 0 到 1 的三个 RGB 分量');
  }
  return parts.map(value => Number(value.toFixed(8))).join(' ');
}

function relativeAsset(value) {
  if (typeof value !== 'string' || value.length > 1024 || /[\u0000-\u001f\u007f:]/.test(value)) {
    throw new TypeError('文件属性需要项目内相对路径');
  }
  const normalized = value.replaceAll('\\', '/');
  if (normalized.startsWith('/') || normalized.split('/').some(part => part === '..' || part === '.')) {
    throw new TypeError('文件属性不能离开壁纸项目');
  }
  return normalized;
}

function valueFor(descriptor, value, {fromDefault = false} = {}) {
  switch (descriptor.ptype) {
    case 'bool':
      if (typeof value !== 'boolean') throw new TypeError('开关属性需要布尔值');
      return value;
    case 'slider': {
      const number = fromDefault && typeof value === 'string' && value.trim() ? Number(value) : value;
      if (typeof number !== 'number' || !Number.isFinite(number)) throw new TypeError('滑块属性需要有限数字');
      return Math.min(descriptor.max ?? Infinity, Math.max(descriptor.min ?? -Infinity, number));
    }
    case 'color': return colorValue(value);
    case 'combo':
      if (!scalar(value)) throw new TypeError('选项属性需要标量值');
      if (descriptor.options?.length && !descriptor.options.some(option => Object.is(option.value, value))) {
        throw new TypeError('选项不在壁纸声明的列表中');
      }
      return value;
    case 'file':
    case 'directory': return relativeAsset(value);
    case 'textinput':
      if (typeof value !== 'string' || value.length > 8192 || value.includes('\0')) throw new TypeError('文本属性无效或过长');
      return value;
    case 'text':
    case 'group':
    case 'other':
      if (!fromDefault) throw new TypeError('此属性是说明内容，不可编辑');
      if (!scalar(value)) throw new TypeError('默认属性值无效');
      return value;
    default: throw new TypeError('不支持的壁纸属性类型');
  }
}

export function sanitizePropertyOverrides(descriptors, overrides, {strict = true} = {}) {
  if (!Array.isArray(descriptors) || descriptors.length > MAX_PROPERTIES) throw new TypeError('属性描述无效');
  if (!plain(overrides)) throw new TypeError('属性覆盖需要普通对象');
  if (Object.keys(overrides).length > MAX_PROPERTIES) throw new TypeError('属性数量过多');
  const known = new Map(descriptors.map(descriptor => [descriptor.name, descriptor]));
  const result = Object.create(null);
  for (const [name, value] of Object.entries(overrides)) {
    try {
      if (!safeName(name) || !known.has(name)) throw new TypeError('未声明的壁纸属性');
      result[name] = valueFor(known.get(name), value);
    } catch (error) {
      if (strict) throw new TypeError(`属性 ${safeName(name) ? name : '(无效名称)'}：${error.message}`);
    }
  }
  return result;
}

export function describeSceneProperties(project, overrides = {}, {strict = false} = {}) {
  if (project !== null && !plain(project)) throw new TypeError('项目描述需要普通对象');
  const raw = project?.general?.properties;
  if (raw !== undefined && !plain(raw)) throw new TypeError('项目属性需要普通对象');
  const entries = raw ? Object.entries(raw) : [];
  if (entries.length > MAX_PROPERTIES) throw new TypeError('壁纸属性超过 512 项');
  const descriptors = [];
  const defaults = Object.create(null);
  for (const [name, definition] of entries) {
    if (!safeName(name) || !plain(definition) || typeof definition.type !== 'string' || definition.editable === false) continue;
    const descriptor = {
      name,
      ptype: TYPES.has(definition.type) ? definition.type : 'other',
      text: label(project, definition.text, name, name),
      order: finiteField(definition, 'order') ?? 0,
      value: null,
      default: null,
      overridden: false,
    };
    const displayCondition = condition(definition.condition);
    if (displayCondition) descriptor.condition = displayCondition;
    for (const field of ['min', 'max', 'step', 'precision']) {
      const number = finiteField(definition, field);
      if (number !== undefined) descriptor[field] = number;
    }
    if (descriptor.min !== undefined && descriptor.max !== undefined && descriptor.min > descriptor.max) {
      [descriptor.min, descriptor.max] = [descriptor.max, descriptor.min];
    }
    if (descriptor.step !== undefined && descriptor.step <= 0) delete descriptor.step;
    if (descriptor.precision !== undefined && (!Number.isInteger(descriptor.precision) || descriptor.precision < 0 || descriptor.precision > 10)) delete descriptor.precision;
    if (Array.isArray(definition.options)) {
      const options = definition.options.slice(0, MAX_PROPERTIES).filter(option => plain(option) && typeof option.label === 'string' && scalar(option.value))
        .map(option => {
          const item = {label: label(project, option.label, option.label, String(option.value)), value: option.value};
          const displayCondition = condition(option.condition);
          if (displayCondition) item.condition = displayCondition;
          return item;
        });
      if (options.length) descriptor.options = options;
    }
    if (typeof definition.fileType === 'string') descriptor.fileType = definition.fileType.slice(0, 64);
    if (own(definition, 'value') && definition.value !== null) {
      try {
        descriptor.default = valueFor(descriptor, definition.value, {fromDefault: true});
        descriptor.value = descriptor.default;
        defaults[name] = descriptor.default;
      } catch { /* Malformed author defaults must not enter the renderer. */ }
    }
    descriptors.push(descriptor);
  }
  descriptors.sort((a, b) => a.order - b.order || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  // Saved overrides can outlive an author's property definition. Ignore those
  // stale entries while explicit edit requests use the strict sanitizer above.
  const clean = sanitizePropertyOverrides(descriptors, overrides, {strict});
  const properties = Object.assign(Object.create(null), defaults, clean);
  for (const descriptor of descriptors) {
    if (own(clean, descriptor.name)) {
      descriptor.value = clean[descriptor.name];
      descriptor.overridden = true;
    }
  }
  return {descriptors, defaults, properties};
}

export async function readSceneProperties(projectRoot, overrides = {}, options = {}) {
  const file = await safeProjectFile(projectRoot, 'project.json');
  if (file.stat.size > MAX_PROJECT_BYTES) throw new TypeError('场景项目描述超过 1 MiB');
  const bytes = await fs.readFile(file.path);
  if (bytes.length > MAX_PROJECT_BYTES) throw new TypeError('场景项目描述超过 1 MiB');
  const project = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  return describeSceneProperties(project, overrides, options);
}
