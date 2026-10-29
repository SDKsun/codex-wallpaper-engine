import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {validate,dispatch,root} from '../plugins/gpt-wallpaper/scripts/server.mjs';

test('reject unsafe arguments before invoking PowerShell',()=>{
  for (const a of [{action:'restart'},{action:'set_reveal',percent:NaN},{action:'set_reveal',percent:-1},{action:'set_wallpaper',path:'-Command evil'},{action:'set_wallpaper',path:'https://example.com/video.mp4'},{action:'use_theme',themeId:'ok\n-Command bad'},{action:'rotation_start',folder:'C:/Pictures',seconds:1},{action:'pause',command:'bad'}]) assert.throws(()=>validate(a));
});
test('protocol negotiation, notifications, errors',async()=>{
  assert.equal((await dispatch({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}})).result.protocolVersion,'2025-06-18');
  assert.equal(await dispatch({jsonrpc:'2.0',method:'notifications/initialized'}),null);
  assert.equal((await dispatch({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools[0].name,'wallpaper_control');
  assert.equal((await dispatch({jsonrpc:'2.0',id:3,method:'oops'})).error.code,-32601);
});
test('real stdio, isolated theme store, background rotation and stop',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'gpt-wallpaper-test-'));
  const server = path.join(root,'scripts','server.mjs');
  const child = spawn(process.execPath,[server],{windowsHide:true,env:{...process.env,LOCALAPPDATA:temp},stdio:['pipe','pipe','pipe']});
  let text='',errors='',seq=0;
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',data=>{text+=data;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n);text=text.slice(n+1);const m=JSON.parse(line);const p=pending.get(m.id);if(p){pending.delete(m.id);clearTimeout(p.timer);p.resolve(m);}}});
  child.stderr.on('data',d=>errors+=d);
  const request = (method,params)=>new Promise((resolve,reject)=>{const id=++seq;const timer=setTimeout(()=>reject(new Error('MCP timeout '+errors)),65000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});
  const tool = async args=>{const m=await request('tools/call',{name:'wallpaper_control',arguments:args});assert.equal(m.result.isError,undefined,JSON.stringify(m));return JSON.parse(m.result.content[0].text);};
  try {
    assert.equal((await request('initialize',{protocolVersion:'2025-03-26'})).result.serverInfo.name,'gpt-wallpaper');
    assert.equal((await tool({action:'status'})).activeTheme,null);
    const folder=path.join(temp,'壁纸库');await fs.mkdir(folder);
    await fs.copyFile(path.join(root,'engine','assets','dream-reference.jpg'),path.join(folder,'图片1.jpg'));
    const saved=await tool({action:'set_wallpaper',path:path.join(folder,'图片1.jpg')});
    assert.equal(saved.mediaType,'image');
    const reveal=await tool({action:'set_reveal',percent:65});assert.equal(reveal.reveal,0.65);
    await tool({action:'rotation_start',folder,seconds:30});
    await new Promise(resolve=>setTimeout(resolve,2500));
    assert.equal((await tool({action:'rotation_status'})).enabled,true);
    assert.equal((await tool({action:'status'})).mediaType,'image');
    await tool({action:'rotation_stop'});
    assert.equal((await tool({action:'rotation_status'})).enabled,false);
    await tool({action:'pause'});assert.equal((await tool({action:'status'})).paused,true);
    await tool({action:'resume'});assert.equal((await tool({action:'status'})).paused,false);
    const bad=await request('tools/call',{name:'wallpaper_control',arguments:{action:'set_reveal',percent:101}});assert.equal(bad.result.isError,true);
  } finally {
    await fs.mkdir(path.join(temp,'GPTWallpaper'),{recursive:true});
    await fs.writeFile(path.join(temp,'GPTWallpaper','rotation.json'),'{"enabled":false}');
    child.stdin.end();
    await new Promise(resolve=>{if(child.exitCode!==null)return resolve();child.once('exit',resolve);});
    await new Promise(resolve=>setTimeout(resolve,1500));
    for(const p of pending.values())clearTimeout(p.timer);
    await fs.rm(temp,{recursive:true,force:true});
  }
});
