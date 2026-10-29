import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs/promises';
import {
  buildNativeClient, buildNativeClientFactory, NATIVE_DSH_STATE_KEY,
  buildCodexTypographyCss, buildCodexGlassCss, normalizeShortcutBinding,createNativeDshFetch,readNativeResource,
} from '../plugins/gpt-wallpaper/scripts/native-client.mjs';

const token = 'a'.repeat(64);
const apiBase = `http://127.0.0.1:18765/dsh/${token}/wallpaper-engine`;
const reactSource = `module.exports={createElement:(type,props,...children)=>({type,props,children})};`;
const reactDOMSource = `const React=require('react');module.exports={createRoot(node){return{render(value){node.rendered=value;},unmount(){node.unmounted=true;}}}};`;
const client = `window.__ModuleLoader__.load({id:'dsh-plugin-wallpaper-engine',factory:(require)=>{
  const React=require('react');globalThis.__privateDSHMarker='private';window.React='private';
  return{apply(ctx){
    ctx.slots.inject('settings.section',()=>ctx.slots.register({name:'settings.section',id:'wallpaper-engine'},()=>React.createElement('original-six-tabs')));
    ctx.effect(()=>{
      const layer=document.createElement('div');layer.id='dsh-wallpaper-engine-layer';const image=document.createElement('img');image.className='we-media';image.complete=true;image.naturalWidth=1920;layer.append(image);document.body.append(layer);document.body.setAttribute('data-we-wallpaper','1');
      const off=ctx.get('theme').overrideTokens('test',{'--dsw-alias-label-primary':{light:'#111111',dark:'#eeeeee'}});
      const handler=()=>{};window.addEventListener('fixture-event',handler);setInterval(()=>{},1000);setTimeout(()=>{},1000);
      return()=>{layer.remove();document.body.removeAttribute('data-we-wallpaper');off();window.removeEventListener('fixture-event',handler);};
    });
  },selection:{id:'fixture'}};
}});`;
const child = `window.__ModuleLoader__.load({id:'dsh-plugin-wallpaper-engine-fx',factory:(require)=>{const host=require('dsh-plugin-wallpaper-engine');if(!host.selection)throw new Error('Host bridge missing');return{apply(ctx){ctx.effect(()=>()=>{});}};}});`;
const options = {apiBase,reactSource,reactDOMSource,clientBundles:[client,child]};

class Style {
  values = new Map(); priorities = new Map();
  setProperty(key,value,priority=''){this.values.set(key,String(value));this.priorities.set(key,priority);}
  getPropertyValue(key){return this.values.get(key)||'';}
  getPropertyPriority(key){return this.priorities.get(key)||'';}
  removeProperty(key){const old=this.getPropertyValue(key);this.values.delete(key);this.priorities.delete(key);return old;}
}
class Element {
  constructor(tag){this.tagName=tag.toUpperCase();this.children=[];this.attrs=new Map();this.style=new Style();this.listeners=new Map();this.parentNode=null;this.className='';this.dataset={};}
  get id(){return this.attrs.get('id')||'';} set id(v){this.attrs.set('id',v);}
  get isConnected(){let n=this;while(n){if(n.documentRoot)return true;n=n.parentNode;}return false;}
  get sheet(){return this.tagName==='STYLE'&&this.inlineAllowed!==false&&this.isConnected&&this.textContent?{cssRules:[{cssText:this.textContent}]}:null;}
  get classList(){return{contains:name=>this.className.split(/\s+/).includes(name)}}
  contains(node){for(let value=node;value;value=value.parentNode)if(value===this)return true;return false;}
  getAttribute(name){return name==='class'?(this.className||null):(this.attrs.get(name)??null);}
  setAttribute(name,value){if(name==='class')this.className=String(value);else this.attrs.set(name,String(value));}
  removeAttribute(name){if(name==='class')this.className='';else this.attrs.delete(name);}
  hasAttribute(name){return this.getAttribute(name)!==null;}
  append(...nodes){for(const node of nodes){if(node.parentNode)node.parentNode.children=node.parentNode.children.filter(item=>item!==node);node.parentNode=this;this.children.push(node);}}
  appendChild(node){this.append(node);return node;}
  remove(){if(this.parentNode){this.parentNode.children=this.parentNode.children.filter(n=>n!==this);this.parentNode=null;}}
  addEventListener(type,fn){if(!this.listeners.has(type))this.listeners.set(type,new Set());this.listeners.get(type).add(fn);}
  removeEventListener(type,fn){this.listeners.get(type)?.delete(fn);}
  dispatch(type){for(const fn of this.listeners.get(type)||[])fn({type,target:this});}
  querySelector(selector){const [tag,className]=selector.split('.');for(const child of this.children){if(child.tagName===tag.toUpperCase()&&(!className||child.className.split(/\s+/).includes(className)))return child;const found=child.querySelector(selector);if(found)return found;}return null;}
  showModal(){this.open=true;} close(){this.open=false;}
}
function browser({inlineStyles=true,constructableStyles=false,idleCallbacks=false}={}) {
  const html=new Element('html');html.documentRoot=true;html.className='dark';
  const head=new Element('head'),body=new Element('body'),main=new Element('main'),sidebar=new Element('aside');html.append(head,body);body.append(main,sidebar);
  const walk=(node,id)=>{if(node.id===id)return node;for(const child of node.children){const found=walk(child,id);if(found)return found;}return null;};
  // Explicit fixtures for public native selectors; this is not a browser CSS matcher.
  const queryNodes=new Map();
  const document={documentElement:html,head,body,hidden:false,createElement:tag=>{const node=new Element(tag);node.inlineAllowed=inlineStyles;return node;},getElementById:id=>walk(html,id),querySelector:selector=>{const value=queryNodes.get(selector);return Array.isArray(value)?value[0]||null:value||null;},querySelectorAll:selector=>selector==='main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])'?[main]:selector==='aside.app-shell-left-panel'?[sidebar]:queryNodes.has(selector)?Array.isArray(queryNodes.get(selector))?queryNodes.get(selector):[queryNodes.get(selector)]:[],listeners:new Map(),addEventListener:Element.prototype.addEventListener,removeEventListener:Element.prototype.removeEventListener};
  const timeouts=new Map(),intervals=new Map(),rafs=new Map(),idles=new Map();let next=1;
  const storage=new Map();const nativeReact={native:true},nativeLoader={native:true};
  const root={URL,Headers,Response,Request,Blob,DOMException,AbortController,atob,btoa,Event,document,React:nativeReact,__ModuleLoader__:nativeLoader,location:{href:'app://codex/index.html',origin:'null',protocol:'app:',host:'codex'},listeners:new Map(),addEventListener:Element.prototype.addEventListener,removeEventListener:Element.prototype.removeEventListener,setTimeout:(fn)=>{const id=next++;timeouts.set(id,fn);return id;},clearTimeout:id=>timeouts.delete(id),setInterval:(fn,ms)=>{const id=next++;intervals.set(id,{fn,ms});return id;},clearInterval:id=>intervals.delete(id),requestAnimationFrame:fn=>{const id=next++;rafs.set(id,fn);return id;},cancelAnimationFrame:id=>rafs.delete(id),MutationObserver:class{observe(){}disconnect(){this.disconnected=true;}},localStorage:{getItem:k=>storage.get(k)??null,setItem:(k,v)=>storage.set(k,v),removeItem:k=>storage.delete(k)},console};
  if(constructableStyles){document.adoptedStyleSheets=[];root.CSSStyleSheet=class{cssRules=[];replaceSync(text){this.cssRules=text.trim()?[{cssText:text}]:[];}};}
  if(idleCallbacks){root.requestIdleCallback=function(fn){if(this?.document!==document)throw new TypeError('Illegal invocation');const id=next++;idles.set(id,fn);return id;};root.cancelIdleCallback=function(id){if(this?.document!==document)throw new TypeError('Illegal invocation');idles.delete(id);};}
  html.style.setProperty('--dsw-alias-label-primary','#777777');
  return {context:vm.createContext(root),root,document,main,sidebar,queryNodes,timeouts,intervals,rafs,idles,nativeReact,nativeLoader};
}

