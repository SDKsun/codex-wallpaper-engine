import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {engineHealth} from '../plugins/gpt-wallpaper/scripts/health.mjs';

test('saved wallpaper never implies live engine and wrong browser identity cannot report connection',async()=>{
  const temp=await fs.mkdtemp(path.join(os.tmpdir(),'wallpaper-health-'));
  try {
    assert.equal((await engineHealth({stateRoot:temp})).state,'not_started');
    await fs.writeFile(path.join(temp,'startup-error.log'),'specific failure');
    const failed=await engineHealth({stateRoot:temp});assert.equal(failed.state,'startup_failed');assert.equal(failed.lastError,'specific failure');
    await fs.writeFile(path.join(temp,'state.json'),JSON.stringify({port:9335,injectorPid:123,browserId:'expected'}));
    assert.equal((await engineHealth({stateRoot:temp,processAlive:()=>false})).connected,false);
    const response=webSocketDebuggerUrl=>({ok:true,text:async()=>JSON.stringify({webSocketDebuggerUrl})});
    assert.equal((await engineHealth({stateRoot:temp,processAlive:()=>true,fetchImpl:async()=>response('ws://127.0.0.1:9335/devtools/browser/wrong')})).connected,false);
    const connected=await engineHealth({stateRoot:temp,processAlive:()=>true,fetchImpl:async()=>response('ws://127.0.0.1:9335/devtools/browser/expected')});
    assert.equal(connected.connected,true);assert.equal(connected.renderingVerified,false);
  } finally {await fs.rm(temp,{recursive:true,force:true});}
});
