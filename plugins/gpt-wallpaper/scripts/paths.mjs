import os from 'node:os';
import path from 'node:path';

// Packaged Codex virtualizes normal LocalAppData, while a brokered process does
// not. A profile-root directory gives both processes the same physical files.
// Explicit isolated/custom LocalAppData remains usable by tests and callers.
export function resolveSharedLocal(environment=process.env) {
  const profile=environment.USERPROFILE || os.homedir();
  const override=environment.CODEX_DREAM_SKIN_LOCAL_APPDATA;
  const local=override || environment.LOCALAPPDATA;
  if(typeof local !== 'string' || !path.isAbsolute(local) || /[\0\r\n]/.test(local))throw new Error('无效本地状态目录');
  const resolved=path.resolve(local);
  if(override)return resolved;
  const normal=path.resolve(profile,'AppData','Local');
  return resolved.toLowerCase() === normal.toLowerCase() ? path.resolve(profile,'.codex','wallpaper-local') : resolved;
}
