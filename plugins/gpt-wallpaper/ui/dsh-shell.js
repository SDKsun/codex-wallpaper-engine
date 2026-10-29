const key = new URLSearchParams(location.search).get('key');
const notice = document.getElementById('shell-notice');
const mount = ReactDOM.createRoot(document.getElementById('react-settings'));
const modules = new Map([['react',React],['react-dom',ReactDOM]]);
const sections = new Map(), disposers = [], listeners = new Set();
let selectedTheme = 'dark';
const locale = {getSnapshot:()=> 'zh',subscribe:cb=>{listeners.add(cb);return ()=>listeners.delete(cb);},register:()=>()=>{}};
const theme = {
  getSnapshot:()=>({preference:selectedTheme,resolved:selectedTheme,mode:selectedTheme}),
  subscribe:cb=>{listeners.add(cb);return ()=>listeners.delete(cb);},
  setPreference:value=>{selectedTheme=value === 'light'?'light':'dark';document.body.dataset.theme=selectedTheme;for(const cb of listeners)cb();},
  registerTokens:()=>()=>{},registerLayer:()=>()=>{},
};
class Boundary extends React.Component {
  constructor(props){super(props);this.state={error:null};}
  static getDerivedStateFromError(error){return {error};}
  componentDidCatch(error){notice.textContent=`壁纸设置暂时无法显示：${String(error?.message || error).slice(0,160)}`;}
  render(){return this.state.error ? React.createElement('div',{className:'codex-wallpaper-failure'},'壁纸设置未能加载。可以先使用基础壁纸库；已保存的配置会保留。') : this.props.children;}
}
function renderSections(){
  mount.render(React.createElement(Boundary,null,React.createElement(React.Fragment,null,...[...sections.values()].map(({descriptor,renderer})=>React.createElement(React.Fragment,{key:descriptor.id},renderer())))));
}
const ctx = {
  get:name=>name === 'locale'?locale:name === 'theme'?theme:null,
  effect:fn=>{const off=fn();if(typeof off==='function')disposers.push(off);return off;},
  slots:{
    inject:(_name,fn)=>fn(),
    register:(descriptor,renderer)=>{sections.set(descriptor.id,{descriptor,renderer});queueMicrotask(renderSections);return ()=>{sections.delete(descriptor.id);renderSections();};},
  },
};
window.__ModuleLoader__={load({id,factory}){
  if(modules.has(id))throw new Error('重复的壁纸模块');
  const exports=factory(name=>{if(!modules.has(name))throw new Error(`壁纸模块尚未加载：${name}`);return modules.get(name);});
  modules.set(id,exports);
}};
function script(url){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=url;el.onload=resolve;el.onerror=()=>reject(new Error('壁纸模块文件加载失败'));document.head.append(el);});}
async function api(action){const res=await fetch(`/api?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action})});const data=await res.json();if(!res.ok)throw new Error(data.error || '操作失败');return data;}
document.getElementById('enable-engine').onclick=()=>api('open_manager').then(r=>notice.textContent=r.message).catch(e=>notice.textContent=e.message);
try {
  const res=await fetch(`/dsh-bootstrap?key=${encodeURIComponent(key)}`);const info=await res.json();
  if(!res.ok)throw new Error(info.error || '壁纸服务尚未就绪');
  window.__CODEX_WE_API_BASE__=info.base;
  for(const url of info.clientBundles)await script(url);
  for(const [id,exports] of modules){if(id.startsWith('dsh-plugin-wallpaper-engine')&&typeof exports.apply==='function')exports.apply(ctx);}
  if(!sections.size)throw new Error('壁纸设置未注册');
  renderSections();
  const status=await api('status');
  notice.textContent=status.engine?.message || '已连接 Wallpaper Engine。聊天背景状态请在实际窗口确认。';
}catch(error){notice.textContent=String(error?.message || error);}
window.addEventListener('pagehide',()=>{for(const dispose of disposers.reverse()){try{dispose();}catch{}}mount.unmount();});
