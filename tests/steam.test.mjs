import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {readProject,safeProjectFile,scanSteam} from '../plugins/gpt-wallpaper/scripts/steam.mjs';

test('Steam scene discovery keeps projects bounded and ignores executable/web projects',async()=>{
  const temp = await fs.mkdtemp(path.join(os.tmpdir(),'steam-scenes-'));
  const dir = path.join(temp,'steamapps','workshop','content','431960','123');
  await fs.mkdir(dir,{recursive:true});
  try {
    await fs.writeFile(path.join(dir,'project.json'),JSON.stringify({title:'测试场景',type:'scene',file:'scene.json',preview:'preview.jpg'}));
    await fs.writeFile(path.join(dir,'scene.pkg'),'test');
    await fs.writeFile(path.join(dir,'preview.jpg'),'test');
    const project = await readProject(dir);
    assert.equal(project.type,'scene');assert.equal(project.name,'测试场景');assert.match(project.id,/^[a-f0-9]{24}$/);
    assert.equal((await scanSteam([temp])).size,1);
    await assert.rejects(safeProjectFile(project.root,'../../secret'));
    await assert.rejects(safeProjectFile(project.root,'C:\\secret'));
    await assert.rejects(safeProjectFile(project.root,'file.tex:secret'));
    await fs.writeFile(path.join(dir,'project.json'),JSON.stringify({type:'application',file:'bad.exe'}));
    assert.equal(await readProject(dir),null);
    await fs.writeFile(path.join(dir,'project.json'),JSON.stringify({type:'web',file:'index.html'}));
    assert.equal((await scanSteam([temp])).size,0);
  } finally {await fs.rm(temp,{recursive:true,force:true});}
});
