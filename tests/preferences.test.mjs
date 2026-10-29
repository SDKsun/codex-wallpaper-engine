import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {
  PreferencesStore, DEFAULTS, PROFILE_PRESET_SCHEMA_TAG, PREFERENCES_MAX_BYTES,
} from '../plugins/gpt-wallpaper/scripts/preferences.mjs';

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wallpaper-preferences-'));
  try { await run(new PreferencesStore({stateRoot:path.join(temporary,'store')}), temporary); }
  finally {
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await fs.rm(temporary, {recursive:true, force:true});
  }
}

test('vendored DSH schema and MIT attribution match the pinned upstream blobs', async () => {
  const hash = async file => createHash('sha256').update(await fs.readFile(new URL(file, import.meta.url))).digest('hex');
  assert.equal(await hash('../plugins/gpt-wallpaper/vendor/dsh/settings-schema.js'), 'a572ff4776355f89ab0f650b2d0e50cdcbc4cd02e7bfdd5cd76b7823e7f92cf1');
  assert.equal(await hash('../plugins/gpt-wallpaper/vendor/dsh/LICENSE'), 'a116f28b94e928c3b22acc3346cbd29b3cb2fddd68f73be5c9b93d7626f20cf6');
});

test('DSH defaults, range/enum normalization and concurrent patches persist across instances', async () => fixture(async store => {
  const defaults = await store.readSettings();
  assert.equal(defaults.settingsVersion, 6);
  assert.equal(defaults.blur, DEFAULTS.blur);
  assert.equal(defaults.scrim, DEFAULTS.scrim);
  const first = await store.patchSettings({blur:23, playbackRate:1.5, sceneLiveFps:60, accent:'#0a22ff'});
  assert.equal(first.blur,23); assert.equal(first.playbackRate,1.5); assert.equal(first.sceneLiveFps,60);
  const second = new PreferencesStore({stateRoot:store.stateRoot});
  assert.equal((await second.readSettings()).accent,'#0a22ff');
  await Promise.all([store.patchSettings({scrim:0.6}), second.patchSettings({wallpaperBlur:7}), store.patchSettings({fxEnabled:true})]);
  const current = await second.readSettings();
  assert.equal(current.scrim,0.6); assert.equal(current.wallpaperBlur,7); assert.equal(current.fxEnabled,true);
  const normalized = await second.patchSettings({blur:500, playbackRate:-1, objectFit:'arbitrary', accent:'url(evil)'});
  assert.equal(normalized.blur,DEFAULTS.blur); assert.equal(normalized.playbackRate,DEFAULTS.playbackRate);
  assert.equal(normalized.objectFit,DEFAULTS.objectFit); assert.equal(normalized.accent,DEFAULTS.accent);
  current.scrim = 0;
  assert.equal((await store.readSettings()).scrim,0.6);
}));

test('settings reject unknown keys, prototype pollution, accessors and malformed JSON values', async () => fixture(async store => {
  for (const invalid of [null, [], 'text', {unknown:true}, {frameVariants:{}}, {globalFamily:'system'},
    {settingsVersion:1}, JSON.parse('{"__proto__":{"polluted":true}}'), {userProps:JSON.parse('{"x":{"constructor":"evil"}}')},
    Object.assign(Object.create({polluted:true}),{blur:4}), {blur:NaN}, {hiddenIds:[undefined]}]) {
    await assert.rejects(store.patchSettings(invalid));
  }
  let accessed = false;
  await assert.rejects(store.patchSettings({get blur(){accessed=true;return 5;}}));
  assert.equal(accessed,false);
  await assert.rejects(store.patchSettings({[Symbol('hidden')]:'bad'}));
  const inheritedArray = [];
  Object.setPrototypeOf(inheritedArray, { [Symbol.iterator]() { accessed = true; return [][Symbol.iterator](); } });
  await assert.rejects(store.patchSettings({hiddenIds:inheritedArray}));
  assert.equal(accessed,false);
  const cycle = {}; cycle.self = cycle;
  await assert.rejects(store.patchSettings({userProps:cycle}));
  assert.equal({}.polluted,undefined);
  assert.equal((await store.readSettings()).blur,DEFAULTS.blur);
}));