test('bootstrap preserves native React/loader, renders original registered settings, and cleans reapply', () => {
  const b=browser();
  const expression=buildNativeClient({...options,nativeApiBase:`app://codex/dsh/${token}/wallpaper-engine`});
  const result=new vm.Script(expression).runInContext(b.context);
  assert.equal(result.ready,true);assert.equal(result.settingsRegistered,true);assert.equal(result.surfaceCount,2);assert.equal(result.transport,'image');
  assert.equal(b.root.React,b.nativeReact);assert.equal(b.root.__ModuleLoader__,b.nativeLoader);assert.equal(b.root.__privateDSHMarker,undefined);
  const state=b.root[NATIVE_DSH_STATE_KEY];assert.equal(state.nativeApiBase,`app://codex/dsh/${token}/wallpaper-engine`);
  assert.equal(b.document.getElementById('codex-we-native-panel').rendered.type,'original-six-tabs');
  state.openSettings();assert.equal(b.document.getElementById('codex-we-native-settings').open,true);
  state.closeSettings();assert.equal(b.document.getElementById('codex-we-native-settings').open,false);
  assert.equal(b.document.documentElement.style.getPropertyValue('--dsw-alias-label-primary'),'#eeeeee');
  const firstTrigger=b.document.getElementById('codex-we-native-trigger');
  new vm.Script(expression).runInContext(b.context);
  assert.equal(state.phase,'disposed');assert.equal(firstTrigger.isConnected,false);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();
  assert.equal(b.root[NATIVE_DSH_STATE_KEY],undefined);
  for(const id of ['codex-we-native-trigger','codex-we-native-settings','codex-we-native-style','dsh-wallpaper-engine-layer'])assert.equal(b.document.getElementById(id),null);
  assert.equal(b.main.getAttribute('data-codex-we-surface'),null);assert.equal(b.sidebar.getAttribute('data-codex-we-surface'),null);
  assert.equal(b.document.documentElement.style.getPropertyValue('--dsw-alias-label-primary'),'#777777');
  assert.equal(b.timeouts.size,0);assert.equal(b.intervals.size,0);assert.equal(b.rafs.size,0);
  assert.equal(b.root.listeners.get('fixture-event').size,0);
});

test('factory accepts only verified app origins and reports mount without pretending unloaded wallpaper is ready', () => {
  const empty=client.replace("image.complete=true;image.naturalWidth=1920;","image.complete=false;image.naturalWidth=0;");
  const factory=new vm.Script('('+buildNativeClientFactory({...options,clientBundles:[empty]})+')').runInContext(browser().context);
  const summary=factory('app://codex');assert.equal(summary.ready,false);assert.equal(summary.wallpaperPresent,true);
  assert.equal(factory('app://-').settingsRegistered,true);
  for(const origin of ['http://127.0.0.1:9000','app://user@codex','app://codex:9000','app://codex/path','app://codex?x','app://codex#x','app://../codex','null']) assert.throws(()=>factory(origin),/Invalid verified/);
});

test('builder rejects arbitrary endpoints/scripts and JSON-escapes native shell configuration', () => {
  for(const api of ['https://127.0.0.1:18765/dsh/'+token+'/wallpaper-engine',apiBase+'?x',apiBase+'#x',apiBase.replace('127.0.0.1','localhost'),apiBase.replace(':18765',':80'),apiBase.replace(token,'short')]) assert.throws(()=>buildNativeClient({...options,apiBase:api}));
  assert.throws(()=>buildNativeClient({...options,nativeApiBase:`app://codex/dsh/${'b'.repeat(64)}/wallpaper-engine`}));
  assert.throws(()=>buildNativeClient({...options,clientBundles:[{url:'https://example.com/script.js'}]}));
  assert.throws(()=>buildNativeClient({...options,reactSource:'x'.repeat(10*1024*1024)}),/10 MiB/);
  const b=browser();const title='\");globalThis.injected=true;//';
  new vm.Script(buildNativeClient({...options,title})).runInContext(b.context);
  assert.equal(b.root.injected,undefined);assert.equal(b.document.getElementById('codex-we-native-settings').getAttribute('aria-label'),title);
});

