// Build-time adapter for fixed, pinned WebWallGL code. It never compiles project
// text, inserts child script tags, changes CSP, or patches native app globals.
export function buildNativeSceneRuntime({engineSource,rendererSource,occlusionSource=''}={}) {
  if(typeof engineSource!=='string'||!engineSource.includes('WebWallGL'))throw new Error('Expected trusted WebWallGL source');
  if(typeof rendererSource!=='string'||!rendererSource.includes('window.__wp'))throw new Error('Expected trusted DSH renderer source');
  if(typeof occlusionSource!=='string')throw new Error('Expected trusted occlusion source');
  // The original ES module uses import.meta.url only for its static fallback.
  // Its fixed scene-only fallback is replaced below; no project source is added.
  const renderer=rendererSource.replaceAll('import.meta.url','__rendererUrl')
    // Diagnostic pixels also need the private transport; app:// GET cannot be
    // assumed interceptable. Failure shows an honest local label, not another
    // unavailable navigation to the original decorative fallback document.
    .replace(/new Image\(\)\.src = ([^;\n]+);/g,'void fetch($1).catch(() => {});')
    .replace(/function showFallback\(\) \{[\s\S]*?\n\}\n\ninst\.on/,`function showFallback() {
      if (fallbackFrame) return;
      try { inst.release(); } catch {}
      const f = document.createElement('div');
      f.className = 'we-fallback'; f.textContent = '壁纸场景渲染失败';
      host.appendChild(f); fallbackFrame = f;
    }

inst.on`);
  return `(function createNativeSceneBridge(options){
    'use strict';
    const parent=options.window,doc=options.document,transport=options.fetch;
    if(!parent||!doc||typeof transport!=='function')throw new Error('Native scene bridge dependencies missing');
    const parentUrl=new URL(parent.location.href),base=new URL(options.apiBase,parentUrl.href);
    if(!/^\\/dsh\\/[a-f0-9]{64}\\/wallpaper-engine$/.test(base.pathname)||base.search||base.hash||base.username||base.password||
       base.protocol!==parentUrl.protocol||base.host!==parentUrl.host||
       !(base.protocol==='app:'&&/^[a-z0-9.-]+$/i.test(base.host)||base.protocol==='http:'&&base.hostname==='127.0.0.1'))throw new Error('Invalid native scene API base');
    const frames=new Map();let stopped=false;let serial=0;
    const emit=(phase,detail)=>{try{options.onDiagnostic?.({phase,...detail});}catch{}};
    const parse=value=>{
      try{const u=new URL(String(value),parent.location.href);
        return u.protocol===base.protocol&&u.host===base.host&&!u.username&&!u.password&&
          u.pathname===base.pathname+'/scene-live/index.html'&&u.searchParams.get('type')==='scene'?u:null;
      }catch{return null;}
    };
    function stopRun(record){
      const run=record.run;record.run=null;if(!run)return;
      run.cancelled=true;try{run.dispose?.();}catch(error){emit('cleanup-error',{message:String(error?.message||error)});}
    }
    function bootstrap(child,nativeDocument,url,run){
      const timers=new Set(),intervals=new Set(),rafIds=new Set(),listeners=[],observers=new Set(),controllers=new Set(),blobUrls=new Set();
      const SceneURL=class extends URL{static createObjectURL(blob){const value=child.URL.createObjectURL(blob);blobUrls.add(value);return value;}static revokeObjectURL(value){blobUrls.delete(value);child.URL.revokeObjectURL(value);}};
      const owned=new Map();let engineDispose=null;let cleaned=false;
      // This proxy is passed only to the fixed trusted engine/renderer, never to
      // wallpaper project scripts. Track every global write, including optional
      // diagnostics, and retain the first descriptor across repeated writes.
      const remember=(target,key,value)=>{
        let entry=owned.get(key);
        if(!entry){entry={target,before:Object.getOwnPropertyDescriptor(target,key),written:undefined};owned.set(key,entry);}
        const success=Reflect.set(target,key,value,target);
        if(success)entry.written=Reflect.get(target,key,target);
        return success;
      };
      const listen=(target,type,fn,opts)=>{target.addEventListener(type,fn,opts);listeners.push([target,type,fn,opts]);};
      const remove=(target,type,fn,opts)=>{target.removeEventListener(type,fn,opts);};
      const later=(fn,ms,...args)=>{let id;id=child.setTimeout(()=>{timers.delete(id);if(!run.cancelled)fn(...args);},ms);timers.add(id);return id;};
      const every=(fn,ms,...args)=>{const id=child.setInterval(()=>{if(!run.cancelled)fn(...args);},ms);intervals.add(id);return id;};
      const raf=fn=>{let id;id=child.requestAnimationFrame(t=>{rafIds.delete(id);if(!run.cancelled)fn(t);});rafIds.add(id);return id;};
      const observe=Constructor=>Constructor?class extends Constructor{constructor(...args){super(...args);observers.add(this);}}:undefined;
      const trackedMutation=observe(child.MutationObserver),trackedResize=observe(child.ResizeObserver);
      const virtualLocation=Object.freeze({href:url.href,search:url.search,hash:url.hash,pathname:url.pathname,protocol:url.protocol,host:url.host,hostname:url.hostname,port:url.port,origin:url.protocol+'//'+url.host,toString(){return url.href;}});
      const scopedFetch=async(input,init={})=>{
        if(run.cancelled)throw new DOMException('Scene released','AbortError');
        const address=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,url.href);
        const assetRoot=base.pathname.replace(/\\/wallpaper-engine$/,'')+'/api/local-assets';
        const ownedBlob=address.protocol==='blob:'&&blobUrls.has(address.href);
        if(!ownedBlob&&(address.protocol!==base.protocol||address.host!==base.host||address.username||address.password||
          !(address.pathname.startsWith(base.pathname+'/')||address.pathname===assetRoot||address.pathname.startsWith(assetRoot+'/'))))throw new Error('Scene request outside authenticated resources');
        const controller=new AbortController();controllers.add(controller);
        const abort=()=>controller.abort();init.signal?.addEventListener('abort',abort,{once:true});if(init.signal?.aborted)controller.abort();
        try{return await (ownedBlob?child.fetch.bind(child):transport)(address.href,{...init,signal:controller.signal});}
        finally{controllers.delete(controller);init.signal?.removeEventListener('abort',abort);}
      };
      const windowProxy=new Proxy(child,{get(target,key){
        if(key==='window'||key==='self'||key==='globalThis')return windowProxy;
        if(key==='document')return documentProxy;if(key==='location')return virtualLocation;
        if(key==='fetch')return scopedFetch;if(key==='addEventListener')return(type,fn,opts)=>listen(child,type,fn,opts);
        if(key==='removeEventListener')return(type,fn,opts)=>remove(child,type,fn,opts);
        if(key==='setTimeout')return later;if(key==='clearTimeout')return id=>{timers.delete(id);child.clearTimeout(id);};
        if(key==='setInterval')return every;if(key==='clearInterval')return id=>{intervals.delete(id);child.clearInterval(id);};
        if(key==='requestAnimationFrame')return raf;if(key==='cancelAnimationFrame')return id=>{rafIds.delete(id);child.cancelAnimationFrame(id);};
        if(key==='MutationObserver')return trackedMutation;if(key==='ResizeObserver')return trackedResize;
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      },set(target,key,value){return remember(target,key,value);}});
      const documentProxy=new Proxy(nativeDocument,{get(target,key){
        if(key==='addEventListener')return(type,fn,opts)=>listen(target,type,fn,opts);
        if(key==='removeEventListener')return(type,fn,opts)=>remove(target,type,fn,opts);
        if(key==='defaultView')return windowProxy;
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
      const sheet=new child.CSSStyleSheet();sheet.replaceSync('html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:#000}#wp{position:fixed;inset:0;overflow:hidden}');
      const oldSheets=nativeDocument.adoptedStyleSheets;nativeDocument.adoptedStyleSheets=[...oldSheets,sheet];
      const host=nativeDocument.createElement('div');host.id='wp';nativeDocument.body.appendChild(host);
      const dispose=()=>{if(cleaned)return;cleaned=true;run.cancelled=true;
        try{engineDispose?.();}catch{}
        for(const c of controllers)c.abort();controllers.clear();
        for(const id of timers)child.clearTimeout(id);for(const id of intervals)child.clearInterval(id);for(const id of rafIds)child.cancelAnimationFrame(id);
        timers.clear();intervals.clear();rafIds.clear();
        for(const [target,type,fn,opts]of listeners)try{target.removeEventListener(type,fn,opts);}catch{}
        for(const observer of observers)try{observer.disconnect();}catch{}
        for(const url of blobUrls)try{child.URL.revokeObjectURL(url);}catch{}blobUrls.clear();
        try{nativeDocument.adoptedStyleSheets=nativeDocument.adoptedStyleSheets.filter(s=>s!==sheet);}catch{}
        host.remove();
        for(const [key,entry]of owned)if(entry.target[key]===entry.written){try{if(entry.before)Object.defineProperty(entry.target,key,entry.before);else delete entry.target[key];}catch{}}
        owned.clear();
      };run.dispose=dispose;
      try{
        engineDispose=(function(window,globalThis,self,document,location,fetch,__rendererUrl){
          const module=undefined,exports=undefined,define=undefined;
          const Image=window.Image,ImageData=window.ImageData,ImageBitmap=window.ImageBitmap,ImageDecoder=window.ImageDecoder;
          const URL=SceneURL,FontFace=window.FontFace;
          const HTMLCanvasElement=child.HTMLCanvasElement,HTMLVideoElement=child.HTMLVideoElement,HTMLMediaElement=child.HTMLMediaElement;
          const HTMLElement=child.HTMLElement,Element=child.Element,Node=child.Node;
          const MutationObserver=window.MutationObserver,ResizeObserver=window.ResizeObserver;
          const AudioContext=window.AudioContext,webkitAudioContext=window.webkitAudioContext,OffscreenCanvas=window.OffscreenCanvas;
          const VideoFrame=window.VideoFrame,VideoDecoder=window.VideoDecoder,AudioDecoder=window.AudioDecoder,AudioData=window.AudioData;
          const EncodedVideoChunk=window.EncodedVideoChunk,EncodedAudioChunk=window.EncodedAudioChunk;
          const navigator=window.navigator,performance=window.performance,screen=window.screen,crypto=window.crypto;
          const requestAnimationFrame=window.requestAnimationFrame,cancelAnimationFrame=window.cancelAnimationFrame;
          const setTimeout=window.setTimeout,clearTimeout=window.clearTimeout,setInterval=window.setInterval,clearInterval=window.clearInterval;
          const createImageBitmap=window.createImageBitmap;
          ${engineSource}
          ${occlusionSource}
          ${renderer}
          // Actual instance destruction, rather than a painted readiness stand-in.
          return()=>inst.destroy();
        })(windowProxy,windowProxy,windowProxy,documentProxy,virtualLocation,scopedFetch,url.href);
        run.ready=true;emit('mounted',{id:run.id,url:url.href});
      }catch(error){dispose();throw error;}
    }
    function wrap(frame){
      if(stopped||frames.has(frame))return frame;
      let proto=frame,descriptor;
      while(proto&&!descriptor){descriptor=Object.getOwnPropertyDescriptor(proto,'src');proto=Object.getPrototypeOf(proto);}
      if(!descriptor?.get||!descriptor?.set)throw new Error('Expected native iframe src descriptor');
      const before=Object.getOwnPropertyDescriptor(frame,'src');
      const record={frame,run:null,desired:null,everConnected:frame.isConnected===true};
      const set=function(value){
        const url=parse(value);stopRun(record);record.desired=null;
        if(!url||stopped){descriptor.set.call(frame,value);return;}
        const payload=url.searchParams.get('src'),media=url.searchParams.get('mediaBase');
        if(!payload||payload.length>8192||media!==base.href+'/scene-files')throw new Error('Invalid native scene source');
        record.desired=url.href;
        const run={id:++serial,ready:false,cancelled:false,dispose:null,url:url.href};record.run=run;
        descriptor.set.call(frame,'about:blank');
      };
      Object.defineProperty(frame,'src',{configurable:true,enumerable:descriptor.enumerable,get(){return record.desired??descriptor.get.call(frame);},set});
      const load=()=>{const run=record.run;if(stopped||!run||run.cancelled||run.ready)return;
        try{const child=frame.contentWindow,childDoc=frame.contentDocument;
          if(!child||!childDoc?.body||child.location.href!=='about:blank')throw new Error('Owned scene frame is not same-origin about:blank');
          record.everConnected=frame.isConnected===true;bootstrap(child,childDoc,new URL(run.url),run);
        }catch(error){stopRun(record);emit('error',{id:run.id,message:String(error?.message||error)});}
      };
      frame.addEventListener('load',load);
      record.cleanup=()=>{stopRun(record);frame.removeEventListener('load',load);const current=Object.getOwnPropertyDescriptor(frame,'src');if(current?.set===set){if(before)Object.defineProperty(frame,'src',before);else delete frame.src;}};
      frames.set(frame,record);return frame;
    }
    const observer=new parent.MutationObserver(()=>{for(const [frame,record]of frames){if(frame.isConnected)record.everConnected=true;else if(record.everConnected){record.cleanup();frames.delete(frame);}}});
    observer.observe(doc,{childList:true,subtree:true});
    return{wrap,owns:value=>!!parse(value),snapshot:()=>({frames:frames.size,ready:[...frames.values()].filter(r=>r.run?.ready).length,transport:'fixed-scene-bridge'}),
      dispose(){if(stopped)return;stopped=true;observer.disconnect();for(const r of frames.values())r.cleanup();frames.clear();}};
  })`;
}
