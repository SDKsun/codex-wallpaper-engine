import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {buildNativeSceneRuntime} from '../plugins/gpt-wallpaper/scripts/native-scene.mjs';

const token='a'.repeat(64),base=`app://codex/dsh/${token}/wallpaper-engine`;
const scene=(id='payload')=>base+'/scene-live/index.html?type=scene&src='+id+'&mediaBase='+encodeURIComponent(base+'/scene-files');
class Observer{constructor(fn){this.fn=fn;this.disconnected=false;}observe(){}disconnect(){this.disconnected=true;}}
class Sheet{replaceSync(text){this.text=text;}}
class Events{constructor(){this.listeners=new Map();}addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}emit(type){for(const fn of this.listeners.get(type)||[])fn({type});}}
class Document extends Events{constructor(){super();this.adoptedStyleSheets=[];this.nodes=[];this.body={appendChild:node=>this.nodes.push(node)};}createElement(){const d=this;return{id:'',remove(){d.nodes=d.nodes.filter(n=>n!==this);}};}getElementById(id){return this.nodes.find(n=>n.id===id);}}
class Frame extends Events{constructor(){super();this.actual='';this.isConnected=true;this.contentDocument=new Document();const events=new Events();this.contentWindow=Object.assign(events,{record:{destroyed:0},location:{href:'about:blank'},CSSStyleSheet:Sheet,MutationObserver:Observer,ResizeObserver:Observer,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame:fn=>setTimeout(()=>fn(0),100),cancelAnimationFrame:clearTimeout});}get src(){return this.actual;}set src(value){this.actual=String(value);}}
const engine='globalThis.WebWallGL={createScene(){return{destroy(){globalThis.record.destroyed++;}};}};globalThis.__particleStats=()=>({systems:[]});globalThis.__particleStats=()=>({systems:[1]});globalThis.__sceneDebug={active:true};globalThis[Symbol.for("native-scene-diagnostic")]=7;';
const renderer=`const inst=globalThis.WebWallGL.createScene(document.getElementById('wp'));
window.__wp={pause(){window.paused=true;}};window.__wpStats={frame:()=>({fps:30,running:true})};
window.setTimeout(()=>{window.leaked=true;},1000);window.setInterval(()=>{},1000);requestAnimationFrame(()=>{});
new MutationObserver(()=>{}).observe(document,{});window.addEventListener('test',()=>{});document.addEventListener('test',()=>{});
fetch(new URL('../scene-files/payload/scene.pkg',location.href).href).catch(()=>{});`;

test('trusted scene iframe bridge retains actual child control, validates routing, and cleans lifecycle',async()=>{
  const source=buildNativeSceneRuntime({engineSource:engine,rendererSource:renderer});
  assert.ok(!source.includes('new Function'));assert.ok(!source.includes('eval('));assert.ok(!source.includes('createElement("script")'));
  const create=vm.runInNewContext(source,{URL,DOMException,AbortController});
  const parent={location:{href:'app://codex/index.html'},MutationObserver:Observer};const doc=new Document();
  assert.throws(()=>create({window:parent,document:doc,apiBase:base.replace('app://codex','app://other'),fetch:()=>{}}),/Invalid native scene API base/);
  const dash=create({window:{...parent,location:{href:'app://-/index.html'}},document:doc,apiBase:base.replace('app://codex','app://-'),fetch:()=>{}});dash.dispose();
  const calls=[],diagnostics=[];let aborted=0;
  const bridge=create({window:parent,document:doc,apiBase:base,onDiagnostic:entry=>diagnostics.push(entry),fetch:(url,init)=>{
    calls.push(url);return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>{aborted++;reject(new DOMException('Aborted','AbortError'));},{once:true}));
  }});
  assert.equal(bridge.owns(scene()),true);assert.equal(bridge.owns(scene().replace('type=scene','type=web')),false);
  assert.equal(bridge.owns(scene().replace('app://codex','app://other')),false);
  assert.equal(bridge.owns('https://untrusted.example/scene'),false);
  const frame=bridge.wrap(new Frame());const previousStats=()=>({original:true});Object.defineProperty(frame.contentWindow,'__particleStats',{value:previousStats,writable:true,configurable:true,enumerable:false});
  frame.src=scene();assert.equal(frame.actual,'about:blank');assert.equal(frame.src,scene());
  frame.emit('load');assert.equal(bridge.snapshot().ready,1);assert.equal(frame.contentWindow.__wpStats.frame().fps,30);
  frame.contentWindow.__wp.pause();assert.equal(frame.contentWindow.paused,true);
  assert.equal(frame.contentWindow.__particleStats().systems.length,1);assert.equal(frame.contentWindow.__particleStats().systems[0],1);assert.equal(frame.contentWindow.__sceneDebug.active,true);
  assert.deepEqual(calls,[base+'/scene-files/payload/scene.pkg']);assert.equal(frame.contentDocument.adoptedStyleSheets.length,1);
  frame.emit('load');assert.equal(calls.length,1,'duplicate load does not mount twice');
  frame.src=scene('next');assert.equal(frame.contentWindow.record.destroyed,1);assert.equal(aborted,1);
  assert.equal(frame.contentWindow.__particleStats,previousStats);assert.equal(Object.getOwnPropertyDescriptor(frame.contentWindow,'__particleStats').enumerable,false);
  assert.equal(frame.contentWindow.__sceneDebug,undefined);assert.equal(frame.contentWindow.paused,undefined);assert.equal(Object.hasOwn(frame.contentWindow,Symbol.for('native-scene-diagnostic')),false);
  assert.equal(frame.contentWindow.__wp,undefined);assert.equal(frame.contentDocument.nodes.length,0);
  frame.emit('load');assert.equal(bridge.snapshot().ready,1);
  bridge.dispose();assert.equal(frame.contentWindow.record.destroyed,2);assert.equal(aborted,2);
  assert.equal(frame.contentWindow.__particleStats,previousStats);
  assert.equal(frame.contentWindow.__wp,undefined);assert.equal(frame.contentWindow.WebWallGL,undefined);
  assert.equal(frame.contentDocument.nodes.length,0);assert.equal(frame.contentDocument.adoptedStyleSheets.length,0);
  assert.equal(Object.hasOwn(frame,'src'),false);assert.equal(frame.listeners.get('load').size,0);
  assert.equal(frame.contentWindow.listeners.get('test').size,0);assert.equal(frame.contentDocument.listeners.get('test').size,0);
  assert.equal(bridge.snapshot().frames,0);assert.equal(diagnostics.filter(d=>d.phase==='mounted').length,2);
  bridge.dispose();assert.equal(frame.contentWindow.record.destroyed,2,'cleanup is idempotent');
  await new Promise(resolve=>setTimeout(resolve,5));
});

test('actual pinned static engine and renderer compose without runtime source compilation',async()=>{
  const root=new URL('../plugins/gpt-wallpaper/vendor/dsh-engine/source/',import.meta.url);
  const source=buildNativeSceneRuntime({engineSource:await fs.readFile(new URL('runtime-deps/webwallgl/webwallgl.global.min.js',root),'utf8'),rendererSource:await fs.readFile(new URL('lib/webwallgl/renderer.js',root),'utf8'),occlusionSource:await fs.readFile(new URL('lib/webwallgl/occlusion-bridge.js',root),'utf8')});
  assert.ok(!source.includes('import.meta'));assert.ok(!source.includes('Page.setBypassCSP'));
  assert.equal(typeof new vm.Script(source).runInNewContext({URL,DOMException,AbortController}),'function');
});
