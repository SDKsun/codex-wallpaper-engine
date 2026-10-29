// Hosted Windows runners may expose TEMP using an 8.3 alias or junction.
// Fixtures start at its physical path; production redirect checks stay strict.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temporary=await fs.realpath(os.tmpdir());
const environment={...process.env,...(process.platform==='win32'?{TEMP:temporary,TMP:temporary}:{TMPDIR:temporary})};
const child=spawn(process.execPath,['--test','tests/*.test.mjs','plugins/gpt-wallpaper/vendor/dsh-engine/tests/*.test.mjs'],{cwd:root,env:environment,stdio:'inherit',windowsHide:true});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
process.exitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>resolve(code??1));});
