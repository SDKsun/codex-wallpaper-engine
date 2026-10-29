import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';

test('portable MCP manifest resolves documented plugin root and initializes from another cwd',async()=>{
  const root = fileURLToPath(new URL('../plugins/gpt-wallpaper/',import.meta.url));
  const manifest = JSON.parse(await fs.readFile(path.join(root,'mcp.json'),'utf8')).mcpServers.wallpaper;
  assert.equal(manifest.args[0],'${PLUGIN_ROOT}/scripts/server.mjs');
  assert.equal(manifest.cwd,'${PLUGIN_ROOT}');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(),'wallpaper-manifest-'));
  const child = spawn(process.execPath,manifest.args.map(a=>a.replaceAll('${PLUGIN_ROOT}',root)),{cwd:temporary,windowsHide:true,env:{...process.env,LOCALAPPDATA:temporary},stdio:['pipe','pipe','pipe']});
  let output = '',errors = '';
  child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>errors+=chunk);
  const timer = setTimeout(()=>child.kill(),5000);
  try {
    child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:99,method:'initialize',params:{protocolVersion:'2025-06-18'}})+'\n');
    const exit = await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(exit,0,errors);
    const response = JSON.parse(output.trim());assert.equal(response.id,99);assert.equal(response.result.serverInfo.name,'gpt-wallpaper');
  } finally {clearTimeout(timer);await fs.rm(temporary,{recursive:true,force:true});}
});
