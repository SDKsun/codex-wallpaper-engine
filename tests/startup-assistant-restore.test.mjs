import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {restoreStartupAssistant} from '../plugins/gpt-wallpaper/scripts/startup-assistant.mjs';

test('plugin initialization never enables or runs an uninstalled assistant', async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-restore-'));
  try {
    let calls = 0;
    const launch = async () => { calls++; };
    assert.equal((await restoreStartupAssistant({stateRoot, platform: 'linux', launch})).reason, 'unsupported-platform');
    assert.equal((await restoreStartupAssistant({stateRoot, platform: 'win32', launch})).reason, 'not-installed');
    const directory = path.join(stateRoot, 'GPTWallpaper');
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, 'startup-assistant.json'), JSON.stringify({schema:1,enabled:false,paused:false,launcherPath:'unused'}));
    assert.equal((await restoreStartupAssistant({stateRoot, platform:'win32', launch})).reason, 'disabled');
    assert.equal(calls, 0);
    assert.deepEqual(await fs.readdir(directory), ['startup-assistant.json']);
  } finally { await fs.rm(stateRoot, {recursive:true, force:true}); }
});

test('enabled restore uses only the exact installed launcher and never passes restart flags', {skip: process.platform !== 'win32'}, async () => {
  const stateRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'assistant-restore-'));
  try {
    const directory = path.join(stateRoot, 'GPTWallpaper');
    const contentId = 'a'.repeat(64), installedPath = path.join(directory, 'installed', contentId);
    const launcherPath = path.join(installedPath, 'manager', 'CodexDreamSkinManager.exe');
    await fs.mkdir(path.dirname(launcherPath), {recursive:true});
    await fs.writeFile(launcherPath, 'fixture only; never executed');
    const settings = {schema:1,enabled:true,paused:true,launcherPath};
    const installed = {schema:1,product:'codex-wallpaper-launcher',contentId,installedPath};
    const settingsFile = path.join(directory, 'startup-assistant.json');
    const manifestFile = path.join(directory, 'launcher-install.json');
    const assistantFile = path.join(directory, 'startup-assistant-install.json');
    const assistant = {schema:1,product:'codex-wallpaper-startup-assistant',active:true,
      ownedRun:{exists:true,kind:'String',value:`"${launcherPath}" --assistant`}};
    await fs.writeFile(settingsFile, JSON.stringify(settings));
    await fs.writeFile(manifestFile, JSON.stringify(installed));
    await fs.writeFile(assistantFile, JSON.stringify(assistant));
    const calls = [], launch = async value => calls.push(value);
    assert.deepEqual(await restoreStartupAssistant({stateRoot, launch}), {started:true,paused:true});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].executable, launcherPath);
    assert.deepEqual(calls[0].args, ['--assistant']);
    assert.equal(calls[0].showWindow, false);
    assert.equal(calls[0].environment.CODEX_DREAM_SKIN_LOCAL_APPDATA, stateRoot);
    await fs.writeFile(settingsFile, JSON.stringify({...settings,launcherPath:path.join(stateRoot,'foreign.exe')}));
    assert.equal((await restoreStartupAssistant({stateRoot, launch})).reason, 'installation-mismatch');
    await fs.writeFile(settingsFile, JSON.stringify({...settings,extra:'unexpected'}));
    assert.equal((await restoreStartupAssistant({stateRoot, launch})).reason, 'invalid-settings');
    await fs.writeFile(settingsFile, JSON.stringify(settings));
    await fs.writeFile(manifestFile, JSON.stringify({...installed,contentId:'../escape'}));
    assert.equal((await restoreStartupAssistant({stateRoot, launch})).reason, 'invalid-installation');
    await fs.writeFile(manifestFile, JSON.stringify(installed));
    await fs.writeFile(assistantFile, JSON.stringify({...assistant,active:false}));
    assert.equal((await restoreStartupAssistant({stateRoot, launch})).reason, 'inactive-installation');
    await fs.rm(assistantFile);
    assert.equal((await restoreStartupAssistant({stateRoot, launch})).reason, 'not-installed');
    assert.equal(calls.length, 1);
  } finally { await fs.rm(stateRoot, {recursive:true, force:true}); }
});
