/**
 * Mount the real, locally built DSH browser clients in a scoped module realm.
 * This builder never fetches or evaluates script URLs. The caller supplies
 * trusted local UMD/module text and delivers the result through verified CDP.
 */
export const NATIVE_DSH_STATE_KEY = '__GPT_DSH_NATIVE_STATE__';
const MAX_SCRIPT_BYTES = 10 * 1024 * 1024;
const DEFAULT_MAIN = 'dsh-plugin-wallpaper-engine';
const KNOWN_CLIENTS = [DEFAULT_MAIN, ...['fonts','fx','parallax','pet-link'].map(name => `${DEFAULT_MAIN}-${name}`)];

/** Private, finite Runtime binding transport. Never replaces the host fetch. */
export function createNativeDshFetch({native,apiBase,loopbackBase=apiBase,timeoutMs=30000,maxBytes=512*1024*1024}={}) {
  const endpoint=new URL(apiBase),loopback=new URL(loopbackBase),pending=new Map();let serial=0,stopped=false;
  const binding='__GPT_DSH_NATIVE_REQUEST__',eventName='__gpt_dsh_native_reply__';
  const HeadersClass=native.Headers,ResponseClass=native.Response,RequestClass=native.Request;
  const abortError=message=>new (native.DOMException||DOMException)(message,'AbortError');
  const emit=value=>{if(typeof native[binding]!=='function')throw new TypeError('Native wallpaper transport is unavailable');native[binding](JSON.stringify(value));};
  const decode=value=>{if(typeof value!=='string'||value.length>349528||value.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(value))throw new TypeError('Invalid wallpaper response chunk');const raw=native.atob(value),bytes=new Uint8Array(raw.length);if(raw.length>262144)throw new TypeError('Wallpaper response chunk is too large');for(let i=0;i<raw.length;i++)bytes[i]=raw.charCodeAt(i);return bytes;};
  const encode=bytes=>{let value='';for(let i=0;i<bytes.length;i+=32768)value+=String.fromCharCode(...bytes.subarray(i,i+32768));return native.btoa(value);};
  const canonical=input=>{let url=new URL(String(input),apiBase+'/');if(url.username||url.password)throw new TypeError('Wallpaper URL contains credentials');const root=endpoint.pathname.replace(/\/wallpaper-engine$/,'');const allowed=url.pathname.startsWith(root+'/')&&!/%2f|%5c|%00/i.test(url.pathname);if(allowed&&url.protocol===loopback.protocol&&url.host===loopback.host)url=new URL(endpoint.protocol+'//'+endpoint.host+url.pathname+url.search+url.hash);
    return{url:url.href,owned:allowed&&url.protocol===endpoint.protocol&&url.host===endpoint.host};};
  const finish=(record,error)=>{if(!pending.delete(record.id))return;native.clearTimeout(record.timer);record.signal?.removeEventListener('abort',record.abort);if(error){try{emit({op:'cancel',id:record.id});}catch{}record.reject(error);return;}
    try{const empty=record.method==='HEAD'||[204,205,304].includes(record.status);const response=new ResponseClass(empty?null:new native.Blob(record.parts),{status:record.status,headers:record.headers});try{Object.defineProperty(response,'url',{value:record.url});Object.defineProperty(response,'type',{value:'basic'});}catch{}record.resolve(response);}catch(error){record.reject(error);}};
  const arm=record=>{native.clearTimeout(record.timer);record.timer=native.setTimeout(()=>finish(record,abortError('Wallpaper request timed out')),timeoutMs);};
  const receive=event=>{const message=event?.detail;if(!message||typeof message!=='object')return;const record=pending.get(message.id);if(!record)return;
    try{arm(record);if(message.phase==='headers'){if(record.status!==null||!Number.isInteger(message.status)||message.status<200||message.status>599||!Array.isArray(message.headers)||message.headers.length>100)throw new TypeError('Invalid wallpaper response headers');record.status=message.status;record.headers=new HeadersClass(message.headers);const length=Number(record.headers.get('content-length'));if(Number.isFinite(length)&&length>maxBytes)throw new TypeError('Wallpaper response exceeds its byte limit');}
      else if(message.phase==='chunk'){if(record.status===null||message.index!==record.index)throw new TypeError('Wallpaper response chunks are out of order');const bytes=decode(message.chunkBase64);record.total+=bytes.length;if(record.total>maxBytes)throw new TypeError('Wallpaper response exceeds its byte limit');record.parts.push(bytes);record.index++;emit({op:'ack',id:record.id,index:message.index});}
      else if(message.phase==='end'){if(record.status===null)throw new TypeError('Wallpaper response has no headers');finish(record);}
      else if(message.phase==='error')finish(record,new TypeError(String(message.error||'Wallpaper request failed').slice(0,240)));
    }catch(error){finish(record,error);}};
  native.addEventListener(eventName,receive);
  async function privateFetch(input,init={}) {
    if(stopped)throw abortError('Wallpaper client disposed');const target=canonical(typeof input==='string'||input instanceof URL?input:input.url);
    if(!target.owned)return native.fetch.call(native,input,init);
    const request=new RequestClass(typeof input==='string'||input instanceof URL?target.url:input,init),method=request.method.toUpperCase();
    if(!['GET','HEAD','OPTIONS','POST','PATCH','PUT','DELETE'].includes(method))throw new TypeError('Wallpaper request method is not allowed');
    if(request.signal.aborted)throw abortError('Wallpaper request aborted');
    let bodyBase64;
    if(request.body){const reader=request.body.getReader(),parts=[];let length=0;try{while(true){if(request.signal.aborted)throw abortError('Wallpaper request aborted');const part=await reader.read();if(part.done)break;length+=part.value.byteLength;if(length>1048576)throw new TypeError('Wallpaper request body exceeds 1 MiB');parts.push(part.value);}}catch(error){try{await reader.cancel();}catch{}throw error;}const bytes=new Uint8Array(length);let offset=0;for(const part of parts){bytes.set(part,offset);offset+=part.byteLength;}bodyBase64=encode(bytes);}
    if(stopped||request.signal.aborted)throw abortError('Wallpaper request aborted');
    return new Promise((resolve,reject)=>{const id='dsh-'+Date.now().toString(36)+'-'+(++serial).toString(36);const record={id,url:target.url,method,resolve,reject,signal:request.signal,abort:null,timer:null,status:null,headers:null,parts:[],total:0,index:0};record.abort=()=>finish(record,abortError('Wallpaper request aborted'));pending.set(id,record);record.signal.addEventListener('abort',record.abort,{once:true});arm(record);try{emit({op:'request',id,url:target.url,method,headers:[...request.headers],...(bodyBase64===undefined?{}:{bodyBase64})});}catch(error){finish(record,error);}});
  }
  privateFetch.dispose=()=>{if(stopped)return;stopped=true;native.removeEventListener(eventName,receive);for(const record of [...pending.values()])finish(record,abortError('Wallpaper client disposed'));};
  privateFetch.snapshot=()=>({active:pending.size,available:typeof native[binding]==='function'});
  privateFetch.owns=input=>{try{return canonical(input).owned;}catch{return false;}};
  return privateFetch;
}

/** Assemble the actual full file; a first 206 fragment is never a playable file. */
export async function readNativeResource(fetchImpl,url,{signal,maxBytes=512*1024*1024}={}) {
  const parts=[];let offset=0,total=null,type='application/octet-stream';
  for(let step=0;step<128;step++){
    const response=await fetchImpl(url,{signal,headers:{Range:`bytes=${offset}-${offset+4194303}`}});if(!response.ok)throw new Error('Wallpaper resource returned '+response.status);
    type=response.headers.get('content-type')||type;const declared=Number(response.headers.get('content-length'));if(Number.isFinite(declared)&&declared>maxBytes)throw new Error('Wallpaper resource exceeds its byte limit');
    const bytes=new Uint8Array(await response.arrayBuffer());if(response.status===200){if(offset!==0||bytes.length>maxBytes)throw new Error('Wallpaper resource ignored its range');return{parts:[bytes],type,size:bytes.length};}
    const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||'');if(response.status!==206||!range)throw new Error('Wallpaper resource has invalid range metadata');const start=Number(range[1]),end=Number(range[2]),length=Number(range[3]);
    if(!Number.isSafeInteger(length)||length<=0||length>maxBytes||start!==offset||end<start||end>=length||bytes.length!==end-start+1||(total!==null&&total!==length))throw new Error('Wallpaper resource range does not match its bytes');
    total=length;parts.push(bytes);offset=end+1;if(offset===total)return{parts,type,size:total};
  }
  throw new Error('Wallpaper resource exceeded its finite range count');
}

