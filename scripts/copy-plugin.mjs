import fs from 'node:fs/promises';
import path from 'node:path';
const [source,destination]=process.argv.slice(2).map(value=>path.resolve(value));
if(!source||!destination||destination.startsWith(source+path.sep))throw Error('Expected separate source and output plugin directories');
await fs.cp(source,destination,{recursive:true,filter:item=>{
  const relative=path.relative(source,item).replaceAll('\\','/');
  return !relative.split('/').some(part=>['node_modules','.git','tests'].includes(part))&&!/\.(?:log|tmp|zip|tar|tgz)$/.test(relative);
}});
if(!await fs.stat(path.join(destination,'manager/CodexDreamSkinManager.exe')).catch(()=>null))throw Error('Built manager is missing');
