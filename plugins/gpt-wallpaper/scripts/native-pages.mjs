/** Native non-chat surfaces, using structural probes and owned data markers. */
export function createNativePageAdapter({document: doc, native} = {}) {
  const attribute = 'data-codex-we-page-surface';
  const owned = new Map();
  const mainSelector = 'main:is(.main-surface,[data-app-shell-main-surface],[class*="_MainContentSurface_"])';
  const protectedSelector = '.thread-scroll-container,[data-codex-composer-root],.monaco-editor,.cm-editor,.xterm,pre,code,canvas,iframe,[contenteditable="true"],[role="dialog"],dialog,#codex-we-native-settings';
  const cards = '[class~="@container/library-row"],[class~="@container/skills-grid"] > *,[class~="group/plugin"],[class~="group/plugin-row"],article[class~="group/site-card"],[data-appgen-row],[class~="max-w-lg"][class~="self-center"][class~="text-balance"][class~="select-none"],section:has(> h2) > [role="list"] > [role="listitem"] > div[class~="@container"][class*="_row_"]:has(> button[aria-label])';
  let sheetSignature = '', searchableHeaders = [], disposed = false;
  const all = (root, selector) => {try{return [...root.querySelectorAll(selector)];}catch{return [];}};
  const computed = node => {try{return native.getComputedStyle(node);}catch{return null;}};
  const signature = node => (node.getAttribute('class') || '') + '\0' + (node.getAttribute('style') || '');
  const visible = node => {
    if(node.isConnected === false || node.hidden || node.closest?.('[hidden],[inert],[aria-hidden="true"]')) return false;
    const style = computed(node);
    if(style?.display === 'none' || style?.visibility === 'hidden') return false;
    return typeof node.getClientRects !== 'function' || node.getClientRects().length > 0;
  };
  const protectedNode = node => !!node.closest?.(protectedSelector);
  function discoverHeaders() {
    const sheets = [...doc.styleSheets || []].filter(sheet => /\/searchable-page-layout-[^/]+\.css(?:\?|$)/.test(sheet.href || ''));
    const signature = sheets.map(sheet => sheet.href).join('|');
    if(signature === sheetSignature && searchableHeaders.length) return;
    sheetSignature = signature;
    const found = new Set();
    const read = rules => {for(const rule of rules || []){
      if(typeof rule.selectorText === 'string')for(const match of rule.selectorText.matchAll(/\.(_shell_[A-Za-z0-9_]+)/g)) found.add('.' + match[1]);
      try{if(rule.cssRules) read(rule.cssRules);}catch{}
    }};
    for(const sheet of sheets)try{read(sheet.cssRules);}catch{}
    searchableHeaders = [...found];
  }
  function restore(node, entry) {
    if(node.getAttribute(attribute) !== entry.written) return;
    if(entry.before === null) node.removeAttribute(attribute); else node.setAttribute(attribute, entry.before);
  }
  function reconcile(wanted) {
    for(const [node, entry] of owned)if(!wanted.has(node)){restore(node, entry);owned.delete(node);}
    for(const [node, value] of wanted){
      let entry = owned.get(node);
      if(!entry){entry = {before:node.getAttribute(attribute),written:value,signature:signature(node)};owned.set(node,entry);}
      // A foreign writer owns its replacement until this surface is removed.
      else if(node.getAttribute(attribute) !== entry.written) continue;
      entry.written = value;
      entry.signature = signature(node);
      if(node.getAttribute(attribute) !== value) node.setAttribute(attribute,value);
    }
  }
  function scan() {
    if(disposed) return snapshot();
    discoverHeaders();
    const wanted = new Map();
    for(const main of all(doc,mainSelector)){
      if(!visible(main) || protectedNode(main)) continue;
      // Chat retains its separate composer/thread adaptation. Editor and media
      // views keep their own colours rather than receiving page-wide glass.
      if(all(main,'.thread-scroll-container,[data-codex-composer-root],.monaco-editor,.cm-editor,.xterm,iframe,canvas').some(visible)) continue;
      const headers = all(main,['[data-app-shell-page-header]',...searchableHeaders].join(',')).filter(visible);
      const hasPageContent = headers.length > 0 || all(main,cards+',h1,h2').some(visible);
      if(!hasPageContent) continue;
      wanted.set(main,'page');
      for(const header of headers)if(!protectedNode(header)) wanted.set(header,'header');
      const candidates = new Set(all(main,cards));
      const mainWidth = main.getBoundingClientRect?.().width || 0;
      const wrappers = new Set();
      for(const node of all(main,'[class~="bg-surface"][class~="flex"][class~="flex-col"]')){
        if(!visible(node) || protectedNode(node)) continue;
        const classes = new Set((node.getAttribute('class') || '').split(/\s+/));
        if(['h-full','min-h-full','flex-1'].some(name => classes.has(name))){wrappers.add(node);wanted.set(node,'card-clear');}
      }
      for(const node of all(main,'div,section,article,button,a').slice(0,3000)){
        if(!visible(node) || protectedNode(node) || wrappers.has(node) || headers.some(header => header === node || header.contains(node))) continue;
        const prior = owned.get(node);
        // Readability styling itself makes an opaque surface transparent.
        // Keep that classification while the native class/style is unchanged;
        // probing our own painted result would toggle it every other scan.
        if(prior && ['card','card-clear'].includes(prior.written) && node.getAttribute(attribute) === prior.written && prior.signature === signature(node)){candidates.add(node);continue;}
        const rect = node.getBoundingClientRect?.(), style = computed(node);
        if(!rect || !style || rect.width < 180 || rect.height < 70) continue;
        const radius = Math.max(parseFloat(style.borderTopLeftRadius)||0,parseFloat(style.borderTopRightRadius)||0);
        const bordered = ['Top','Right','Bottom','Left'].some(side => parseFloat(style['border'+side+'Width']) > 0 && !['none','hidden'].includes(style['border'+side+'Style']));
        const color = style.backgroundColor || '';
        const opaque = /^rgb\(/.test(color) || /^rgba\([^)]*,\s*(?:1|0\.9[5-9])\s*\)$/.test(color);
        if((radius >= 10 && bordered) || (opaque && (radius >= 10 || rect.width >= mainWidth * .4))) candidates.add(node);
      }
      const accepted = [...candidates].filter(node => visible(node) && !protectedNode(node) && !wrappers.has(node) && !node.closest?.('[data-testid="sites-loading-skeleton"]') && !headers.some(header => header === node || header.contains(node)));
      // Keep one painted card. Clear solid wrappers inside it to avoid the
      // compounded opacity responsible for large black empty-state panels.
      for(const node of accepted)wanted.set(node,accepted.some(parent => parent !== node && parent.contains(node)) ? 'card-clear' : 'card');
    }
    const menuSelector = '[role="menu"],[role="listbox"],[class*="_Popover_"]';
    for(const node of all(doc,menuSelector)){
      if(!visible(node) || protectedNode(node) || !all(node,'[role="menuitem"],[role="option"],[data-menu-row-content],[data-menu-section-label],[class*="_MenuList_"]').length) continue;
      // Portal and semantic roots may be nested. Paint only their outer shell.
      const parent = node.parentElement?.closest?.(menuSelector);
      if(parent && visible(parent) && !protectedNode(parent)) wanted.set(node,'menu-clear'); else wanted.set(node,'menu');
      for(const base of all(node,'[class*="_MenuList_"],[class*="_glassSurface_"]'))if(visible(base) && !protectedNode(base)) wanted.set(base,'menu-clear');
      for(const row of all(node,'[data-menu-row-content]'))if(visible(row) && !protectedNode(row)) wanted.set(row,'menu-row');
    }
    reconcile(wanted);
    return snapshot();
  }
  function snapshot(){const counts={};for(const entry of owned.values())counts[entry.written]=(counts[entry.written]||0)+1;return counts;}
  function dispose(){disposed=true;for(const [node,entry] of owned)restore(node,entry);owned.clear();}
  return {scan,dispose,snapshot};
}

