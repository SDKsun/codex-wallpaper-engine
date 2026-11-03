import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {buildCodexWallpaperCoverCss,inspectNativeWallpaperGeometry} from '../plugins/gpt-wallpaper/scripts/native-client.mjs';

test('wallpaper geometry distinguishes uncovered edges without redefining readiness',()=>{
  let rect={left:63,top:60,width:849,height:704,right:912,bottom:764};
  const document={documentElement:{clientWidth:975,clientHeight:809},getElementById:()=>({getBoundingClientRect:()=>rect})};
  assert.equal(inspectNativeWallpaperGeometry({document,native:{devicePixelRatio:1.5}}).coversViewport,false);
  rect={left:0,top:0,width:975.333,height:809.333,right:975.333,bottom:809.333};
  assert.equal(inspectNativeWallpaperGeometry({document,native:{devicePixelRatio:1.5}}).coversViewport,true);
  document.documentElement.clientWidth=0;document.documentElement.clientHeight=0;
  assert.equal(inspectNativeWallpaperGeometry({document}),null);
  assert.equal(inspectNativeWallpaperGeometry({document:{getElementById:()=>null}}),null);
});

// Optional native-CSS integration, using an existing local test runtime only.
// It creates its own hidden synthetic window/profile; it never attaches to an
// application session and never reads or changes saved wallpaper preferences.
const electron=process.env.CODEX_WALLPAPER_ELECTRON||path.join(os.homedir(),'.dsh','electron','electron.exe');
const available=await fs.access(electron).then(()=>true,()=>false);
test('real CSS keeps saved zoom/offset framing flush across resized and scaled viewports',
  {skip:!available,timeout:60000},async()=>{
    const temporary=await fs.realpath(os.tmpdir());
    const directory=await fs.mkdtemp(path.join(temporary,'codex-wallpaper-cover-'));
    const resultFile=path.join(directory,'result.json');
    const baseline=`html,body{margin:0;width:100%;height:100%;overflow:hidden}.we-layer{position:fixed;inset:0;scale:var(--we-layer-scale,none);translate:var(--we-layer-x,0px) var(--we-layer-y,0px)}body[data-we-parallax="on"] .we-layer{scale:calc(1 + var(--we-parallax-bg,0)/50)}`;
    const html=`<!doctype html><html><head><style>${baseline}</style></head><body data-codex-we-native="on" data-we-wallpaper><div id="dsh-wallpaper-engine-layer" class="we-layer"></div></body></html>`;
    const main=String.raw`
      const {app,BrowserWindow}=require('electron'),fs=require('node:fs');
      app.setPath('userData',${JSON.stringify(path.join(directory,'profile'))});
      app.whenReady().then(async()=>{
        let window;
        try{
          window=new BrowserWindow({show:false,useContentSize:true,width:975,height:809,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
          await window.loadURL(${JSON.stringify('data:text/html;charset=utf-8,'+encodeURIComponent(html))});
          const evaluate=expression=>window.webContents.executeJavaScript(expression);
          const probe=${JSON.stringify('('+inspectNativeWallpaperGeometry.toString()+')({document,native:globalThis})')};
          await evaluate("document.body.style.cssText='--we-layer-scale:.87;--we-layer-y:1%' ");
          const before=await evaluate(probe);
          await window.webContents.insertCSS(${JSON.stringify(buildCodexWallpaperCoverCss())});
          const cases=[];
          for(const size of [[975,809],[1280,720],[480,800]]){
            window.setContentSize(...size);await new Promise(resolve=>setTimeout(resolve,40));
            for(const framing of [
              {name:'saved-zoom-out',scale:'.87',x:'0%',y:'1%'},
              {name:'zoom-pan-positive',scale:'1.2',x:'25%',y:'25%'},
              {name:'zoom-pan-negative',scale:'1.2',x:'-25%',y:'-25%'},
              {name:'zoom-pan-interior',scale:'1.4',x:'-8%',y:'10%'},
              {name:'unzoomed-pan',scale:'1',x:'25%',y:'-25%'},
              {name:'default'},
              {name:'parallax-edge',scale:'.87',x:'0%',y:'1%',parallax:true},
            ]){
              const expression='('+((framing,probe)=>{
                const body=document.body,layer=document.getElementById('dsh-wallpaper-engine-layer');
                body.removeAttribute('style');layer.removeAttribute('style');
                body.toggleAttribute('data-we-parallax',!!framing.parallax);
                if(framing.parallax){body.setAttribute('data-we-parallax','on');body.style.setProperty('--we-parallax-bg','5');layer.style.translate='5% -5%';}
                for(const [key,value]of [['--we-layer-scale',framing.scale],['--we-layer-x',framing.x],['--we-layer-y',framing.y]])if(value!==undefined)body.style.setProperty(key,value);
                const saved=body.getAttribute('style'),geometry=eval(probe),computed=getComputedStyle(layer);
                return {geometry,scale:computed.scale,translate:computed.translate,configUnchanged:saved===body.getAttribute('style'),dpr:devicePixelRatio};
              }).toString()+')('+JSON.stringify(framing)+','+JSON.stringify(probe)+')';
              cases.push({size,name:framing.name,...await evaluate(expression)});
            }
          }
          fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({before,cases}));
          window.destroy();app.quit();
        }catch(error){fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({error:error.stack}));window?.destroy();app.exit(1);}
      });`;
    const mainFile=path.join(directory,'main.cjs');await fs.writeFile(mainFile,main);
    try{
      for(const factor of [1,1.5]){
        const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.NODE_OPTIONS;
        await promisify(execFile)(electron,['--force-device-scale-factor='+factor,mainFile],{env,windowsHide:true,timeout:25000,maxBuffer:65536});
        const result=JSON.parse(await fs.readFile(resultFile,'utf8'));
        assert.equal(result.error,undefined);assert.equal(result.before.coversViewport,false,'fixture must reproduce the original uncovered frame');
        for(const entry of result.cases){
          assert.equal(entry.geometry.coversViewport,true,JSON.stringify({factor,...entry}));
          assert.equal(entry.configUnchanged,true);
          const {layer,viewport}=entry.geometry;
          const near=(actual,expected)=>assert.ok(Math.abs(actual-expected)<1.5,JSON.stringify({factor,name:entry.name,actual,expected}));
          if(entry.name==='saved-zoom-out'||entry.name==='unzoomed-pan'){near(layer.left,0);near(layer.top,0);near(layer.width,viewport.width);near(layer.height,viewport.height);}
          if(entry.name==='zoom-pan-positive'){near(layer.width,viewport.width*1.2);near(layer.left,0);near(layer.top,0);}
          if(entry.name==='zoom-pan-negative'){near(layer.width,viewport.width*1.2);near(layer.left,-viewport.width*.2);near(layer.top,-viewport.height*.2);}
          if(entry.name==='zoom-pan-interior'){near(layer.width,viewport.width*1.4);near(layer.left,-viewport.width*.28);near(layer.top,-viewport.height*.1);}
          if(entry.name==='default')assert.equal(entry.scale,'none','default media must retain its untransformed path');
          if(entry.name==='parallax-edge')assert.equal(entry.scale,'1.1','upstream motion overscan must remain in charge');
        }
      }
    }finally{
      const resolved=path.resolve(directory),relative=path.relative(temporary,resolved);
      if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Refusing unexpected fixture cleanup path');
      await fs.rm(resolved,{recursive:true,force:true});
    }
  });