test('tracked refresh polls the real export without overlap or reinjection and stops after cleanup', async () => {
  const b=browser();let release;
  b.document.refreshWait=new Promise(resolve=>{release=resolve;});
  const refreshing=client.replace("},selection:{id:'fixture'}};", "},codexRefresh(){const body=document.body;body.setAttribute('data-refresh-count',String(Number(body.getAttribute('data-refresh-count')||0)+1));return document.refreshWait;},selection:{id:'fixture'}};");
  new vm.Script(buildNativeClient({...options,clientBundles:[refreshing]})).runInContext(b.context);
  const state=b.root[NATIVE_DSH_STATE_KEY];const trigger=b.document.getElementById('codex-we-native-trigger');
  const poll=[...b.intervals.values()].find(timer=>timer.ms===2000);assert.ok(poll);
  poll.fn();poll.fn();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.document.body.getAttribute('data-refresh-count'),'1');
  release();await new Promise(resolve=>setImmediate(resolve));
  poll.fn();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.document.body.getAttribute('data-refresh-count'),'2');
  assert.equal(b.document.getElementById('codex-we-native-trigger'),trigger);
  assert.equal(state.summary().refreshError,null);
  state.cleanup();assert.equal(b.intervals.size,0);poll.fn();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.document.body.getAttribute('data-refresh-count'),'2');
});

test('refresh gracefully tolerates a legacy bundle without codexRefresh', async () => {
  const b=browser();new vm.Script(buildNativeClient(options)).runInContext(b.context);
  const poll=[...b.intervals.values()].find(timer=>timer.ms===2000);
  assert.doesNotThrow(()=>poll.fn());await new Promise(resolve=>setImmediate(resolve));
  assert.equal(b.root[NATIVE_DSH_STATE_KEY].summary().refreshError,null);
  assert.equal(b.root[NATIVE_DSH_STATE_KEY].ready,true);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();
});

test('native chunk-upload capability is visible only inside the private DSH realm', () => {
  const b=browser();
  const flagged=client.replace("globalThis.__privateDSHMarker='private';", "globalThis.__privateDSHMarker='private';if(globalThis.__CODEX_WE_CHUNK_UPLOAD__!==true||window.__CODEX_WE_CHUNK_UPLOAD__!==true)throw new Error('Chunk flag missing');document.body.setAttribute('data-fixture-chunk-upload','true');");
  new vm.Script(buildNativeClient({...options,clientBundles:[flagged]})).runInContext(b.context);
  assert.equal(b.document.body.getAttribute('data-fixture-chunk-upload'),'true');
  assert.equal(b.root.__CODEX_WE_CHUNK_UPLOAD__,undefined);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();
  assert.equal(b.root.__CODEX_WE_CHUNK_UPLOAD__,undefined);
});

test('scoped constructed styles apply under blocked inline CSS and preserve foreign adopted sheets', () => {
  const b=browser({inlineStyles:false,constructableStyles:true});
  const before=new b.root.CSSStyleSheet();before.replaceSync('.native{color:green}');b.document.adoptedStyleSheets=[before];
  const foreignStyle=b.document.createElement('style');foreignStyle.id='native-foreign-style';foreignStyle.textContent='.native{display:block}';b.document.head.append(foreignStyle);
  const styled=client.replace("const layer=document.createElement('div');", "const pluginStyle=document.createElement('style');pluginStyle.id='fixture-plugin-style';document.head.appendChild(pluginStyle);pluginStyle.textContent='.fixture{color:red}';const layer=document.createElement('div');");
  const result=new vm.Script(buildNativeClient({...options,clientBundles:[styled]})).runInContext(b.context);
  const state=b.root[NATIVE_DSH_STATE_KEY],shell=b.document.getElementById('codex-we-native-style'),pluginStyle=b.document.getElementById('fixture-plugin-style');
  assert.equal(shell.sheet,null);assert.equal(pluginStyle.sheet,null);
  assert.equal(state.stylesheetApplied(),true);assert.equal(result.stylesheetApplied,true);assert.equal(result.ready,true);
  assert.equal(b.document.adoptedStyleSheets.length,4);assert.equal(b.document.adoptedStyleSheets[0],before);
  pluginStyle.textContent='.fixture{color:blue}';
  assert.ok(b.document.adoptedStyleSheets.some(sheet=>sheet.cssRules[0]?.cssText==='.fixture{color:blue}'));
  const later=new b.root.CSSStyleSheet();later.replaceSync('.later{color:purple}');b.document.adoptedStyleSheets=[...b.document.adoptedStyleSheets,later];
  pluginStyle.remove();assert.equal(b.document.adoptedStyleSheets.length,4);
  state.cleanup();assert.equal(b.document.adoptedStyleSheets.length,2);assert.equal(b.document.adoptedStyleSheets[0],before);assert.equal(b.document.adoptedStyleSheets[1],later);
  assert.equal(b.document.getElementById('native-foreign-style'),foreignStyle);assert.equal(foreignStyle.isConnected,true);
});

test('stylesheet evidence rejects blocked fallback, foreign sheets, empty rules and lost adoption', () => {
  const blocked=browser({inlineStyles:false});
  const result=new vm.Script(buildNativeClient(options)).runInContext(blocked.context);
  assert.equal(result.ready,false);assert.equal(result.stylesheetApplied,false);assert.equal(blocked.root[NATIVE_DSH_STATE_KEY].stylesheetApplied(),false);
  blocked.root[NATIVE_DSH_STATE_KEY].cleanup();
  const b=browser({inlineStyles:false,constructableStyles:true});
  new vm.Script(buildNativeClient(options)).runInContext(b.context);
  const state=b.root[NATIVE_DSH_STATE_KEY],owned=b.document.adoptedStyleSheets.find(sheet=>sheet.cssRules[0]?.cssText.includes('#codex-we-native-trigger'));
  assert.equal(state.stylesheetApplied(),true);
  owned.replaceSync('');assert.equal(state.stylesheetApplied(),false);
  owned.replaceSync('.owned{color:red}');assert.equal(state.stylesheetApplied(),true);
  const foreign=new b.root.CSSStyleSheet();foreign.replaceSync('.foreign{color:red}');b.document.adoptedStyleSheets=[foreign];
  assert.equal(state.stylesheetApplied(),false);
  b.document.getElementById('codex-we-native-style').remove();assert.equal(state.stylesheetApplied(),false);
  state.cleanup();assert.equal(b.document.adoptedStyleSheets.length,1);assert.equal(b.document.adoptedStyleSheets[0],foreign);
});