/** Original DSH role/settings names; targets come from the native selector contract. */
export function buildCodexTypographyCss(selection = {}) {
  if (selection.fontCustom !== true) return '';
  const scope = 'body[data-codex-we-native="on"]';
  const markdown = '[data-codex-we-surface="thread"] [class*="_markdown"]';
  const roles = {
    'markdown-base': markdown,
    'markdown-h1': `${markdown} h1`, 'markdown-h2': `${markdown} h2`,
    'markdown-h3': `${markdown} h3`, 'markdown-h4': `${markdown} h4`,
    'markdown-small': `${markdown} small`,
    'markdown-code': `${markdown} :not(pre)>code`,
    'markdown-code-block': '[data-codex-we-surface="thread"] [data-markdown-copy="code-block"] code',
    'markdown-table': `${markdown} td`, 'markdown-table-head': `${markdown} th`,
    'xs-13': '[data-codex-we-surface="sidebar"]',
    'xxs-12': '[data-codex-we-surface="composer"] [class*="_ComposerLayoutFooter_"]',
  };
  const family = value => {
    const known = { 'Microsoft YaHei':'"Microsoft YaHei", sans-serif', KaiTi:'KaiTi, serif', SimSun:'SimSun, serif', SimHei:'SimHei, sans-serif', STXingkai:'"STXingkai", "Xingkai SC", KaiTi, serif', monospace:'ui-monospace, Consolas, "Courier New", monospace' };
    if (Object.hasOwn(known,value)) return known[value];
    if (typeof value === 'string' && value.startsWith('sys:')) {
      const name=value.slice(4).trim();
      if(name&&name.length<=120&&!/[;{}<>"'\\\u0000-\u001f]/.test(name))return `"${name}", var(--we-host-font-family, system-ui)`;
    }
    return '';
  };
  const fontDecl = (entry, role = '') => {
    if (!entry || typeof entry !== 'object') return '';
    const declarations = [];
    if(Number.isInteger(entry.size)&&entry.size>=(role?8:6)&&entry.size<=(role?48:40))declarations.push(`font-size:${role?`var(--dsw-font-${role}-font-size,${entry.size}px)`:`${entry.size}px`}!important`);
    if(Number.isInteger(entry.weight)&&entry.weight>=100&&entry.weight<=900)declarations.push(`font-weight:${role?`var(--dsw-font-${role}-font-weight,${entry.weight})`:entry.weight}!important`);
    const stack=family(entry.family);if(stack)declarations.push(`font-family:${role?`var(--dsw-font-${role}-font-family,${stack})`:stack}!important`);
    return declarations.join(';');
  };
  const rules=[];
  const global=family(selection.globalFamily);
  if(global)rules.push(`${scope} [data-codex-we-surface="sidebar"],${scope} [data-codex-we-surface="composer"],${scope} [data-codex-we-surface="thread"],${scope} ${markdown}{font-family:var(--dsw-font-family,${global})!important}`);
  for(const[role,target]of Object.entries(roles)){
    const declarations=fontDecl({size:selection.themeSize?.[role],weight:selection.themeWeight?.[role],family:selection.themeFamily?.[role]},role);
    if(declarations)rules.push(`${scope} ${target}{${declarations}}`);
  }
  const components={markdown,codeBlock:'[data-codex-we-surface="thread"] [data-markdown-copy="code-block"] code',table:`${markdown} table`};
  for(const[id,target]of Object.entries(components)){const declarations=fontDecl(selection.componentFonts?.[id]);if(declarations)rules.push(`${scope} ${target}{${declarations}}`);}
  const colorRoles={primary:`${markdown},[data-codex-we-surface="composer"]`,secondary:'[data-codex-we-surface="sidebar"]',tertiary:`${markdown} small`,caption:'[data-codex-we-surface="composer"] [class*="_ComposerLayoutFooter_"]',dimmed:'[data-codex-we-surface="sidebar"] [aria-disabled="true"]'};
  for(const[role,targets]of Object.entries(colorRoles)){const pair=selection.themeColors?.[role];if(pair&&/^#[a-f0-9]{6}$/i.test(pair.light)&&/^#[a-f0-9]{6}$/i.test(pair.dark))rules.push(targets.split(',').map(target=>`${scope} ${target}`).join(',')+`{color:var(--dsw-alias-label-${role})!important}`);}
  return rules.join('\n');
}

/** Consume variables already resolved by original glass.js, including custom modes. */
export function buildCodexGlassCss(selection = {}) {
  const scope='body[data-codex-we-native="on"][data-we-glass-page]';
  const policy=selection.glassSurfacePolicy||{};
  const rules=[`${scope}{--codex-we-native-tint:var(--we-surface-tint-light,#ffffff);--codex-we-native-chat-tint:var(--we-chat-surface-tint-light,var(--we-surface-tint-light,#ffffff))}${scope}[data-ds-dark-theme]{--codex-we-native-tint:var(--we-surface-tint-dark,#101418);--codex-we-native-chat-tint:var(--we-chat-surface-tint-dark,var(--we-surface-tint-dark,#101418))}`];
  if(policy.content!=='native')rules.push(`${scope}[data-we-wallpaper] [data-codex-we-surface="main"],${scope}[data-we-wallpaper] [data-codex-we-surface="thread"]{background-color:transparent!important;background-image:none!important}`);
  const glass=(selector,color,alpha,blur,chat=false)=>{const base=chat?'var(--we-chat-readability-base,var(--we-readability-base,#101418))':'var(--we-readability-base,#101418)',floor=chat?'var(--we-chat-readability-floor,var(--we-readability-floor,0.15))':'var(--we-readability-floor,0.15)';return `${selector}{background-color:color-mix(in srgb,${base} calc(${floor}*100%),color-mix(in srgb,${color} calc(${alpha}*100%),transparent) calc((1 - ${floor})*100%))!important;background-image:none!important;backdrop-filter:blur(${blur}) saturate(var(--we-saturate,1.8))!important;border-color:var(--dsw-alias-border-l1,#ffffff26)!important}`;};
  if(selection.leftSidebarGlass===true&&policy['left-sidebar']!=='native')rules.push(glass(`${scope}[data-we-left-sidebar] [data-codex-we-surface="sidebar"]`,'var(--codex-we-native-tint)','var(--we-left-sidebar-alpha,0.15)','var(--we-left-sidebar-blur,16px)'));
  if(selection.titlebarGlass===true&&policy.declared!=='native')rules.push(glass(`${scope}[data-we-titlebar-glass] [data-codex-we-surface="header"]`,'var(--codex-we-native-tint)','var(--we-titlebar-alpha,0.15)','var(--we-titlebar-blur,16px)'));
  if(policy.declared!=='native'){
    const chat=`${scope}[data-we-glass-chat]`;
    // The native layout has an outer seat and an inner painted card. Painting
    // both compounds the DSH readability floor into an opaque black rectangle.
    // Keep one card; its lighter floor still responds to the original controls.
    rules.push(`${chat} [data-codex-we-surface="composer-shell"],${chat} [data-codex-we-surface="composer-content"],${chat} [data-codex-we-surface="composer-backdrop"]{background-color:transparent!important;background-image:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important}`);
    rules.push(`${chat} [data-codex-we-surface="composer"]{--codex-we-composer-alpha:clamp(0.06,calc(var(--we-glass-alpha,0.1225) + min(var(--we-chat-readability-floor,var(--we-readability-floor,0.59)),0.575)*0.1),0.35);background-color:color-mix(in srgb,var(--codex-we-native-chat-tint) calc(var(--codex-we-composer-alpha)*100%),transparent)!important;background-image:none!important;backdrop-filter:blur(calc(var(--we-blur,16px)*1.125)) saturate(var(--we-saturate,1.3))!important;-webkit-backdrop-filter:blur(calc(var(--we-blur,16px)*1.125)) saturate(var(--we-saturate,1.3))!important;border-color:color-mix(in srgb,var(--dsw-alias-border-l1,#ffffff) 22%,transparent)!important;box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--dsw-alias-border-l1,#ffffff) 22%,transparent),0 8px 28px #0000001a!important}`);
  }
  if(policy['settings-window']!=='native')rules.push(glass(`${scope}[data-we-glass-window] #codex-we-native-settings`,'var(--codex-we-native-tint)','var(--we-settings-window-alpha,var(--we-glass-alpha,0.15))','var(--we-settings-window-blur,var(--we-blur,16px))'));
  if(policy['right-sidebar']!=='native'){
    if(selection.sidebarFullClear===true)rules.push(`${scope}[data-we-sidebar-fullclear] [data-codex-we-surface="right-sidebar"],${scope}[data-we-sidebar-fullclear] [data-codex-we-surface="right-content"]{background:transparent!important;backdrop-filter:none!important}`);
    else if(selection.sidebarGlass===true){
      rules.push(`${scope}[data-we-sidebar-glass] [data-codex-we-surface="right-sidebar"]{background-color:color-mix(in srgb,var(--we-readability-base,#101418) calc(var(--we-readability-floor,0.15)*100%),color-mix(in srgb,var(--we-sidebar-color,#ffffff) var(--we-sidebar-tint,20%),transparent) calc((1 - var(--we-readability-floor,0.15))*100%))!important;background-image:linear-gradient(180deg,rgba(255,255,255,calc(var(--we-sidebar-sheen,1)*0.14)),rgba(255,255,255,calc(var(--we-sidebar-sheen,1)*0.04)) 38%,rgba(255,255,255,calc(var(--we-sidebar-sheen,1)*0.01)))!important;backdrop-filter:blur(var(--we-sidebar-blur,16px)) saturate(var(--we-sidebar-saturate,1.8))!important}`);
      rules.push(`${scope}[data-ds-dark-theme][data-we-sidebar-glass] [data-codex-we-surface="right-sidebar"]{background-color:color-mix(in srgb,var(--we-readability-base,#101418) calc(var(--we-readability-floor,0.15)*100%),color-mix(in srgb,var(--we-sidebar-color,#ffffff) calc(var(--we-sidebar-tint,20%)*0.65),transparent) calc((1 - var(--we-readability-floor,0.15))*100%))!important}`);
      rules.push(`${scope}[data-we-sidebar-glass] [data-codex-we-surface="right-content"]{background-color:color-mix(in srgb,var(--we-content-surface-color,var(--we-panel-color,#101418)) var(--we-content-surface-alpha,70%),transparent)!important}`);
    }
  }
  for(const[prefix,target]of [['leftSidebar','sidebar'],['rightSidebar','right-sidebar']]){
    if(['6','12','20'].includes(String(selection[prefix+'CornerRadius'])))rules.push(`${scope} [data-codex-we-surface="${target}"]{border-radius:${selection[prefix+'CornerRadius']}px!important}`);
    for(const[suffix,property]of [['TL','top-left'],['TR','top-right'],['BR','bottom-right'],['BL','bottom-left']])if(selection[prefix+'Square'+suffix]===true)rules.push(`${scope} [data-codex-we-surface="${target}"]{border-${property}-radius:0!important}`);
  }
  return rules.join('\n');
}

/** KeyboardEvent.code bindings used by the original DSH shortcuts service. */
export function normalizeShortcutBinding(value) {
  if(value===null||value==='')return null;
  let code,modifiers;
  if(typeof value==='string'){
    if(value.length>80)throw new Error('Shortcut is too long');
    const parts=value.split('+').map(part=>part.trim()).filter(Boolean);const key=parts.pop();
    code=/^[a-z]$/i.test(key||'')?'Key'+key.toUpperCase():/^\d$/.test(key||'')?'Digit'+key:key;
    const aliases={ctrl:'ctrl',control:'ctrl',alt:'alt',shift:'shift',meta:'meta',cmd:'meta',command:'meta',primary:'primary',cmdorctrl:'primary'};
    modifiers=parts.map(part=>{const modifier=aliases[part.toLowerCase()];if(!modifier)throw new Error('Invalid shortcut modifier');return modifier;});
  }else if(value&&typeof value==='object'&&!Array.isArray(value)){const prototype=Object.getPrototypeOf(value);if(prototype!==null&&prototype!==Object.prototype)throw new Error('Invalid shortcut object');if(Object.keys(value).some(key=>!['code','modifiers'].includes(key)))throw new Error('Unknown shortcut field');const fields=Object.getOwnPropertyDescriptors(value);if(!fields.code||!fields.modifiers||!Object.hasOwn(fields.code,'value')||!Object.hasOwn(fields.modifiers,'value'))throw new Error('Invalid shortcut fields');code=fields.code.value;modifiers=fields.modifiers.value;}
  else throw new Error('Invalid shortcut binding');
  if(typeof code!=='string'||!(/^(Key[A-Z]|Digit[0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Escape|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right))$/).test(code)||!Array.isArray(modifiers)||modifiers.some(item=>!['primary','ctrl','alt','shift','meta'].includes(item))||new Set(modifiers).size!==modifiers.length)throw new Error('Invalid shortcut binding');
  return {code,modifiers:[...modifiers]};
}

function serviceBase(value) {
  if (typeof value !== 'string') throw new Error('apiBase must be a loopback DSH API base');
  const match = /^http:\/\/127\.0\.0\.1:([0-9]{4,5})(\/dsh\/([a-f0-9]{64})\/wallpaper-engine)$/.exec(value);
  if (!match || Number(match[1]) < 1024 || Number(match[1]) > 65535) throw new Error('apiBase must be a tokenized loopback DSH API base');
  return {url:value,path:match[2],token:match[3]};
}
function nativeBase(value, expectedToken) {
  const match = typeof value === 'string' && /^app:\/\/([A-Za-z0-9_-][A-Za-z0-9._-]{0,126})\/dsh\/([a-f0-9]{64})\/wallpaper-engine$/.exec(value);
  if (!match || match[1].includes('..') || match[2] !== expectedToken) throw new Error('nativeApiBase must use the verified app origin and the same service token');
  return value;
}
function sourceText(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`${label} must be trusted local script text`);
  return value;
}
function optionsOf(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('Native client options are required');
  const base = serviceBase(options.apiBase);
  const reactSource = sourceText(options.reactSource,'reactSource');
  const reactDOMSource = sourceText(options.reactDOMSource,'reactDOMSource');
  if (!Array.isArray(options.clientBundles) || !options.clientBundles.length || options.clientBundles.length > 8) throw new Error('clientBundles must contain the local DSH browser bundles');
  const clientBundles = options.clientBundles.map((item, index) => sourceText(typeof item === 'string' ? item : item?.source, `clientBundles[${index}]`));
  const title = typeof options.title === 'string' ? options.title.trim().slice(0,80) : 'Wallpaper Engine';
  const sceneRuntimeSource=options.sceneRuntimeSource===undefined?null:sourceText(options.sceneRuntimeSource,'sceneRuntimeSource');
  return {base,reactSource,reactDOMSource,clientBundles,sceneRuntimeSource,title:title || 'Wallpaper Engine'};
}

const SHELL_CSS = `
#codex-we-native-trigger{position:fixed;right:22px;top:54px;z-index:2147480000;border:1px solid #ffffff33;border-radius:999px;padding:8px 14px;color:#f6f8ff;background:#182439d9;backdrop-filter:blur(18px);font:12px/1.4 system-ui,sans-serif;cursor:pointer;-webkit-app-region:no-drag}
#codex-we-native-settings{width:min(1080px,94vw);max-width:94vw;max-height:90vh;margin:auto;padding:0;border:1px solid #ffffff33;border-radius:20px;color:var(--dsw-alias-label-primary,#f1f4ff);background:var(--we-panel-color,#111923);box-shadow:0 28px 110px #0008;z-index:2147480001;font:14px/1.5 system-ui,sans-serif}
#codex-we-native-settings::backdrop{background:#0006;backdrop-filter:blur(3px)}
.codex-we-native-title{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:14px 20px;border-bottom:1px solid #ffffff20}
.codex-we-native-title strong{font-size:15px;font-weight:600}.codex-we-native-title button{border:1px solid #ffffff30;background:#ffffff0d;color:inherit;border-radius:9px;padding:5px 11px;cursor:pointer}
#codex-we-native-panel{padding:18px;max-height:calc(90vh - 65px);overflow:auto;overscroll-behavior:contain}
body[data-codex-we-native="on"][data-we-wallpaper]{isolation:isolate;background:transparent!important}
#codex-we-native-capabilities{margin:8px 20px;color:var(--dsw-alias-label-secondary,#aab2c3);font:12px/1.5 system-ui,sans-serif}
@media(prefers-reduced-motion:reduce){#codex-we-native-trigger{transition:none}}`;

function bootstrapSource(options, effectiveBaseExpression) {
  const {base,reactSource,reactDOMSource,clientBundles,sceneRuntimeSource,title} = options;
  const expression = `(() => {
    'use strict';
    const __native = globalThis;
    const __doc = __native.document;
    if (!__doc || !__doc.body || !__doc.head) throw new Error('Codex document is not ready');
    const __key = ${JSON.stringify(NATIVE_DSH_STATE_KEY)};
    const __prior = __native[__key];
    if (__prior && typeof __prior.cleanup === 'function') __prior.cleanup();
    const __apiBase = ${JSON.stringify(base.url)};
    const __effectiveBase = ${effectiveBaseExpression};
    const __effects = [], __disposers = [], __timeouts = new Set(), __intervals = new Set(), __rafs = new Set(), __idleHandles = new Set(), __listeners = new Set();
    const __modules = new Map(), __overlay = Object.create(null), __themeLayers = new Map(), __themeBefore = new Map(), __themeWritten = new Map();
    const __surfaceRecords = new Map(), __eventBus = new Map(), __pluginStyles = new Map(), __constructedSheets = new Set(), __baselineTokens = new Map(), __shortcuts = new Map();
    let __disposed = false, __settingsRender = null, __settingsRoot = null, __effectPhase = true, __surfaceObserver = null, __styleObserver = null, __mainClient = null, __refreshing = false, __adapterStyle = null,__privateFetch=null,__sceneBridge=null,__resourceObserver=null;
    const __resourceRecords=new Map(),__resourceCache=new Map(),__extraResourceRecords=new Set(),__backgroundRecords=new WeakMap();let __resourceBytes=0;
    const __state = {ready:false,error:null,revision:'dsh-native-1',phase:'mounting',apiBase:__apiBase,nativeApiBase:__effectiveBase,settingsRegistered:false,surfaceCount:0,wallpaperPresent:false,transport:null,fps:null};
    const __setTimeout = (fn,ms,...args) => {let id;id=__native.setTimeout(()=>{__timeouts.delete(id);if(!__disposed)fn(...args);},ms);__timeouts.add(id);return id;};
    const __clearTimeout = id => {__timeouts.delete(id);__native.clearTimeout(id);};
    const __setInterval = (fn,ms,...args) => {const id=__native.setInterval(()=>{if(!__disposed)fn(...args);},ms);__intervals.add(id);return id;};
    const __clearInterval = id => {__intervals.delete(id);__native.clearInterval(id);};
    const __raf = fn => {let id;id=__native.requestAnimationFrame(t=>{__rafs.delete(id);if(!__disposed)fn(t);});__rafs.add(id);return id;};
    const __caf = id => {__rafs.delete(id);__native.cancelAnimationFrame(id);};
    const __idle = (fn,options) => {let id;id=__native.requestIdleCallback.call(__native,deadline=>{__idleHandles.delete(id);if(!__disposed)fn(deadline);},options);__idleHandles.add(id);return id;};
    const __cancelIdle = id => {__idleHandles.delete(id);if(typeof __native.cancelIdleCallback==='function')__native.cancelIdleCallback.call(__native,id);};
    const __capture = o => typeof o==='boolean'?o:!!o?.capture;
    const __listen = (target,type,fn,opts) => {target.addEventListener(type,fn,opts);__listeners.add({target,type,fn,opts});};
    const __unlisten = (target,type,fn,opts) => {target.removeEventListener(type,fn,opts);for(const item of __listeners)if(item.target===target&&item.type===type&&item.fn===fn&&__capture(item.opts)===__capture(opts))__listeners.delete(item);};
    const __storagePrefix = 'gpt-wallpaper/dsh/';
    const __storageFallback = new Map();
    const __storage = {
      getItem(key){try{return __native.localStorage.getItem(__storagePrefix+key);}catch{return __storageFallback.get(String(key))??null;}},
      setItem(key,value){try{__native.localStorage.setItem(__storagePrefix+key,String(value));}catch{__storageFallback.set(String(key),String(value));}},
      removeItem(key){try{__native.localStorage.removeItem(__storagePrefix+key);}catch{}__storageFallback.delete(String(key));},
    };
    const __compileFonts=${buildCodexTypographyCss.toString()};
    const __compileGlass=${buildCodexGlassCss.toString()};
    const __parseBinding=${normalizeShortcutBinding.toString()};
    let __shortcutOverrides=Object.create(null);try{const saved=JSON.parse(__storage.getItem('native-shortcuts')||'{}');if(saved&&typeof saved==='object'&&!Array.isArray(saved))for(const[id,binding]of Object.entries(saved))if(/^[a-z0-9_.-]{1,80}$/i.test(id))try{__shortcutOverrides[id]=__parseBinding(binding);}catch{}}catch{}
    const __isMac=/mac/i.test(String(__native.navigator?.platform||__native.navigator?.userAgentData?.platform||''));
    const __shortcutService={register(definition){if(!definition||typeof definition.id!=='string'||!(/^[a-z0-9_.-]{1,80}$/i).test(definition.id)||typeof definition.resolve!=='function')throw new Error('Invalid shortcut descriptor');const platform=__isMac?'desktop:macos':'desktop:windows';const binding=__parseBinding(definition.defaults?.[platform]||definition.defaults?.['desktop:windows']||{code:'KeyW',modifiers:['primary','alt']});const record={definition,binding};__shortcuts.set(definition.id,record);return()=>{if(__shortcuts.get(definition.id)===record)__shortcuts.delete(definition.id);};}};
    const __bindingFor=(id,record)=>Object.prototype.hasOwnProperty.call(__shortcutOverrides,id)?__shortcutOverrides[id]:record.binding;
    function __shortcutLabel(binding){if(!binding)return '';return binding.modifiers.map(item=>({primary:__isMac?'Meta':'Ctrl',ctrl:'Ctrl',alt:'Alt',shift:'Shift',meta:'Meta'})[item]).concat(binding.code.replace(/^Key|^Digit/,'')).join('+');}
    function __updateShortcutInput(){const input=__doc.getElementById('codex-we-native-shortcut'),record=__shortcuts.get('wallpaper.sidebar.toggle');if(input&&record)input.value=__shortcutLabel(__bindingFor('wallpaper.sidebar.toggle',record));}
    function __configureShortcut(id,binding){if(__disposed||!__shortcuts.has(id))throw new Error('Shortcut is not registered');const parsed=__parseBinding(binding);__shortcutOverrides[id]=parsed;__storage.setItem('native-shortcuts',JSON.stringify(__shortcutOverrides));__updateShortcutInput();return parsed;}
    function __onShortcut(event){
      if(__disposed||event.defaultPrevented||event.repeat||event.isComposing)return;
      for(const[id,record]of __shortcuts){const binding=__bindingFor(id,record);if(!binding||event.code!==binding.code)continue;const modifiers=new Set(binding.modifiers.map(modifier=>modifier==='primary'?(__isMac?'meta':'ctrl'):modifier));if(!!event.ctrlKey!==modifiers.has('ctrl')||!!event.altKey!==modifiers.has('alt')||!!event.shiftKey!==modifiers.has('shift')||!!event.metaKey!==modifiers.has('meta'))continue;
        const target=event.target;const region=target?.closest?.('.xterm')?'terminal':target?.isContentEditable||['INPUT','TEXTAREA','SELECT'].includes(target?.tagName)?'editable':'page';if(Array.isArray(record.definition.regions)&&!record.definition.regions.includes(region))continue;
        const ownDialog=__doc.getElementById('codex-we-native-settings');const modal=__doc.querySelector?.('dialog[open],[role="dialog"][aria-modal="true"]');if(modal&&modal!==ownDialog)continue;
        let outcome;try{outcome=record.definition.resolve();}catch{continue;}
        if(outcome?.status==='handled'&&typeof outcome.run==='function'){outcome.run();event.preventDefault?.();event.stopPropagation?.();return;}
        if(id==='wallpaper.sidebar.toggle'&&typeof __state.openSettings==='function'){if(ownDialog?.open)__state.closeSettings();else __state.openSettings();event.preventDefault?.();event.stopPropagation?.();return;}
      }
    }
    function __sheetHasRules(sheet){try{return !!sheet&&sheet.cssRules.length>0;}catch{return false;}}
    function __adopted(){try{return Array.from(__doc.adoptedStyleSheets||[]);}catch{return [];}}
    function __dropConstructed(record){
      if(!record.sheet)return;
      try{const sheets=__adopted();if(sheets.includes(record.sheet))__doc.adoptedStyleSheets=sheets.filter(sheet=>sheet!==record.sheet);}catch{}
      __constructedSheets.delete(record.sheet);record.sheet=null;record.appliedText=null;
    }
    function __syncPluginStyle(record){
      if(__disposed||record.node.isConnected!==true){__dropConstructed(record);return;}
      // A real inline stylesheet remains the normal path. Never spoof .sheet.
      if(__sheetHasRules(record.node.sheet)){__dropConstructed(record);return;}
      if(typeof __native.CSSStyleSheet!=='function'||!('adoptedStyleSheets' in __doc))return;
      let text='';try{text=record.readText();}catch{return;}
      try{
        if(!record.sheet){const sheet=new __native.CSSStyleSheet();if(typeof sheet.replaceSync!=='function')return;record.sheet=sheet;record.appliedText=null;__constructedSheets.add(sheet);}
        if(record.appliedText!==text){record.sheet.replaceSync(text);record.appliedText=text;}
        const current=__adopted();if(!current.includes(record.sheet))__doc.adoptedStyleSheets=[...current,record.sheet];
      }catch(error){record.error=String(error?.message||error).slice(0,160);__dropConstructed(record);}
    }
    function __syncPluginStyles(){for(const record of __pluginStyles.values())__syncPluginStyle(record);}
    function __createPluginElement(tag,...args){
      const node=__doc.createElement(tag,...args);
      if(String(tag).toLowerCase()==='iframe'&&__sceneBridge)return __sceneBridge.wrap(node);
      if(['img','video','audio','source'].includes(String(tag).toLowerCase()))return __wrapMediaElement(node);
      if(String(tag).toLowerCase()!=='style')return node;
      let owner=node,descriptor=null;
      while(owner&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'textContent');owner=Object.getPrototypeOf(owner);}
      const originalGet=descriptor?.get,originalSet=descriptor?.set;
      let stored=originalGet?originalGet.call(node):String(node.textContent||'');
      const record={node,sheet:null,appliedText:null,error:null,readText:()=>originalGet?String(originalGet.call(node)||''):stored};
      __pluginStyles.set(node,record);
      try{Object.defineProperty(node,'textContent',{configurable:true,enumerable:descriptor?.enumerable??true,get(){return record.readText();},set(value){stored=String(value??'');if(originalSet)originalSet.call(node,stored);__syncPluginStyle(record);}});}catch{}
      const originalRemove=node.remove;
      if(typeof originalRemove==='function')try{Object.defineProperty(node,'remove',{configurable:true,writable:true,value:function(...removeArgs){__dropConstructed(record);return originalRemove.apply(this,removeArgs);}});}catch{}
      return node;
    }
    function __stylesheetApplied(){
      const node=__doc.getElementById('codex-we-native-style');if(!node||node.isConnected!==true)return false;
      if(__sheetHasRules(node.sheet))return true;
      const record=__pluginStyles.get(node);return !!record?.sheet&&__adopted().includes(record.sheet)&&__sheetHasRules(record.sheet);
    }
    const __documentProxy = new Proxy(Object.create(null),{get(_,key){if(key==='createElement')return __createPluginElement;if(key==='addEventListener')return(type,fn,opts)=>__listen(__doc,type,fn,opts);if(key==='removeEventListener')return(type,fn,opts)=>__unlisten(__doc,type,fn,opts);const value=__doc[key];return typeof value==='function'?value.bind(__doc):value;},set(_,key,value){__doc[key]=value;return true;}});
    let __windowProxy;
    const __windowMethods = new Set(['getComputedStyle','matchMedia','fetch','open','alert','confirm','prompt','postMessage','dispatchEvent','focus','blur','getSelection','scrollTo','scrollBy']);
    __windowProxy = new Proxy(Object.create(null),{get(_,key){
      if(key==='window'||key==='self'||key==='globalThis')return __windowProxy;if(key==='document')return __documentProxy;
      if(key==='fetch'&&__privateFetch)return __privateFetch;if(key==='Image')return __PrivateImage;if(key==='localStorage')return __storage;if(key==='setTimeout')return __setTimeout;if(key==='clearTimeout')return __clearTimeout;
      if(key==='setInterval')return __setInterval;if(key==='clearInterval')return __clearInterval;if(key==='requestAnimationFrame')return __raf;if(key==='cancelAnimationFrame')return __caf;
      if(key==='requestIdleCallback')return typeof __native.requestIdleCallback==='function'?__idle:undefined;if(key==='cancelIdleCallback')return typeof __native.cancelIdleCallback==='function'?__cancelIdle:undefined;
      if(key==='addEventListener')return(type,fn,opts)=>__listen(__native,type,fn,opts);if(key==='removeEventListener')return(type,fn,opts)=>__unlisten(__native,type,fn,opts);
      if(Object.prototype.hasOwnProperty.call(__overlay,key))return __overlay[key];const value=__native[key];return __windowMethods.has(key)&&typeof value==='function'?value.bind(__native):value;
    },set(_,key,value){__overlay[key]=value;return true;},deleteProperty(_,key){delete __overlay[key];return true;},has(_,key){return key in __overlay||key in __native;}});
    const __summary = () => ({ready:__state.ready,error:__state.error,revision:__state.revision,phase:__state.phase,settingsRegistered:__state.settingsRegistered,surfaceCount:__state.surfaceCount,wallpaperPresent:__state.wallpaperPresent,transport:__state.transport,fps:__state.fps,expectedType:__mainClient?.selection?.type||null,expectedId:__mainClient?.selection?.id||null,refreshError:__state.refreshError||null,stylesheetApplied:__stylesheetApplied(),nativeFontComponents:__nativeFontComponents().ids,terminalFontSupported:false,shortcuts:[...__shortcuts.keys()],modules:[...__modules.keys()],binding:__privateFetch?.snapshot(),sceneBridge:__sceneBridge?.snapshot(),resourceError:__state.resourceError||null,resourceFailure:__state.resourceFailure||null});
    const __readNativeResource=${readNativeResource.toString()};
    function __resourceFailure(error,source,kind){const message=String(error?.message||error).slice(0,240);let route='invalid';try{route=new __native.URL(source,__effectiveBase+'/').pathname.split('/').map((part,index)=>index===2&&part.length===64?'<token>':part).join('/').slice(0,180);}catch{}__state.resourceError=message;__state.resourceFailure={kind,route,message};}
    function __resourceDrop(record){record.seq++;if(!record.entry)return;const entry=record.entry;record.entry=null;entry.refs--;if(entry.refs<=0){entry.controller.abort();if(entry.url)__native.URL.revokeObjectURL(entry.url);__resourceBytes-=entry.bytes||0;__resourceCache.delete(entry.source);}}
    function __resourceAcquire(source){let entry=__resourceCache.get(source);if(entry){entry.refs++;return entry;}entry={source,refs:1,url:null,bytes:0,controller:new __native.AbortController()};__resourceCache.set(source,entry);entry.promise=__readNativeResource(__privateFetch,source,{signal:entry.controller.signal}).then(file=>{if(__disposed||entry.controller.signal.aborted)throw new Error('Resource cancelled');if(__resourceBytes+file.size>512*1024*1024)throw new Error('Wallpaper media exceeds the shared byte limit');entry.bytes=file.size;__resourceBytes+=file.size;entry.url=__native.URL.createObjectURL(new __native.Blob(file.parts,{type:file.type}));return entry.url;});return entry;}
    function __wrapMediaElement(node){
      if(__resourceRecords.has(node))return node;let owner=node,descriptor=null;while(owner&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(owner,'src');owner=Object.getPrototypeOf(owner);}if(!descriptor?.set||!descriptor?.get)return node;
      const originalSetAttribute=node.setAttribute,originalRemoveAttribute=node.removeAttribute,originalRemove=node.remove;const record={node,seq:0,entry:null,original:null};__resourceRecords.set(node,record);
      const assign=value=>{const source=String(value??'');if(record.original===source&&record.entry)return;__resourceDrop(record);record.original=source;if(!source||!__privateFetch?.owns(source)){descriptor.set.call(node,source);return;}const seq=record.seq,entry=__resourceAcquire(source);record.entry=entry;try{originalRemoveAttribute.call(node,'src');}catch{}
        entry.promise.then(url=>{if(__disposed||record.seq!==seq||record.entry!==entry)return;descriptor.set.call(node,url);if(node.tagName==='VIDEO'||node.tagName==='AUDIO'){try{node.load();if(node.autoplay)node.play()?.catch?.(()=>{});}catch{}}},error=>{if(!__disposed&&record.seq===seq){__resourceFailure(error,source,node.tagName.toLowerCase());try{node.dispatchEvent(new __native.Event('error'));}catch{}}});};
      let posterAssign=null,posterRecord=null;
      if(node.tagName==='VIDEO'){let own=node,poster=null;while(own&&!poster){poster=Object.getOwnPropertyDescriptor(own,'poster');own=Object.getPrototypeOf(own);}if(poster?.set&&poster?.get){posterRecord={node,seq:0,entry:null,original:null};__extraResourceRecords.add(posterRecord);posterAssign=value=>{const source=String(value??'');if(posterRecord.original===source&&posterRecord.entry)return;__resourceDrop(posterRecord);posterRecord.original=source;if(!source||!__privateFetch?.owns(source)){poster.set.call(node,source);return;}const seq=posterRecord.seq,entry=__resourceAcquire(source);posterRecord.entry=entry;originalRemoveAttribute.call(node,'poster');entry.promise.then(url=>{if(!__disposed&&posterRecord.seq===seq)poster.set.call(node,url);},error=>{if(!__disposed&&posterRecord.seq===seq)__state.resourceError=String(error?.message||error).slice(0,240);});};try{Object.defineProperty(node,'poster',{configurable:true,get(){return posterRecord.original===null?poster.get.call(node):posterRecord.original;},set:posterAssign});}catch{}}}
      try{Object.defineProperty(node,'src',{configurable:true,get(){return record.original===null?descriptor.get.call(node):record.original;},set:assign});if('currentSrc'in node)Object.defineProperty(node,'currentSrc',{configurable:true,get(){return record.original||'';}});
        node.setAttribute=function(name,value){const key=String(name).toLowerCase();if(key==='src')assign(value);else if(key==='poster'&&posterAssign)posterAssign(value);else return originalSetAttribute.call(this,name,value);};node.removeAttribute=function(name){const key=String(name).toLowerCase();if(key==='src'){__resourceDrop(record);record.original=null;}else if(key==='poster'&&posterRecord){__resourceDrop(posterRecord);posterRecord.original=null;}return originalRemoveAttribute.call(this,name);};node.remove=function(){__resourceDrop(record);if(posterRecord)__resourceDrop(posterRecord);return originalRemove.call(this);};
      }catch{}return node;
    }
    function __PrivateImage(width,height){const node=__wrapMediaElement(__doc.createElement('img'));if(width!==undefined)node.width=width;if(height!==undefined)node.height=height;return node;}
    function __scanOwnedResources(){
      const roots=__doc.querySelectorAll?.('#codex-we-native-settings,#dsh-wallpaper-engine-layer,#dsh-wallpaper-engine-rope-dock,.we-picker,.we-wall-sidebar')||[];
      for(const root of roots){for(const node of root.querySelectorAll?.('img,video,audio,source')||[]){const source=node.getAttribute('src'),poster=node.getAttribute('poster');__wrapMediaElement(node);if(source&&__privateFetch?.owns(source)&&!__resourceRecords.get(node)?.entry)node.src=source;if(poster&&__privateFetch?.owns(poster))node.poster=poster;}
        for(const node of [root,...root.querySelectorAll?.('[style]')||[]]){const css=node.style?.backgroundImage||'',match=/^url\\(["']?([^"')]+)["']?\\)$/.exec(css.trim());if(!match||!__privateFetch?.owns(match[1]))continue;const source=match[1];let record=__backgroundRecords.get(node);if(record?.original===source&&record.entry)continue;if(record)__resourceDrop(record);else{record={node,seq:0,entry:null,original:null};__backgroundRecords.set(node,record);__extraResourceRecords.add(record);}record.original=source;const seq=record.seq,entry=__resourceAcquire(source);record.entry=entry;entry.promise.then(url=>{if(!__disposed&&record.seq===seq&&node.style.backgroundImage===css)node.style.backgroundImage='url("'+url+'")';},error=>{if(!__disposed&&record.seq===seq)__state.resourceError=String(error?.message||error).slice(0,240);});}
      }
    }
    function __refresh(){
      if(__disposed||__refreshing||typeof __mainClient?.codexRefresh!=='function')return;
      __refreshing=true;
      Promise.resolve().then(()=>{if(!__disposed)return __mainClient.codexRefresh();}).then(()=>{if(!__disposed)__state.refreshError=null;},error=>{if(!__disposed)__state.refreshError=String(error?.message||error).slice(0,240);}).finally(()=>{__refreshing=false;});
    }
    const __emitEvent = (name,...args) => {for(const fn of __eventBus.get(name)||[])try{fn(...args);}catch{}};
    let __themePreference = __doc.documentElement.classList?.contains('dark')||__doc.documentElement.getAttribute('data-theme')==='dark'?'dark':'light';
    const __themeAttrs = [];
    function __setAttributeOwned(node,name,value){let entry=__themeAttrs.find(item=>item.node===node&&item.name===name);if(!entry){entry={node,name,before:node.getAttribute(name),written:null};__themeAttrs.push(entry);}if(value===null)node.removeAttribute(name);else node.setAttribute(name,value);entry.written=value===null?null:String(value);}
    function __writeTheme(){
      const merged=new Map();for(const layer of __themeLayers.values())for(const [key,value]of Object.entries(layer.payload))merged.set(key,value);
      const style=__doc.documentElement.style;
      for(const key of new Set([...__themeWritten.keys(),...merged.keys()])){
        if(!__themeBefore.has(key))__themeBefore.set(key,{value:style.getPropertyValue(key),priority:style.getPropertyPriority(key)});
        const raw=merged.get(key);const value=raw&&typeof raw==='object'?raw[__themePreference]:raw;
        if(typeof value==='string'&&value.length<=2048&&!/[{};]/.test(value)&&!/url\\s*\\(/i.test(value)){style.setProperty(key,value);__themeWritten.set(key,value);}
        else if(__themeWritten.has(key)){const old=__themeBefore.get(key);if(style.getPropertyValue(key)===__themeWritten.get(key)){if(old.value)style.setProperty(key,old.value,old.priority);else style.removeProperty(key);}__themeWritten.delete(key);}
      }
    }
    const __themeService = {
      getTheme(){return{preference:__themePreference};},
      setTheme(preference){if(!['dark','light'].includes(preference))throw new Error('Unsupported theme preference');__themePreference=preference;__setAttributeOwned(__doc.documentElement,'data-theme',preference);__setAttributeOwned(__doc.body,'data-ds-dark-theme',preference==='dark'?'':null);__setAttributeOwned(__doc.documentElement,'data-ds-dark-theme',preference==='dark'?'':null);__writeTheme();__emitEvent('theme/change');},
      overrideTokens(source,payload){if(typeof source!=='string'||!payload||typeof payload!=='object')throw new Error('Invalid theme layer');const copy={};for(const[key,value]of Object.entries(payload)){if(/^--dsw-[a-z0-9-]+$/i.test(key))copy[key]=value;}const tag={payload:copy};__themeLayers.set(source,tag);__writeTheme();return()=>{if(__themeLayers.get(source)===tag){__themeLayers.delete(source);__writeTheme();}};},
    };
    const __fontComponentSelectors={markdown:'.thread-scroll-container [class*="_markdown"]',codeBlock:'.thread-scroll-container [data-markdown-copy="code-block"] code',table:'.thread-scroll-container [class*="_markdown"] table'};
    const __fontDefaults=new Map();
    function __computed(node){try{return typeof __native.getComputedStyle==='function'?__native.getComputedStyle.call(__native,node):null;}catch{return null;}}
    function __nativeFontComponents(){
      const ids=[],defaults={};
      for(const[id,selector]of Object.entries(__fontComponentSelectors)){const node=__doc.querySelector?.(selector);if(!node)continue;ids.push(id);if(!__fontDefaults.has(id)){const style=__computed(node);__fontDefaults.set(id,{size:Math.round(parseFloat(style?.fontSize)||0),weight:parseInt(style?.fontWeight,10)||0,family:style?.fontFamily||''});}defaults[id]=__fontDefaults.get(id);}
      return{ids,defaults,hookScopes:{},hasToken:(token)=>{const value=__computed(__doc.body)?.getPropertyValue?.(token);return typeof value==='string'&&value.trim()!=='';},unavailable:{terminal:'Codex 未提供终端画布字体的公开接口，此项暂不可用。'}};
    }
    function __initNativeFontTokens(){
      const markdown='.thread-scroll-container [class*="_markdown"]';
      const roles=[['markdown-base',markdown,14,400,false],['markdown-h1',markdown+' h1',21,700,false],['markdown-h2',markdown+' h2',19,700,false],['markdown-h3',markdown+' h3',18,700,false],['markdown-h4',markdown+' h4',14,600,false],['markdown-small',markdown+' small',12,400,false],['markdown-code',markdown+' :not(pre)>code',12,400,true],['markdown-code-block','.thread-scroll-container [data-markdown-copy="code-block"] code',11,400,true],['markdown-table',markdown+' td',13,400,false],['markdown-table-head',markdown+' th',13,500,false],['xs-13','aside.app-shell-left-panel',13,400,false],['xxs-12','[class*="_ComposerLayoutFooter_"]',12,400,false]];
      const put=(token,value)=>{const style=__doc.documentElement.style;if(style.getPropertyValue(token))return;__baselineTokens.set(token,{value:style.getPropertyValue(token),priority:style.getPropertyPriority(token),written:String(value)});style.setProperty(token,String(value));};
      const body=__computed(__doc.body);put('--dsw-font-family',body?.fontFamily||'system-ui, sans-serif');
      for(const[id,selector,size,weight,mono]of roles){const node=__doc.querySelector?.(selector),computed=node?__computed(node):null;const fontSize=computed?.fontSize||size+'px',fontWeight=computed?.fontWeight||String(weight),lineHeight=computed?.lineHeight||'normal',family=computed?.fontFamily||(mono?'ui-monospace, Consolas, monospace':body?.fontFamily||'system-ui, sans-serif');put('--dsw-font-'+id+'-font-size',fontSize);put('--dsw-font-'+id+'-font-weight',fontWeight);put('--dsw-font-'+id+'-line-height',lineHeight);put('--dsw-font-'+id+'-font-family',family);put('--dsw-font-'+id,fontWeight+' '+fontSize+'/'+lineHeight+' '+family);}
      for(const[role,selector]of [['primary',markdown],['secondary','aside.app-shell-left-panel'],['tertiary','[class*="_ComposerLayoutFooter_"]'],['caption','[class*="_ComposerLayoutFooter_"]'],['dimmed','aside.app-shell-left-panel [aria-disabled="true"]']]){const node=__doc.querySelector?.(selector);put('--dsw-alias-label-'+role,(node?__computed(node)?.color:null)||body?.color||(__themePreference==='dark'?'#f1f4ff':'#17202c'));}
      put('--dsw-alias-label-primary-dimmed',__doc.documentElement.style.getPropertyValue('--dsw-alias-label-dimmed'));
    }
    function __syncNativeAdapters(){
      const selection=__mainClient?.selection||{};
      if(!__adapterStyle){__adapterStyle=__createPluginElement('style');__adapterStyle.id='codex-we-native-adapter-style';__doc.head.appendChild(__adapterStyle);}
      const css=__compileGlass(selection)+String.fromCharCode(10)+__compileFonts(selection);if(__adapterStyle.textContent!==css)__adapterStyle.textContent=css;
    }
    const __localeService = {getSnapshot:()=>({active:'zh'}),register:()=>()=>{},subscribe:()=>()=>{}};
    const __ctx = {
      get(name){if(name==='locale')return __localeService;if(name==='theme')return __themeService;if(name==='shortcuts')return __shortcutService;if(name==='slots')return __ctx.slots;return null;},
      effect(fn){if(typeof fn!=='function')return()=>{};if(__effectPhase)__effects.push(fn);else{const cleanup=fn();if(typeof cleanup==='function')__disposers.push(cleanup);}return()=>{};},
      on(name,fn){if(!__eventBus.has(name))__eventBus.set(name,new Set());__eventBus.get(name).add(fn);return()=>__eventBus.get(name)?.delete(fn);},
      slots:{inject(name,fn){if(typeof fn==='function'){const off=fn();if(typeof off==='function')__disposers.push(off);}return()=>{};},register(descriptor,render){if(descriptor?.name==='settings.section'&&descriptor.id==='wallpaper-engine'&&typeof render==='function'){__settingsRender=render;__state.settingsRegistered=true;}return()=>{};}},
    };
    const __loader={load(definition){if(!definition||typeof definition.id!=='string'||typeof definition.factory!=='function')throw new Error('Invalid DSH module');if(__modules.has(definition.id))throw new Error('Duplicate DSH module '+definition.id);__modules.set(definition.id,{factory:definition.factory,value:null,loading:false});}};
    let __React, __ReactDOM;
    function __require(id){if(id==='react')return __React;if(id==='react-dom'||id==='react-dom/client')return __ReactDOM;const module=__modules.get(id);if(!module)throw new Error('Missing DSH module '+id);if(module.value)return module.value;if(module.loading)throw new Error('Circular DSH module '+id);module.loading=true;try{module.value=module.factory(__require);return module.value;}finally{module.loading=false;}}
    function __surfaces(){
      const shell='main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])';
      const right=shell+' div[class~="bg-token-main-surface-primary"][class~="border-l"]';
      const groups=[['main',shell],['sidebar','aside.app-shell-left-panel'],['header','header:is(.app-header-tint,[data-app-shell-header-edge-scroll],[class*="_Header_"])'],['thread','.thread-scroll-container'],['composer-shell','[data-codex-composer-root]'],['composer-content','[data-codex-composer-root] :is([class*="_ComposerLayoutBody_"],[class*="_ComposerLayoutInput_"],[data-composer-body])'],['composer-backdrop','[data-thread-scroll-footer] > div[class*="_background_"][class~="pointer-events-none"][class~="absolute"]'],['right-sidebar',right],['right-content',right+' :is(div,section,aside)[class~="bg-token-main-surface-primary"]']];
      const mark=(node,kind)=>{if(!__surfaceRecords.has(node))__surfaceRecords.set(node,{before:node.getAttribute('data-codex-we-surface'),written:kind});else __surfaceRecords.get(node).written=kind;node.setAttribute('data-codex-we-surface',kind);};
      for(const[kind,selector]of groups)for(const node of __doc.querySelectorAll(selector))mark(node,kind);
      const cards=[...__doc.querySelectorAll('[class*="_ComposerLayoutRoot_"]')];
      for(const node of __doc.querySelectorAll('.composer-surface-chrome'))if(!cards.some(card=>card===node||card.contains?.(node)||node.contains?.(card)))cards.push(node);
      for(const node of cards)mark(node,'composer');
      __state.surfaceCount=[...__surfaceRecords.keys()].filter(node=>node.isConnected!==false).length;
    }
    function __probe(){
      if(__disposed)return;__syncNativeAdapters();__syncPluginStyles();__surfaces();const layer=__doc.getElementById('dsh-wallpaper-engine-layer');
      __state.wallpaperPresent=!!layer&&__doc.body.hasAttribute('data-we-wallpaper');__state.transport=null;__state.fps=null;let drawable=false;
      if(layer){const frame=layer.querySelector('iframe.we-live-iframe'),video=layer.querySelector('video.we-media'),image=layer.querySelector('img.we-media'),canvas=layer.querySelector('canvas.we-media--canvas');
        if(frame){__state.transport='scene';try{const statsFn=frame.contentWindow?.__wpStats?.frame,currentFn=frame.contentWindow?.__wp?.getState;const stats=statsFn?.(),current=currentFn?.();if((typeof statsFn==='function'||typeof currentFn==='function')&&__state.error==='Scene frame is not same-origin; native proxy is not active')__state.error=null;__state.fps=Number.isFinite(stats?.fps)?stats.fps:null;drawable=stats?.running===true&&stats.fps>0;if(current?.type==='web'){__state.transport='web';drawable=current.iframeLoaded===true&&!current.webError;}}catch{__state.error='Scene frame is not same-origin; native proxy is not active';}}
        else if(video){__state.transport='video';drawable=video.readyState>=2&&video.videoWidth>0;}
        else if(image){__state.transport='image';drawable=image.complete&&image.naturalWidth>0;}
        else if(canvas){__state.transport='canvas';drawable=canvas.width>0&&canvas.height>0;}
      }
      const expected=__mainClient?.selection;const required=expected?.type==='scene'&&expected.sceneLive!==false?'scene':expected?.type==='web'?'web':null;const expectedDrawable=!required||required===__state.transport;
      __state.ready=!__state.error&&__state.phase==='mounted'&&__state.settingsRegistered&&__state.surfaceCount>0&&__state.wallpaperPresent&&drawable&&expectedDrawable&&__stylesheetApplied();
    }
    function __cleanup(){
      if(__disposed)return;__disposed=true;__state.ready=false;__state.phase='disposed';
      for(const cleanup of __disposers.reverse())try{cleanup();}catch{}
      try{__sceneBridge?.dispose();}catch{}try{__privateFetch?.dispose();}catch{}
      try{__resourceObserver?.disconnect();}catch{}for(const record of __resourceRecords.values())__resourceDrop(record);for(const record of __extraResourceRecords)__resourceDrop(record);__resourceRecords.clear();__extraResourceRecords.clear();
      try{__settingsRoot?.unmount();}catch{}
      try{__surfaceObserver?.disconnect();}catch{}
      try{__styleObserver?.disconnect();}catch{}
      for(const item of __listeners)try{item.target.removeEventListener(item.type,item.fn,item.opts);}catch{}__listeners.clear();
      for(const id of __timeouts)__native.clearTimeout(id);for(const id of __intervals)__native.clearInterval(id);for(const id of __rafs)__native.cancelAnimationFrame(id);for(const id of __idleHandles)if(typeof __native.cancelIdleCallback==='function')__native.cancelIdleCallback.call(__native,id);__timeouts.clear();__intervals.clear();__rafs.clear();__idleHandles.clear();
      for(const[node,entry]of __surfaceRecords)if(node.getAttribute('data-codex-we-surface')===entry.written){if(entry.before===null)node.removeAttribute('data-codex-we-surface');else node.setAttribute('data-codex-we-surface',entry.before);}__surfaceRecords.clear();
      __themeLayers.clear();__writeTheme();
      for(const[token,entry]of __baselineTokens)if(__doc.documentElement.style.getPropertyValue(token)===entry.written){if(entry.value)__doc.documentElement.style.setProperty(token,entry.value,entry.priority);else __doc.documentElement.style.removeProperty(token);}__baselineTokens.clear();__shortcuts.clear();
      for(const entry of __themeAttrs.reverse())if(entry.node.getAttribute(entry.name)===entry.written){if(entry.before===null)entry.node.removeAttribute(entry.name);else entry.node.setAttribute(entry.name,entry.before);}
      for(const id of ['codex-we-native-trigger','codex-we-native-settings','codex-we-native-style'])try{__doc.getElementById(id)?.remove();}catch{}
      for(const record of __pluginStyles.values())try{record.node.remove();}catch{}
      try{const sheets=__adopted();__doc.adoptedStyleSheets=sheets.filter(sheet=>!__constructedSheets.has(sheet));}catch{}
      __constructedSheets.clear();__pluginStyles.clear();
      if(__native[__key]===__state)delete __native[__key];
    }
    __state.cleanup=__cleanup;__state.summary=__summary;__state.stylesheetApplied=__stylesheetApplied;__state.configureShortcut=__configureShortcut;__native[__key]=__state;
    try {
      __setAttributeOwned(__doc.body,'data-codex-we-native','on');__setAttributeOwned(__doc.body,'data-ds-dark-theme',__themePreference==='dark'?'':null);__initNativeFontTokens();
      __privateFetch=(${createNativeDshFetch.toString()})({native:__native,apiBase:__effectiveBase,loopbackBase:__apiBase});
      ${sceneRuntimeSource?`__state.sceneDiagnostics=[];__sceneBridge=(${sceneRuntimeSource})({window:__windowProxy,document:__doc,fetch:__privateFetch,apiBase:__effectiveBase,onDiagnostic:entry=>{__state.sceneDiagnostics.push(entry);if(__state.sceneDiagnostics.length>64)__state.sceneDiagnostics.shift();}});`:''}
      ((window,globalThis,self,document,setTimeout,clearTimeout,setInterval,clearInterval,requestAnimationFrame,cancelAnimationFrame,localStorage,fetch,Image)=>{
        __overlay.__CODEX_WE_API_BASE__=__effectiveBase;__overlay.__CODEX_WE_CHUNK_UPLOAD__=true;__overlay.__CODEX_WE_FONT_COMPONENTS__=__nativeFontComponents;__overlay.__ModuleLoader__=__loader;
        __React=(()=>{var module={exports:{}};var exports=module.exports;var require=__require;\n${reactSource}\n;return module.exports;})();
        __ReactDOM=(()=>{var module={exports:{}};var exports=module.exports;var require=__require;\n${reactDOMSource}\n;return module.exports;})();
        if(!__React?.createElement||!__ReactDOM?.createRoot)throw new Error('React 18 browser modules are not available');
        ${clientBundles.map(source => `\n${source}\n;`).join('\n')}
        for(const id of ${JSON.stringify(KNOWN_CLIENTS)})if(__modules.has(id))__require(id);
        const main=__require(${JSON.stringify(DEFAULT_MAIN)});if(typeof main.apply!=='function')throw new Error('DSH main client has no apply');__mainClient=main;
        for(const id of ${JSON.stringify(KNOWN_CLIENTS)})if(__modules.has(id)){const client=__require(id);if(typeof client.apply==='function')client.apply(__ctx);}
      })(__windowProxy,__windowProxy,__windowProxy,__documentProxy,__setTimeout,__clearTimeout,__setInterval,__clearInterval,__raf,__caf,__storage,__privateFetch,__PrivateImage);
      if(!__settingsRender)throw new Error('Original DSH settings section was not registered');
      const style=__createPluginElement('style');style.id='codex-we-native-style';style.textContent=${JSON.stringify(SHELL_CSS)};__doc.head.appendChild(style);
      const trigger=__doc.createElement('button');trigger.id='codex-we-native-trigger';trigger.type='button';trigger.textContent='壁纸设置';trigger.setAttribute('aria-label','打开 Wallpaper Engine 壁纸设置');
      const dialog=__doc.createElement('dialog');dialog.id='codex-we-native-settings';dialog.setAttribute('aria-label',${JSON.stringify(title)});
      const heading=__doc.createElement('div');heading.className='codex-we-native-title';const label=__doc.createElement('strong');label.textContent=${JSON.stringify(title)};const shortcut=__doc.createElement('input');shortcut.id='codex-we-native-shortcut';shortcut.setAttribute('aria-label','壁纸快捷键，留空禁用');shortcut.placeholder='Ctrl+Alt+W';shortcut.value='Ctrl+Alt+W';const saveShortcut=__doc.createElement('button');saveShortcut.type='button';saveShortcut.textContent='保存快捷键';const close=__doc.createElement('button');close.type='button';close.textContent='关闭';heading.append(label,shortcut,saveShortcut,close);
      const panel=__doc.createElement('div');panel.id='codex-we-native-panel';dialog.append(heading,panel);__doc.body.append(trigger,dialog);
      __settingsRoot=__ReactDOM.createRoot(panel);__settingsRoot.render(__settingsRender());
      const open=()=>{if(typeof dialog.showModal==='function'){if(!dialog.open)dialog.showModal();}else{dialog.hidden=false;dialog.setAttribute('open','');}};
      const hide=()=>{if(typeof dialog.close==='function')dialog.close();else{dialog.hidden=true;dialog.removeAttribute('open');}};
      if(typeof dialog.showModal!=='function')dialog.hidden=true;
      __listen(trigger,'click',open);__listen(close,'click',hide);__state.openSettings=open;__state.closeSettings=hide;
      __listen(saveShortcut,'click',()=>{try{__configureShortcut('wallpaper.sidebar.toggle',shortcut.value);saveShortcut.textContent='已保存';}catch(error){saveShortcut.textContent='快捷键无效';saveShortcut.title=String(error?.message||error);}});__listen(__native,'keydown',__onShortcut);
      __effectPhase=false;for(const effect of __effects){const cleanup=effect();if(typeof cleanup==='function')__disposers.push(cleanup);}__effects.length=0;__updateShortcutInput();
      __surfaces();if(typeof __native.MutationObserver==='function'){__surfaceObserver=new __native.MutationObserver(()=>__surfaces());__surfaceObserver.observe(__doc.body,{subtree:true,childList:true});__styleObserver=new __native.MutationObserver(()=>__syncPluginStyles());__styleObserver.observe(__doc.head,{subtree:true,childList:true,characterData:true});}
      __scanOwnedResources();if(typeof __native.MutationObserver==='function'){__resourceObserver=new __native.MutationObserver(()=>__scanOwnedResources());__resourceObserver.observe(__doc.body,{subtree:true,childList:true,attributes:true,attributeFilter:['src','poster','style']});}
      __state.phase='mounted';__probe();__setInterval(__probe,500);__setInterval(__refresh,2000);return __summary();
    } catch(error){__state.error=String(error?.message||error).slice(0,500);__cleanup();throw error;}
  })()`;
  if (Buffer.byteLength(expression) > MAX_SCRIPT_BYTES) throw new Error('Native browser bootstrap exceeds 10 MiB');
  return expression;
}

/** Return a complete JS expression suitable for Runtime.evaluate. */
export function buildNativeClient(options) {
  const parsed = optionsOf(options);
  const effective = options.nativeApiBase === undefined ? parsed.base.url : nativeBase(options.nativeApiBase,parsed.base.token);
  return bootstrapSource(parsed,JSON.stringify(effective));
}

/**
 * Return a function-expression accepting the verified target's app://host.
 * Injector call: '(' + factory + ')(' + JSON.stringify(nativeOrigin) + ')'.
 * App custom-scheme URL.origin is "null"; callers must use protocol + '//' + host.
 */
export function buildNativeClientFactory(options) {
  const parsed = optionsOf(options);
  if (options.nativeApiBase !== undefined) throw new Error('Factory derives nativeApiBase from its verified nativeOrigin argument');
  const bootstrap = bootstrapSource(parsed,'__nativeOrigin+'+JSON.stringify(parsed.base.path));
  return `(function(__nativeOrigin){if(typeof __nativeOrigin!=='string'||!__nativeOrigin.startsWith('app://')||!(/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,126}$/).test(__nativeOrigin.slice(6))||__nativeOrigin.includes('..'))throw new Error('Invalid verified native app origin');return ${bootstrap};})`;
}
