import test from 'node:test';
import assert from 'node:assert/strict';
import {createNativePageAdapter,buildCodexPageCss} from '../plugins/gpt-wallpaper/scripts/native-pages.mjs';

// Deliberately finite structural fixtures, not a substitute for browser CSS.
const attr='data-codex-we-page-surface';
const mainQuery='main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])';
const cardQuery='[class~="@container/library-row"],[class~="@container/skills-grid"] > *,[class~="group/plugin"],[class~="group/plugin-row"],article[class~="group/site-card"],[data-appgen-row],[class~="max-w-lg"][class~="self-center"][class~="text-balance"][class~="select-none"],section:has(> h2) > [role="list"] > [role="listitem"] > div[class~="@container"][class*="_row_"]:has(> button[aria-label])';
const protectedQuery='.thread-scroll-container,[data-codex-composer-root],.monaco-editor,.cm-editor,.xterm,pre,code,canvas,iframe,[contenteditable="true"],[role="dialog"],dialog,#codex-we-native-settings';
const editorQuery='.thread-scroll-container,[data-codex-composer-root],.monaco-editor,.cm-editor,.xterm,iframe,canvas';
const menuQuery='[role="menu"],[role="listbox"],[class*="_Popover_"]';
const rowQuery='[role="menuitem"],[role="option"],[data-menu-row-content],[data-menu-section-label],[class*="_MenuList_"]';
function node(parent=null,style={}){
  const attrs=new Map(),queries=new Map(),matches=new Set();
  return {parentElement:parent,isConnected:true,hidden:false,style:{display:'block',visibility:'visible',backgroundColor:'rgba(0, 0, 0, 0)',...style},queries,matches,
    getAttribute:key=>attrs.get(key)??null,setAttribute:(key,value)=>attrs.set(key,String(value)),removeAttribute:key=>attrs.delete(key),
    querySelectorAll:selector=>queries.get(selector)||[],getClientRects(){return this.hidden?[]:[this.getBoundingClientRect()];},getBoundingClientRect:()=>({width:800,height:400}),
    closest(selector){for(let n=this;n;n=n.parentElement)if(n.matches.has(selector))return n;return null;},
    contains(child){for(let n=child;n;n=n.parentElement)if(n===this)return true;return false;},
  };
}
function fixture(){
  const main=node(),header=node(main),card=node(main),doc=node();
  doc.styleSheets=[];doc.queries.set(mainQuery,[main]);
  main.queries.set('[data-app-shell-page-header]',[header]);
  main.queries.set(cardQuery,[card]);
  const adapter=createNativePageAdapter({document:doc,native:{getComputedStyle:n=>n.style}});
  return {doc,main,header,card,adapter};
}

test('page route changes restore old markers and leave chat and editors untouched',()=>{
  const f=fixture();f.card.setAttribute(attr,'before-plugin');
  assert.deepEqual(f.adapter.scan(),{page:1,header:1,card:1});
  const chat=node(f.main);f.main.queries.set(editorQuery,[chat]);
  assert.deepEqual(f.adapter.scan(),{});
  assert.equal(f.main.getAttribute(attr),null);assert.equal(f.card.getAttribute(attr),'before-plugin');
  chat.hidden=true;
  assert.deepEqual(f.adapter.scan(),{page:1,header:1,card:1});
  const editor=node(f.main);f.main.queries.set(editorQuery,[editor]);
  assert.deepEqual(f.adapter.scan(),{});
});

test('opaque empty-state wrappers receive one card and native controls remain unmarked',()=>{
  const f=fixture();const inner=node(f.card,{backgroundColor:'rgb(24, 24, 24)'}),button=node(inner);
  button.getBoundingClientRect=()=>({width:110,height:34});button.style.backgroundColor='rgb(255, 255, 255)';
  f.main.queries.set('div,section,article,button,a',[inner,button]);
  f.adapter.scan();assert.equal(inner.getAttribute(attr),'card-clear');assert.equal(button.getAttribute(attr),null);
  assert.equal(f.card.getAttribute(attr),'card');
  f.adapter.dispose();assert.equal(inner.getAttribute(attr),null);
});

test('stylesheet header discovery supports new CSS module hashes and inaccessible sheets',()=>{
  const f=fixture();f.main.queries.delete('[data-app-shell-page-header]');
  f.doc.styleSheets=[{href:'app://-/assets/searchable-page-layout-new.css',cssRules:[{cssRules:[{selectorText:'._shell_new_2[data-sticky]::before'}]}]},{href:'app://-/other.css',get cssRules(){throw Error('inaccessible');}}];
  f.main.queries.set('[data-app-shell-page-header],._shell_new_2',[f.header]);
  f.adapter.scan();assert.equal(f.header.getAttribute(attr),'header');
  f.doc.styleSheets=[{href:'app://-/assets/searchable-page-layout-next.css',cssRules:[{selectorText:'._shell_next_2'}]}];
  const next=node(f.main);f.main.queries.set('[data-app-shell-page-header],._shell_next_2',[next]);
  f.adapter.scan();assert.equal(f.header.getAttribute(attr),null);assert.equal(next.getAttribute(attr),'header');
});

test('repeated scans retain opaque-only cards after their own glass makes them transparent',()=>{
  const f=fixture(),plain=node(f.main,{backgroundColor:'rgb(24, 24, 24)'});
  f.main.queries.set('div,section,article,button,a',[plain]);f.adapter.scan();
  assert.equal(plain.getAttribute(attr),'card');
  plain.style.backgroundColor='rgba(18, 22, 30, 0.45)';
  for(let i=0;i<4;i++){f.adapter.scan();assert.equal(plain.getAttribute(attr),'card');}
  f.main.queries.set(editorQuery,[node(f.main)]);f.adapter.scan();assert.equal(plain.getAttribute(attr),null);
});

test('portal menus use one shell and skip dialogs; cleanup respects a foreign writer',()=>{
  const f=fixture(),outer=node(),inner=node(outer),modal=node(),menuInDialog=node(modal),row=node();
  outer.matches.add(menuQuery);modal.matches.add(protectedQuery);
  for(const n of [outer,inner,menuInDialog])n.queries.set(rowQuery,[row]);
  f.doc.queries.set(menuQuery,[outer,inner,menuInDialog]);f.adapter.scan();
  assert.equal(outer.getAttribute(attr),'menu');assert.equal(inner.getAttribute(attr),'menu-clear');assert.equal(menuInDialog.getAttribute(attr),null);
  outer.setAttribute(attr,'another-plugin');f.adapter.dispose();assert.equal(outer.getAttribute(attr),'another-plugin');assert.equal(inner.getAttribute(attr),null);
});

test('native surface policies independently opt out page and menu styling',()=>{
  const css=buildCodexPageCss({glassSurfacePolicy:{content:'native',declared:'native'}});
  assert.equal(css.includes('[data-codex-we-page-surface='),false);
  const menu=buildCodexPageCss({glassSurfacePolicy:{content:'native'}});
  assert.equal(menu.includes('surface="page"'),false);assert.equal(menu.includes('surface="menu"'),true);
  const page=buildCodexPageCss({glassSurfacePolicy:{declared:'native'}});
  assert.equal(page.includes('surface="page"'),true);assert.equal(page.includes('surface="menu"'),false);
});
