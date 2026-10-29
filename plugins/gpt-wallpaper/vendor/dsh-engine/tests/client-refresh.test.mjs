import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';

const source = await fs.readFile(new URL('../source/src/client.js',import.meta.url),'utf8');
const adapter = source.split('// BEGIN CODEX CROSS-CLIENT REFRESH ADAPTER')[1].split('// END CODEX CROSS-CLIENT REFRESH ADAPTER')[0];
function fixture() {
  const calls = [];
  const state = {selection:{hostLoaded:true,id:'old',fontSetActive:'a'},persistDirty:false,persistTimer:null,
    persistInFlight:false,persistQueued:false,persistWrites:0,fontSetDirty:false,fontSetTimer:null,fontSetWrites:0,
    exports:{},document:{activeElement:null,querySelector:()=>null},
    readCachedFontSet:()=>null,serializeSelection(){return {id:state.selection.id};},pickFontValues:()=>({size:12}),
    async loadPersisted(){calls.push('settings');},async loadFontSet(){calls.push('fonts');},
    async loadInventory(){calls.push('inventory');},reapplyAll(){calls.push('reapply');},applyEffects(){calls.push('effects');},emit(){calls.push('emit');}};
  vm.runInNewContext(adapter,state);
  return {state,calls,refresh:state.exports.codexRefresh};
}
test('refresh does not fetch during pending writes or local form edits',async()=>{
  for(const key of ['persistDirty','persistTimer','persistInFlight','persistQueued','fontSetDirty','fontSetTimer']) {
    const f = fixture();f.state[key] = true;
    assert.equal((await f.refresh()).skipped,true);assert.deepEqual(f.calls,[]);
  }
  const f = fixture();f.state.selection.editing = {name:'unsaved draft'};
  assert.equal((await f.refresh()).skipped,true);assert.deepEqual(f.calls,[]);
});
test('refresh applies external selection once and preserves concurrent local writes',async()=>{
  const f = fixture();f.state.loadPersisted = async()=>{f.calls.push('settings');f.state.selection.id = 'new';};
  assert.equal((await f.refresh()).changed,true);
  assert.deepEqual(f.calls,['settings','inventory','fonts','reapply','effects','emit']);
  f.calls.length = 0;
  assert.equal((await f.refresh()).changed,false);assert.deepEqual(f.calls,['settings','fonts']);
  f.calls.length = 0;f.state.loadPersisted = async()=>{f.calls.push('settings');f.state.persistWrites++;};
  assert.equal((await f.refresh()).skipped,true);assert.deepEqual(f.calls,['settings']);
});
test('refresh is single-flight and reports fetch failures without throwing',async()=>{
  const f = fixture();let release;
  f.state.loadPersisted = ()=>new Promise(resolve=>{release = resolve;});
  const first = f.refresh();assert.equal((await f.refresh()).skipped,true);release();await first;
  f.state.loadPersisted = async()=>{throw new Error('offline');};
  assert.equal((await f.refresh()).error,'offline');
});
test('real settings loader rejects adoption when a drag starts during its GET',async()=>{
  const persistence = await fs.readFile(new URL('../source/src/persistence.js',import.meta.url),'utf8');
  const loader = persistence.match(/async function loadPersisted\(\) \{[\s\S]*?\n\}/)[0];
  let release,dragging = false;
  const context = {persistWrites:0,selection:{id:'local'},SETTINGS_URL:'/settings',
    apiJson:()=>new Promise(resolve=>{release = resolve;}),setAdapterFromHost(){},
    sanitizeSettings:s=>s,writeLocalCache(){throw new Error('Must not adopt external settings during drag');}};
  const load = vm.runInNewContext('('+loader+')',context);
  const pending = load({canAdopt:()=>!dragging});dragging = true;
  release({ok:true,data:{settings:{id:'external'}}});await pending;
  assert.equal(context.selection.id,'local');
});
test('real font loader rejects adoption when a drag starts during its GET',async()=>{
  const fonts = await fs.readFile(new URL('../source/src/fontset-store.js',import.meta.url),'utf8');
  const loader = fonts.match(/async function loadFontSet\(\) \{[\s\S]*?\n\}/)[0];
  let release,dragging = false,count = 0;
  const context = {fontSetWrites:0,selection:{size:12,fontSetActive:'old'},pickFontValues:()=>({size:12}),
    fontSetsUrl:()=>'/fonts',fontSetUrl:()=>'/fonts/active',isFontSetId:()=>true,sanitizeFontset:s=>s,
    fsJson:()=>++count === 1?new Promise(resolve=>{release = resolve;}):Promise.resolve({ok:true,data:{values:{size:22}}})};
  const load = vm.runInNewContext('('+loader+')',context);
  const pending = load({canAdopt:()=>!dragging});dragging = true;
  release({ok:true,data:{active:'external',fontsets:[]}});assert.equal(await pending,false);
  assert.equal(context.selection.size,12);assert.equal(context.selection.fontSetActive,'old');
});