test('WebIDL idle callbacks keep their native receiver and are tracked through cleanup', () => {
  const b=browser({idleCallbacks:true});
  const idleClient=client.replace("ctx.effect(()=>{", "ctx.effect(()=>{window.requestIdleCallback(()=>document.body.setAttribute('data-idle-fired','true'));const cancelled=window.requestIdleCallback(()=>{throw new Error('cancelled callback ran');});window.cancelIdleCallback(cancelled);");
  new vm.Script(buildNativeClient({...options,clientBundles:[idleClient]})).runInContext(b.context);
  assert.equal(b.idles.size,1);const callback=[...b.idles.values()][0];callback({didTimeout:false,timeRemaining:()=>20});
  assert.equal(b.document.body.getAttribute('data-idle-fired'),'true');
  b.root[NATIVE_DSH_STATE_KEY].cleanup();
  // Browser delivery removes a fired callback; the fake keeps it for a stale-callback test.
  b.document.body.removeAttribute('data-idle-fired');callback({didTimeout:false,timeRemaining:()=>20});
  assert.equal(b.document.body.getAttribute('data-idle-fired'),null);
  const second=browser({idleCallbacks:true});new vm.Script(buildNativeClient({...options,clientBundles:[idleClient]})).runInContext(second.context);assert.equal(second.idles.size,1);second.root[NATIVE_DSH_STATE_KEY].cleanup();assert.equal(second.idles.size,0);
});

test('original shortcut descriptors match exact modifiers, persist changes, and clean listeners', () => {
  assert.deepEqual(normalizeShortcutBinding('Ctrl+Alt+W'),{code:'KeyW',modifiers:['ctrl','alt']});
  for(const value of ['Ctrl+Bogus+W','Ctrl+Ctrl+W','Ctrl+;','W'.repeat(81),{code:'KeyW',modifiers:[],extra:true},Object.create({code:'KeyW',modifiers:[]})])assert.throws(()=>normalizeShortcutBinding(value));
  const b=browser();
  const shortcuts=client.replace('ctx.effect(()=>{',`ctx.effect(()=>{const offShortcut=ctx.get('shortcuts').register({id:'wallpaper.sidebar.toggle',defaults:{'desktop:windows':{code:'KeyW',modifiers:['primary','alt']}},regions:['page','editable','terminal'],modals:[],resolve:()=>({status:'pass'})});`);
  const expression=buildNativeClient({...options,clientBundles:[shortcuts]});new vm.Script(expression).runInContext(b.context);
  const state=b.root[NATIVE_DSH_STATE_KEY],dialog=b.document.getElementById('codex-we-native-settings');
  function key(code='KeyW',extra={}){const event={code,ctrlKey:true,altKey:true,shiftKey:false,metaKey:false,target:b.document.body,prevented:0,stopped:0,preventDefault(){this.prevented++;},stopPropagation(){this.stopped++;},...extra};for(const fn of b.root.listeners.get('keydown')||[])fn(event);return event;}
  assert.equal(key('KeyX').prevented,0);assert.equal(dialog.open,undefined);
  assert.equal(key('KeyW',{shiftKey:true}).prevented,0);assert.equal(key('KeyW',{isComposing:true}).prevented,0);assert.equal(key('KeyW',{defaultPrevented:true}).prevented,0);
  assert.equal(key().prevented,1);assert.equal(dialog.open,true);assert.equal(key().prevented,1);assert.equal(dialog.open,false);
  const foreignDialog=new Element('dialog');b.queryNodes.set('dialog[open],[role="dialog"][aria-modal="true"]',foreignDialog);assert.equal(key().prevented,0);b.queryNodes.delete('dialog[open],[role="dialog"][aria-modal="true"]');
  state.configureShortcut('wallpaper.sidebar.toggle','Ctrl+Shift+Q');assert.equal(b.document.getElementById('codex-we-native-shortcut').value,'Ctrl+Shift+Q');
  assert.equal(key().prevented,0);assert.equal(key('KeyQ',{altKey:false,shiftKey:true,target:Object.assign(new Element('textarea'),{isContentEditable:true})}).prevented,1);
  new vm.Script(expression).runInContext(b.context);assert.equal(state.phase,'disposed');assert.equal(b.document.getElementById('codex-we-native-shortcut').value,'Ctrl+Shift+Q');
  assert.equal(b.root.listeners.get('keydown').size,1);b.root[NATIVE_DSH_STATE_KEY].configureShortcut('wallpaper.sidebar.toggle','');assert.equal(key('KeyQ',{altKey:false,shiftKey:true}).prevented,0);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();assert.equal(b.root.listeners.get('keydown').size,0);assert.equal(key().prevented,0);
});

