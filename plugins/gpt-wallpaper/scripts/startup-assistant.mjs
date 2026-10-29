import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {resolveSharedLocal} from './paths.mjs';
import {launchIndependent} from './detached-windows.mjs';

async function plainJson(file, limit) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new Error('invalid assistant state');
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

async function plainLocalFile(file) {
  if (!path.isAbsolute(file) || !/^[A-Za-z]:[\\/]/.test(file) || /[\0\r\n]/.test(file)) return false;
  let current = path.resolve(file);
  const leaf = await fs.lstat(current);
  if (!leaf.isFile()) return false;
  while (current) {
    if ((await fs.lstat(current)).isSymbolicLink()) return false;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return true;
}

// Initialization restores only a previously enabled, installed helper. It does
// not opt the user in, register login startup, or restart an application itself.
export async function restoreStartupAssistant({stateRoot = resolveSharedLocal(),
  platform = process.platform, launch = launchIndependent} = {}) {
  if (platform !== 'win32') return {started: false, reason: 'unsupported-platform'};
  try {
    const library = path.resolve(stateRoot, 'GPTWallpaper');
    const settings = await plainJson(path.join(library, 'startup-assistant.json'), 4096);
    if (!settings || settings.schema !== 1 || typeof settings.enabled !== 'boolean' ||
        typeof settings.paused !== 'boolean' || typeof settings.launcherPath !== 'string' ||
        Object.keys(settings).some(key => !['schema', 'enabled', 'paused', 'launcherPath'].includes(key))) {
      return {started: false, reason: 'invalid-settings'};
    }
    if (!settings.enabled) return {started: false, reason: 'disabled'};
    const installed = await plainJson(path.join(library, 'launcher-install.json'), 262144);
    if (installed.schema !== 1 || installed.product !== 'codex-wallpaper-launcher' ||
        !/^[a-f0-9]{64}$/.test(installed.contentId)) return {started: false, reason: 'invalid-installation'};
    const expectedRoot = path.join(library, 'installed', installed.contentId);
    const expectedLauncher = path.join(expectedRoot, 'manager', 'CodexDreamSkinManager.exe');
    if (typeof installed.installedPath !== 'string' ||
        path.resolve(installed.installedPath).toLowerCase() !== expectedRoot.toLowerCase() ||
        path.resolve(settings.launcherPath).toLowerCase() !== expectedLauncher.toLowerCase() ||
        !await plainLocalFile(expectedLauncher)) return {started: false, reason: 'installation-mismatch'};
    const assistant = await plainJson(path.join(library, 'startup-assistant-install.json'), 65536);
    if (assistant.schema !== 1 || assistant.product !== 'codex-wallpaper-startup-assistant' ||
        assistant.active !== true || assistant.ownedRun?.exists !== true ||
        assistant.ownedRun.kind !== 'String' || assistant.ownedRun.value !== `"${expectedLauncher}" --assistant`) {
      return {started: false, reason: 'inactive-installation'};
    }
    await launch({executable: expectedLauncher, args: ['--assistant'], cwd: expectedRoot,
      showWindow: false, environment: {LOCALAPPDATA: stateRoot, CODEX_DREAM_SKIN_LOCAL_APPDATA: stateRoot}});
    return {started: true, paused: settings.paused};
  } catch (error) {
    return {started: false, reason: error.code === 'ENOENT' ? 'not-installed' : 'unavailable'};
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || process.argv[2] !== '--restore') {
    console.error('Use --restore to start an already enabled installed assistant.');
    process.exitCode = 1;
  } else {
    const result = await restoreStartupAssistant();
    console.log(JSON.stringify(result));
    process.exitCode = result.started ? 0 : 1;
  }
}