test('preset creation/import is separate from apply; exports preserve DSH schema and assets', async () => fixture(async store => {
  await store.patchSettings({id:'local-wallpaper', hiddenIds:['keep-hidden'], blur:10, scrim:0.4});
  const preset = await store.createPreset({id:'soft-glass',name:' 柔和玻璃 ', values:{blur:27,scrim:0.1}, assets:{font:null,mascot:'gpt',avatar:null,theme:{preference:'dark'}}});
  assert.equal(preset.$schema,PROFILE_PRESET_SCHEMA_TAG); assert.equal(preset.name,'柔和玻璃');
  assert.equal((await store.readSettings()).blur,10);
  assert.ok(!Object.hasOwn(preset.values,'id')); assert.ok(!Object.hasOwn(preset.values,'hiddenIds'));
  const exported = await store.exportPreset('soft-glass');
  assert.deepEqual(exported.assets,{font:null,mascot:'gpt',avatar:null,theme:{preference:'dark'}});
  const imported = await store.importPreset(JSON.parse(JSON.stringify(exported)),{id:'shared-copy'});
  assert.equal(imported.id,'shared-copy'); assert.equal((await store.readSettings()).blur,10);
  assert.equal((await store.listPresets()).length,2);
  const applied = await store.applyPreset('shared-copy');
  assert.equal(applied.settings.blur,27); assert.equal(applied.settings.scrim,0.1);
  assert.equal(applied.settings.id,'local-wallpaper'); assert.deepEqual(applied.settings.hiddenIds,['keep-hidden']);
  assert.deepEqual(applied.assets,exported.assets);
  const reopened = new PreferencesStore({stateRoot:store.stateRoot});
  assert.equal((await reopened.readSettings()).blur,27);
  await store.deletePreset('soft-glass');
  assert.deepEqual((await store.listPresets()).map(p=>p.id),['shared-copy']);
}));

test('preset IDs, unknown fields, versions, asset paths and duplicate imports fail closed', async () => fixture(async store => {
  const good = {$schema:PROFILE_PRESET_SCHEMA_TAG,id:'valid',name:'Valid',values:{blur:20}};
  for (const invalid of [null, [], {...good,$schema:'old-schema'}, {...good,id:'../outside'},
    {...good,id:'export'}, {...good,id:'constructor'}, {...good,command:'run'}, {...good,name:'bad\nname'},
    {...good,values:{id:'other-wallpaper'}}, {...good,values:{unknown:3}},
    {...good,assets:{mascot:{file:'../../outside.png',data:'YWJj'}}},
    {...good,assets:{mascot:'unknown-form'}}, {...good,assets:{theme:{preference:'auto'}}},
    {...good,assets:{font:{name:'a',values:{unknown:4}}}}, {...good,assets:{script:'run'}}]) {
    await assert.rejects(store.importPreset(invalid));
  }
  await store.importPreset(good);
  await assert.rejects(store.importPreset(good), /已存在/);
  await assert.rejects(store.readPreset('../valid'));
  await assert.rejects(store.deletePreset('valid/..'));
  await assert.rejects(store.createPreset({name:'a',command:'bad'}));
  const exported = await store.exportPreset('valid'); exported.values.blur = 1;
  assert.equal((await store.readPreset('valid')).values.blur,20);
}));

test('bounded persistence rejects oversized or corrupt files and selective reset preserves other settings', async () => fixture(async store => {
  await store.patchSettings({blur:25,scrim:0.5});
  await store.resetSettings(['blur']);
  assert.equal((await store.readSettings()).blur,DEFAULTS.blur);
  assert.equal((await store.readSettings()).scrim,0.5);
  await assert.rejects(store.resetSettings(['unknown']));
  await assert.rejects(store.patchSettings({id:'x'.repeat(PREFERENCES_MAX_BYTES)}), /1 MiB/);
  const before = await fs.readFile(store.settingsPath);
  await fs.writeFile(store.settingsPath,'x'.repeat(PREFERENCES_MAX_BYTES+1));
  await assert.rejects(store.readSettings(),/1 MiB/);
  await fs.writeFile(store.settingsPath,'{"blur":');
  await assert.rejects(store.readSettings());
  await fs.writeFile(store.settingsPath,'{"unrecognized":true}');
  await assert.rejects(store.readSettings(), /未知/);
  await fs.writeFile(store.settingsPath,before);
  await store.resetSettings();
  assert.equal((await store.readSettings()).scrim,DEFAULTS.scrim);
  const leftovers = (await fs.readdir(store.stateRoot)).filter(name=>name.endsWith('.tmp'));
  assert.deepEqual(leftovers,[]);
}));

test('root and preset-directory junctions/symlinks cannot redirect config writes', async () => fixture(async (store, temporary) => {
  const outside = path.join(temporary,'outside'); await fs.mkdir(outside);
  const rootLink = path.join(temporary,'redirected-root');
  await fs.symlink(outside,rootLink,process.platform === 'win32'?'junction':'dir');
  const linked = new PreferencesStore({stateRoot:rootLink});
  await assert.rejects(linked.patchSettings({blur:20}), /链接|重定向/);
  await store.patchSettings({blur:10});
  await fs.symlink(outside,store.presetsPath,process.platform === 'win32'?'junction':'dir');
  await assert.rejects(store.createPreset({name:'Blocked'}), /链接|重定向/);
  assert.deepEqual(await fs.readdir(outside),[]);
}));