test('native typography maps original role and component keys while preserving terminal/math ownership', () => {
  assert.equal(buildCodexTypographyCss({fontCustom:false,globalFamily:'KaiTi'}),'');
  const css=buildCodexTypographyCss({fontCustom:true,globalFamily:'KaiTi',themeSize:{'markdown-h1':27,'markdown-base':18},themeWeight:{'markdown-h1':650},themeFamily:{'markdown-code':'monospace'},componentFonts:{markdown:{size:6},codeBlock:{size:20,weight:700,family:'sys:Example Font'},table:{size:16},terminal:{size:30}},themeColors:{primary:{light:'#223344',dark:'#ddeeff'}}});
  assert.match(css,/--dsw-font-markdown-h1-font-size,27px/);assert.match(css,/--dsw-font-markdown-h1-font-weight,650/);
  assert.match(css,/data-markdown-copy="code-block"\] code\{font-size:20px/);assert.match(css,/"Example Font"/);assert.match(css,/markdown.* table\{font-size:16px/);assert.match(css,/font-size:6px/);
  assert.match(css,/--dsw-alias-label-primary/);assert.doesNotMatch(css,/terminal|xterm|katex|font-size:30px/);
  const invalid=buildCodexTypographyCss({fontCustom:true,globalFamily:'sys:bad";color:red',themeFamily:{'markdown-base':'sys:evil{}'},componentFonts:{markdown:{size:41}}});assert.equal(invalid,'');
});

test('native glass consumes per-region original variables and honors native surface policies', () => {
  const plain=buildCodexGlassCss({});assert.doesNotMatch(plain,/surface="sidebar".*backdrop-filter/);assert.doesNotMatch(plain,/surface="header"/);assert.doesNotMatch(plain,/surface="right-sidebar"/);
  const glass=buildCodexGlassCss({leftSidebarGlass:true,titlebarGlass:true,sidebarGlass:true,leftSidebarCornerRadius:'12',rightSidebarCornerRadius:'20',rightSidebarSquareTL:true});
  for(const name of ['--we-left-sidebar-alpha','--we-left-sidebar-blur','--we-titlebar-alpha','--we-titlebar-blur','--we-chat-readability-floor','--we-settings-window-alpha','--we-sidebar-tint','--we-sidebar-sheen','--we-sidebar-blur','--we-content-surface-alpha','--we-content-surface-color'])assert.ok(glass.includes(name),name);
  assert.match(glass,/right-sidebar"\]\{border-radius:20px/);assert.match(glass,/right-sidebar"\]\{border-top-left-radius:0/);
  const native=buildCodexGlassCss({leftSidebarGlass:true,titlebarGlass:true,sidebarGlass:true,glassSurfacePolicy:{content:'native','left-sidebar':'native','right-sidebar':'native','settings-window':'native',declared:'native'}});
  assert.doesNotMatch(native,/background-color:|backdrop-filter:|data-codex-we-surface=/);
  const clear=buildCodexGlassCss({sidebarGlass:true,sidebarFullClear:true});assert.match(clear,/data-we-sidebar-fullclear/);assert.doesNotMatch(clear,/--we-sidebar-tint/);
});

test('actual native composer card gets one glass layer; its seat, content and sibling controls retain ownership',()=>{
  const b=browser(),seat=new Element('div'),chrome=new Element('div'),card=new Element('div'),body=new Element('div'),input=new Element('div'),button=new Element('button'),code=new Element('code'),toolbar=new Element('div'),footer=new Element('div'),backdrop=new Element('div');
  seat.setAttribute('data-codex-composer-root','');seat.setAttribute('data-codex-we-surface','previous-seat');seat.className='min-w-0';chrome.className='composer-surface-chrome';card.className='_ComposerLayoutRoot_1q7o3_2';card.setAttribute('role','presentation');body.className='_ComposerLayoutBody_1q7o3_2';input.className='_ComposerLayoutInput_1q7o3_2 flex-grow overflow-y-auto';toolbar.className='sibling-toolbar';
  footer.setAttribute('data-thread-scroll-footer','true');backdrop.className='_background_106nk_2 _surface_106nk_2 pointer-events-none absolute inset-x-0 z-0 bottom-0 bg-surface extension:bg-surface-secondary';backdrop.style.setProperty('background-color','rgb(24, 24, 24)');
  seat.append(chrome);chrome.append(card);card.append(body);body.append(input,button,code);footer.append(backdrop,seat);b.document.body.append(footer,toolbar);
  card.style.setProperty('border-radius','22px');body.style.setProperty('background-color','rgb(54, 54, 54)');button.style.setProperty('background-color','rgb(50, 50, 50)');code.style.setProperty('font-family','Consolas');toolbar.style.setProperty('background-color','rgb(32, 32, 32)');
  b.queryNodes.set('[data-codex-composer-root]',[seat]);b.queryNodes.set('[class*="_ComposerLayoutRoot_"]',[card]);b.queryNodes.set('.composer-surface-chrome',[chrome]);b.queryNodes.set('[data-codex-composer-root] :is([class*="_ComposerLayoutBody_"],[class*="_ComposerLayoutInput_"],[data-composer-body])',[body,input]);
  b.queryNodes.set('[data-thread-scroll-footer] > div[class*="_background_"][class~="pointer-events-none"][class~="absolute"]',[backdrop]);
  const expression=buildNativeClient(options);new vm.Script(expression).runInContext(b.context);
  assert.equal(seat.getAttribute('data-codex-we-surface'),'composer-shell');assert.equal(card.getAttribute('data-codex-we-surface'),'composer');assert.equal(chrome.getAttribute('data-codex-we-surface'),null);assert.equal(body.getAttribute('data-codex-we-surface'),'composer-content');assert.equal(input.getAttribute('data-codex-we-surface'),'composer-content');assert.equal(backdrop.getAttribute('data-codex-we-surface'),'composer-backdrop');for(const node of [button,code,toolbar,footer])assert.equal(node.getAttribute('data-codex-we-surface'),null);
  const css=b.document.getElementById('codex-we-native-adapter-style').textContent;assert.match(css,/composer-shell"\].*composer-content"\].*composer-backdrop"\]\{background-color:transparent/);assert.match(css,/--codex-we-composer-alpha:clamp/);assert.match(css,/var\(--we-glass-alpha,0\.1225\)/);assert.match(css,/var\(--we-chat-readability-floor/);assert.match(css,/blur\(calc\(var\(--we-blur,16px\)\*1\.125\)\)/);assert.match(css,/var\(--codex-we-native-chat-tint\)/);assert.doesNotMatch(css,/composer"\]\s+\*/);
  const first=b.root[NATIVE_DSH_STATE_KEY];new vm.Script(expression).runInContext(b.context);assert.equal(first.phase,'disposed');assert.equal(card.getAttribute('data-codex-we-surface'),'composer');b.root[NATIVE_DSH_STATE_KEY].cleanup();
  assert.equal(seat.getAttribute('data-codex-we-surface'),'previous-seat');for(const node of [card,body,input,backdrop])assert.equal(node.getAttribute('data-codex-we-surface'),null);assert.equal(b.document.getElementById('codex-we-native-adapter-style'),null);assert.equal(backdrop.style.getPropertyValue('background-color'),'rgb(24, 24, 24)');
  assert.equal(card.style.getPropertyValue('border-radius'),'22px');assert.equal(body.style.getPropertyValue('background-color'),'rgb(54, 54, 54)');assert.equal(button.style.getPropertyValue('background-color'),'rgb(50, 50, 50)');assert.equal(code.style.getPropertyValue('font-family'),'Consolas');assert.equal(toolbar.style.getPropertyValue('background-color'),'rgb(32, 32, 32)');
});