/** Keep contrast local to non-chat pages; native buttons retain their colours. */
export function buildCodexPageCss(selection = {}) {
  const scope = 'body[data-codex-we-native="on"][data-we-wallpaper][data-we-glass-page]';
  const policy = selection.glassSurfacePolicy || {};
  const target = kind => `${scope}${kind === 'menu' ? '[data-we-glass-floaters]' : ''} [data-codex-we-page-surface="${kind}"]`;
  const rules = [
    `${scope}{--codex-we-page-rgb:246,248,252;--codex-we-page-text:#17202c;--codex-we-page-secondary:#394556;--codex-we-page-border:#24334928;--codex-we-page-alpha:clamp(.38,calc(var(--we-glass-alpha,.15) + .28),.68);--codex-we-card-alpha:clamp(.42,calc(var(--we-glass-alpha,.15) + .3),.72);--codex-we-menu-alpha:.92}`,
    `${scope}[data-ds-dark-theme]{--codex-we-page-rgb:18,22,30;--codex-we-page-text:#f5f7fc;--codex-we-page-secondary:#d4dbe7;--codex-we-page-border:#dbe7ff2b;--codex-we-menu-alpha:.9}`,
  ];
  const paint = (kind,alpha,blur) => {
    const filter = blur === null ? 'none' : `blur(${blur}) saturate(1.12)`;
    return `${target(kind)}{background-color:rgba(var(--codex-we-page-rgb),${alpha})!important;background-image:none!important;backdrop-filter:${filter}!important;-webkit-backdrop-filter:${filter}!important;border-color:var(--codex-we-page-border)!important}`;
  };
  if(policy.content !== 'native'){
    // A filter on the entire main element would also change the containing
    // block of native fixed overlays. Blur only individual cards and headers.
    rules.push(paint('page','var(--codex-we-page-alpha)',null));
    rules.push(`${target('page')}{--color-text:var(--codex-we-page-text);--color-text-secondary:var(--codex-we-page-secondary);--color-text-tertiary:var(--codex-we-page-secondary);color:var(--codex-we-page-text)}`);
    rules.push(`${target('page')} [class*="_MainContentTopFade_"]{background:transparent!important}`);
    rules.push(paint('card','var(--codex-we-card-alpha)','var(--we-blur,16px)'));
    rules.push(`${target('card')}{border-radius:16px;box-shadow:inset 0 0 0 1px var(--codex-we-page-border),0 8px 24px #0000000a}`);
    rules.push(`${target('card')}:is(button,a,[role="button"]):hover,${target('card')}:has(> button[aria-label]:hover){background-color:rgba(var(--codex-we-page-rgb),clamp(.42,calc(var(--codex-we-card-alpha) + .1),.82))!important}`);
    rules.push(`${target('card-clear')}{background-color:transparent!important;background-image:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important;box-shadow:none!important}`);
    rules.push(`${target('header')}::before{background-color:transparent!important;background-image:none!important}`);
    rules.push(paint('header','var(--codex-we-card-alpha)','var(--we-blur,16px)'));
  }
  if(policy.declared !== 'native'){
    rules.push(paint('menu','var(--codex-we-menu-alpha)','var(--we-blur,16px)'));
    rules.push(`${target('menu')}{--color-text:var(--codex-we-page-text);--color-text-secondary:var(--codex-we-page-secondary);--color-text-tertiary:var(--codex-we-page-secondary);color:var(--codex-we-page-text);box-shadow:0 16px 48px #00000030,inset 0 0 0 1px var(--codex-we-page-border)}`);
    rules.push(`${target('menu')} [data-codex-we-page-surface="menu-clear"]{background-color:transparent!important;background-image:none!important;backdrop-filter:none!important;-webkit-backdrop-filter:none!important}`);
    rules.push(`${target('menu')} [data-codex-we-page-surface="menu-row"]:not(:hover):not(:focus-within):not([data-highlighted]):not([data-highlighted] *):not([data-active="true"]):not([data-active="true"] *):not([aria-selected="true"]):not([aria-selected="true"] *){background-color:transparent!important;background-image:none!important}`);
  }
  return rules.join('\n');
}
