import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {resolveSharedLocal} from '../plugins/gpt-wallpaper/scripts/paths.mjs';

test('packaged and brokered processes share profile-root state while isolated overrides remain isolated',()=>{
  const profile=path.resolve('C:/Users/Example');
  const expected=path.join(profile,'.codex','wallpaper-local');
  assert.equal(resolveSharedLocal({USERPROFILE:profile,LOCALAPPDATA:path.join(profile,'AppData','Local')}),expected);
  const isolated=path.join(profile,'AppData','Local','Temp','isolated');
  assert.equal(resolveSharedLocal({USERPROFILE:profile,LOCALAPPDATA:isolated}),isolated);
  assert.equal(resolveSharedLocal({USERPROFILE:profile,LOCALAPPDATA:'C:/other',CODEX_DREAM_SKIN_LOCAL_APPDATA:expected}),expected);
  assert.throws(()=>resolveSharedLocal({USERPROFILE:profile,LOCALAPPDATA:'relative'}));
});