test('native font hook uses genuine known component probes and restores tokens and theme attributes', () => {
  const b=browser();const markdown=new Element('div'),code=new Element('code'),table=new Element('table');
  for(const[selector,node]of [['.thread-scroll-container [class*="_markdown"]',markdown],['.thread-scroll-container [data-markdown-copy="code-block"] code',code],['.thread-scroll-container [class*="_markdown"] table',table]])b.queryNodes.set(selector,node);
  b.root.getComputedStyle=function(node){assert.equal(this.document,b.document);return{fontSize:node===code?'15px':'17px',fontWeight:'500',fontFamily:node===code?'Consolas':'Native UI',lineHeight:'25px',color:'#abc123',getPropertyValue:key=>b.document.documentElement.style.getPropertyValue(key)};};
  const fontClient=client.replace("globalThis.__privateDSHMarker='private';",`globalThis.__privateDSHMarker='private';const capabilities=globalThis.__CODEX_WE_FONT_COMPONENTS__();document.body.setAttribute('data-font-fixture',JSON.stringify({ids:capabilities.ids,defaults:capabilities.defaults,terminal:capabilities.unavailable.terminal,token:capabilities.hasToken('--dsw-font-markdown-base-font-size')}));`);
  new vm.Script(buildNativeClient({...options,clientBundles:[fontClient]})).runInContext(b.context);
  const value=JSON.parse(b.document.body.getAttribute('data-font-fixture'));assert.deepEqual(value.ids,['markdown','codeBlock','table']);assert.equal(value.defaults.codeBlock.size,15);assert.equal(value.defaults.markdown.family,'Native UI');assert.equal(value.token,true);assert.match(value.terminal,/公开接口/);
  assert.equal(b.root.__CODEX_WE_FONT_COMPONENTS__,undefined);assert.equal(b.document.body.hasAttribute('data-ds-dark-theme'),true);assert.equal(b.root[NATIVE_DSH_STATE_KEY].summary().terminalFontSupported,false);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();assert.equal(b.document.body.hasAttribute('data-ds-dark-theme'),false);assert.equal(b.document.documentElement.style.getPropertyValue('--dsw-font-markdown-base-font-size'),'');assert.equal(b.document.documentElement.style.getPropertyValue('--dsw-alias-label-primary'),'#777777');
});

test('native font source extension preserves ordinary DSH probing and hides unavailable native controls', async () => {
  const base=new URL('../plugins/gpt-wallpaper/vendor/dsh-engine/source/',import.meta.url);
  const apply=(await fs.readFile(new URL('src/font/apply.js',base),'utf8')).replace(/\nexport\s*\{[\s\S]*?\};\s*$/,'');
  let probes=0;const context=vm.createContext({COMPONENT_FONT_TARGETS:[{id:'markdown'},{id:'codeBlock'},{id:'terminal'},{id:'table'}],document:{body:{}},probeComponentTargets:()=>{probes++;return['terminal'];},scanHookScopes:()=>({}),componentScopeSelector:()=>null,getComputedStyle:()=>({getPropertyValue:()=>''}),__CODEX_WE_FONT_COMPONENTS__:()=>({ids:['markdown','codeBlock','table','invented'],defaults:{markdown:{size:17}},hasToken:()=>true,unavailable:{terminal:'不可用'}})});
  new vm.Script(apply).runInContext(context);assert.deepEqual([...new vm.Script('componentFontAvailability().ids').runInContext(context)],['markdown','codeBlock','table']);assert.equal(new vm.Script('componentFontDefaults().markdown.size').runInContext(context),17);assert.equal(probes,0);
  delete context.__CODEX_WE_FONT_COMPONENTS__;assert.deepEqual([...new vm.Script('componentFontAvailability().ids').runInContext(context)],['terminal']);assert.equal(probes,1);
  const source=(await fs.readFile(new URL('packages/fonts/src/appearance-font-section.js',base),'utf8')).replace(/\nexport\s*\{[\s\S]*?\};\s*$/,'');
  const react={Fragment:'fragment',createElement:(type,props,...children)=>({type,props,children})};
  const panel=vm.createContext({React:react,weT:text=>text,ctlText:text=>text,switchRow:()=>null,sanitizeFamilyKey:value=>value||'',fontFamilyKeyOf:value=>value||'',FONT_FAMILY_LABELS:[],filterUsableSystemFonts:()=>({fonts:[],skipped:0}),systemFontKeyOf:value=>value,systemFontNameOf:value=>value,COMPONENT_FONT_TARGETS:[{id:'markdown'},{id:'codeBlock'},{id:'terminal'},{id:'table'}],componentFontDefaults:()=>({}),__CODEX_WE_FONT_COMPONENTS__:()=>({unavailable:{terminal:'终端字体不可用'}})});
  new vm.Script(source).runInContext(panel);const sel={componentFonts:{},systemFonts:[],fontAdvanced:true};panel.sel=sel;
  const flattened=value=>{if(!value||typeof value!=='object')return[];if(Array.isArray(value))return value.flatMap(flattened);return[value,...(value.children||[]).flatMap(flattened)];};
  const first=flattened(new vm.Script('renderFontGlobalFamily(sel,()=>{},()=>{},()=>{})').runInContext(panel));assert.ok(first.some(node=>node.props?.key==='terminal-unavailable'));assert.ok(!first.some(node=>node.props?.key==='terminal-family'));
  const advanced=flattened(new vm.Script('renderFontComponents(sel,()=>{},()=>{},()=>{})').runInContext(panel));assert.ok(!advanced.some(node=>node.type==='tr'&&node.props?.key==='terminal'));assert.ok(advanced.some(node=>node.type==='tr'&&node.props?.key==='codeBlock'));
  delete panel.__CODEX_WE_FONT_COMPONENTS__;assert.ok(flattened(new vm.Script('renderFontGlobalFamily(sel,()=>{},()=>{},()=>{})').runInContext(panel)).some(node=>node.props?.key==='terminal-family'));
});

test('scene transport error clears only after genuine iframe API access recovers', () => {
  const b=browser();let blocked=true;
  b.document.sceneWindow={get __wpStats(){if(blocked)throw new Error('Blocked cross-origin frame');return{frame:()=>({running:true,fps:30})};},get __wp(){if(blocked)throw new Error('Blocked cross-origin frame');return{getState:()=>({type:'scene'})};}};
  const scene=client.replace("const image=document.createElement('img');image.className='we-media';image.complete=true;image.naturalWidth=1920;layer.append(image);", "const frame=document.createElement('iframe');frame.className='we-live-iframe';frame.contentWindow=document.sceneWindow;layer.append(frame);");
  new vm.Script(buildNativeClient({...options,clientBundles:[scene]})).runInContext(b.context);const state=b.root[NATIVE_DSH_STATE_KEY],probe=[...b.intervals.values()].find(timer=>timer.ms===500);
  assert.match(state.error,/not same-origin/);assert.equal(state.ready,false);blocked=false;probe.fn();assert.equal(state.error,null);assert.equal(state.ready,true);assert.equal(state.fps,30);
  state.error='A distinct module failure';probe.fn();assert.equal(state.error,'A distinct module failure');assert.equal(state.ready,false);state.cleanup();
});

function bindingNative(handler) {
  const listeners=new Map(),sent=[];const native={URL,Headers,Request,Response,Blob,DOMException,atob,btoa,setTimeout,clearTimeout,fetch:async()=>new Response('native-fallback'),addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const reply=detail=>listeners.get('__gpt_dsh_native_reply__')?.({detail});native.__GPT_DSH_NATIVE_REQUEST__=value=>{const message=JSON.parse(value);sent.push(message);handler?.(message,reply);};return{native,reply,sent,listeners};
}
test('private Runtime fetch preserves binary bytes, HTTP failure statuses, headers and ack order', async () => {
  const payload=Uint8Array.from({length:262151},(_,i)=>i%251);let request;
  const b=bindingNative((message,reply)=>{if(message.op==='request'){request=message;queueMicrotask(()=>{reply({id:message.id,phase:'headers',status:418,headers:[['Content-Type','application/octet-stream'],['X-Fixture','yes']]});reply({id:message.id,phase:'chunk',index:0,chunkBase64:Buffer.from(payload.subarray(0,262144)).toString('base64')});});}else if(message.op==='ack'&&message.index===0)reply({id:message.id,phase:'chunk',index:1,chunkBase64:Buffer.from(payload.subarray(262144)).toString('base64')});else if(message.op==='ack'&&message.index===1)reply({id:message.id,phase:'end'});});
  const fetcher=createNativeDshFetch({native:b.native,apiBase:`app://-/dsh/${token}/wallpaper-engine`,loopbackBase:apiBase});
  const response=await fetcher(apiBase+'/settings',{method:'PUT',headers:{'Content-Type':'application/json'},body:'{"blur":8}'});
  assert.equal(request.url,`app://-/dsh/${token}/wallpaper-engine/settings`);assert.equal(Buffer.from(request.bodyBase64,'base64').toString(),'{"blur":8}');assert.equal(request.method,'PUT');assert.equal(response.status,418);assert.equal(response.ok,false);assert.equal(response.headers.get('x-fixture'),'yes');assert.equal(response.url,request.url);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()),payload);assert.deepEqual(b.sent.filter(m=>m.op==='ack').map(m=>m.index),[0,1]);assert.equal(fetcher.snapshot().active,0);fetcher.dispose();assert.equal(b.listeners.size,0);
});
test('private Runtime fetch forwards data/blob natively and cancels abort, timeout, malformed and disposed requests',async()=>{
  const b=bindingNative(),fetcher=createNativeDshFetch({native:b.native,apiBase,timeoutMs:15,maxBytes:8});assert.equal(await(await fetcher('data:text/plain,x')).text(),'native-fallback');assert.equal(b.sent.length,0);
  const controller=new AbortController(),aborted=fetcher(apiBase+'/settings',{signal:controller.signal});await new Promise(resolve=>setImmediate(resolve));controller.abort();await assert.rejects(aborted,{name:'AbortError'});assert.ok(b.sent.some(m=>m.op==='cancel'));
  const malformed=fetcher(apiBase+'/settings');await new Promise(resolve=>setImmediate(resolve));let id=b.sent.findLast(m=>m.op==='request').id;b.reply({id,phase:'headers',status:200,headers:[]});b.reply({id,phase:'chunk',index:3,chunkBase64:'AA=='});await assert.rejects(malformed,/out of order/);
  const huge=fetcher(apiBase+'/settings');await new Promise(resolve=>setImmediate(resolve));id=b.sent.findLast(m=>m.op==='request').id;b.reply({id,phase:'headers',status:200,headers:[['Content-Length','9']]});await assert.rejects(huge,/byte limit/);
  await assert.rejects(fetcher(apiBase+'/settings'),{name:'AbortError'});
  const pending=fetcher(apiBase+'/settings');await new Promise(resolve=>setImmediate(resolve));fetcher.dispose();await assert.rejects(pending,{name:'AbortError'});assert.equal(fetcher.snapshot().active,0);assert.equal(b.listeners.size,0);await assert.rejects(fetcher(apiBase+'/settings'),{name:'AbortError'});
});
test('private Runtime fetch handles HEAD/204 and rejects oversized request bodies before binding',async()=>{
  const b=bindingNative((message,reply)=>{if(message.op==='request')queueMicrotask(()=>{reply({id:message.id,phase:'headers',status:204,headers:[]});reply({id:message.id,phase:'end'});});});const fetcher=createNativeDshFetch({native:b.native,apiBase});
  assert.equal((await fetcher(apiBase+'/settings',{method:'HEAD'})).status,204);assert.equal((await fetcher(apiBase+'/settings',{method:'HEAD'})).body,null);
  const count=b.sent.length;await assert.rejects(fetcher(apiBase+'/settings',{method:'POST',body:new Uint8Array(1048577)}),/1 MiB/);assert.equal(b.sent.length,count);fetcher.dispose();
});
test('media resource ranges assemble a full real file and reject fragment mismatch and excessive totals',async()=>{
  const calls=[];const file=await readNativeResource(async(_url,init)=>{calls.push(init.headers.Range);const offset=calls.length===1?0:4;return new Response(Uint8Array.from(offset===0?[1,2,3,4]:[5,6,7]),{status:206,headers:{'Content-Range':`bytes ${offset}-${offset===0?3:6}/7`,'Content-Type':'video/mp4'}});},apiBase+'/media/video');
  assert.deepEqual(calls,['bytes=0-4194303','bytes=4-4194307']);assert.equal(file.size,7);assert.equal(file.type,'video/mp4');assert.deepEqual([...new Uint8Array(await new Blob(file.parts).arrayBuffer())],[1,2,3,4,5,6,7]);
  await assert.rejects(readNativeResource(async()=>new Response('x',{status:206,headers:{'Content-Range':'bytes 0-3/9'}}),apiBase+'/media/video'),/does not match/);
  await assert.rejects(readNativeResource(async()=>new Response('x',{status:206,headers:{'Content-Range':'bytes 0-0/999'}}),apiBase+'/media/video',{maxBytes:8}),/does not match/);
});
test('native factory scopes bare fetch and initializes scene bridge before original module iframe creation',async()=>{
  const b=browser();b.root.fetch=async()=>{throw new Error('Native global fetch must remain untouched');};
  const listeners=b.root.listeners;b.root.__GPT_DSH_NATIVE_REQUEST__=raw=>{const request=JSON.parse(raw);if(request.op==='request')queueMicrotask(()=>{for(const fn of listeners.get('__gpt_dsh_native_reply__')||[])fn({detail:{id:request.id,phase:'headers',status:200,headers:[]}});for(const fn of listeners.get('__gpt_dsh_native_reply__')||[])fn({detail:{id:request.id,phase:'end'}});});};
  const originalFetch=b.root.fetch;
  const altered=client.replace("const React=require('react');globalThis.__privateDSHMarker='private';",`const React=require('react');fetch(globalThis.__CODEX_WE_API_BASE__+'/settings').then(r=>document.body.setAttribute('data-bound-fetch',String(r.status)));const own=document.createElement('iframe');if(!own.wrappedFixture)throw Error('Scene bridge initialized too late');globalThis.__privateDSHMarker='private';`);
  const sceneRuntimeSource=`function(options){return{wrap(frame){frame.wrappedFixture=true;return frame;},snapshot(){return{fixture:true}},dispose(){options.document.body.setAttribute('data-scene-disposed','yes')}}}`;
  new vm.Script(buildNativeClient({...options,clientBundles:[altered],sceneRuntimeSource})).runInContext(b.context);await new Promise(resolve=>setImmediate(resolve));assert.equal(b.document.body.getAttribute('data-bound-fetch'),'200');assert.equal(b.root.fetch,originalFetch);assert.equal(b.root[NATIVE_DSH_STATE_KEY].summary().sceneBridge.fixture,true);assert.equal(b.document.getElementById('codex-we-native-capabilities'),null);b.root[NATIVE_DSH_STATE_KEY].cleanup();assert.equal(b.document.body.getAttribute('data-scene-disposed'),'yes');
});
test('Scene/Web selection cannot become ready by showing a poster fallback',()=>{
  for(const type of ['scene','web']){const b=browser(),selected=client.replace("selection:{id:'fixture'}",`selection:{id:'fixture',type:'${type}',sceneLive:true}`);const result=new vm.Script(buildNativeClient({...options,clientBundles:[selected]})).runInContext(b.context);assert.equal(result.expectedType,type);assert.equal(result.expectedId,'fixture');assert.equal(result.transport,'image');assert.equal(result.ready,false);b.root[NATIVE_DSH_STATE_KEY].cleanup();}
  const b=browser(),disabled=client.replace("selection:{id:'fixture'}","selection:{id:'fixture',type:'scene',sceneLive:false}");assert.equal(new vm.Script(buildNativeClient({...options,clientBundles:[disabled]})).runInContext(b.context).ready,true);b.root[NATIVE_DSH_STATE_KEY].cleanup();
});
test('only plugin-owned media becomes a complete blob and cleanup revokes it',async()=>{
  const b=browser(),created=[],revoked=[];const nativeFetch=async()=>{throw Error('Owned media should use binding');};b.root.fetch=nativeFetch;
  b.root.URL=class extends URL{static createObjectURL(blob){const url=URL.createObjectURL(blob);created.push({url,blob});return url;}static revokeObjectURL(url){revoked.push(url);URL.revokeObjectURL(url);}};
  class MediaFixture extends Element{get src(){return this.attrs.get('src')||'';}set src(value){this.attrs.set('src',String(value));if(String(value).startsWith('blob:')){this.readyState=4;this.videoWidth=3840;this.videoHeight=2160;}}get currentSrc(){return this.src;}get poster(){return this.attrs.get('poster')||'';}set poster(value){this.attrs.set('poster',value);}load(){this.loads=(this.loads||0)+1;}play(){this.paused=false;return Promise.resolve();}}
  const originalCreate=b.document.createElement;b.document.createElement=tag=>['img','video'].includes(tag)?new MediaFixture(tag):originalCreate(tag);
  const emit=detail=>{for(const fn of b.root.listeners.get('__gpt_dsh_native_reply__')||[])fn({detail});};b.root.__GPT_DSH_NATIVE_REQUEST__=raw=>{const request=JSON.parse(raw);if(request.op==='request')queueMicrotask(()=>{emit({id:request.id,phase:'headers',status:206,headers:[['Content-Type','video/mp4'],['Content-Range','bytes 0-3/4']]});emit({id:request.id,phase:'chunk',index:0,chunkBase64:'AQIDBA=='});});else if(request.op==='ack')emit({id:request.id,phase:'end'});};
  const media=client.replace('layer.append(image);',"const video=document.createElement('video');video.className='we-media';video.autoplay=true;video.src=globalThis.__CODEX_WE_API_BASE__+'/media/fixture';layer.append(video);");
  new vm.Script(buildNativeClient({...options,clientBundles:[media]})).runInContext(b.context);
  const video=b.document.getElementById('dsh-wallpaper-engine-layer').querySelector('video.we-media');for(let i=0;i<20&&!video.getAttribute('src');i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(video.src,apiBase+'/media/fixture');assert.match(video.getAttribute('src'),/^blob:/,JSON.stringify(b.root[NATIVE_DSH_STATE_KEY].summary()));assert.equal(video.videoWidth,3840);assert.equal(video.paused,false);assert.equal(created.length,1);assert.equal(created[0].blob.size,4);assert.equal(created[0].blob.type,'video/mp4');assert.equal(b.root.fetch,nativeFetch);
  b.root[NATIVE_DSH_STATE_KEY].cleanup();assert.deepEqual(revoked,[created[0].url]);assert.equal(b.root.listeners.get('__gpt_dsh_native_reply__').size,0);
});

test('actual locally built DSH bundles produce a syntactically valid native factory', async () => {
  const base=new URL('../plugins/gpt-wallpaper/vendor/dsh-engine/source/',import.meta.url);
  const paths=['lib/client.js','packages/fonts/lib/client.fonts.js','packages/fx/lib/client.fx.js','packages/parallax/lib/client.parallax.js','packages/pet-link/lib/client.pet-link.js'];
  const clientBundles=await Promise.all(paths.map(file=>fs.readFile(new URL(file,base),'utf8')));
  const source=buildNativeClientFactory({...options,clientBundles});
  assert.ok(Buffer.byteLength(source)<10*1024*1024);
  assert.doesNotThrow(()=>new vm.Script('('+source+')'));
  assert.ok(source.includes('WallpaperPickerSection'));
});
