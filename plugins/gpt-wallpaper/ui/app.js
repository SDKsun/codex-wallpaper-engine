const key = new URLSearchParams(location.search).get('key');
const $ = id => document.getElementById(id);
const mediaUrl = id => `/media?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`;
let items = [], selected = null, filter = 'all', pending = false;
const message = text => { $('message').textContent = text; };
window.addEventListener('message',event=>{
  const frame = $('preview').querySelector('iframe');
  if(!frame || event.source !== frame.contentWindow || event.origin !== location.origin) return;
  if(event.data?.type === 'gpt-wallpaper:ready') { $('preview').dataset.sceneStatus = 'ready';message('场景已进入实时预览，可以在画面上移动鼠标测试互动。'); }
  if(event.data?.type === 'gpt-wallpaper:error') { $('preview').dataset.sceneStatus = 'error';message(`场景渲染失败：${String(event.data.message).slice(0,240)}`); }
  if(event.data?.type === 'gpt-wallpaper:metrics') {
    $('preview').dataset.sceneFps = String(event.data.fps);$('preview').dataset.sceneRunning = String(event.data.running);$('preview').dataset.pointerUpdates = String(event.data.pointerUpdates);
  }
});
async function api(input) {
  const res = await fetch(`/api?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)});
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || '操作失败');
  return data;
}
async function perform(button, action) {
  if (pending) return;
  pending = true; button.setAttribute('aria-busy','true');
  try { await action(); } catch(error) { message(error.message); }
  finally { pending = false; button.removeAttribute('aria-busy'); }
}
function media(item, moving = false) {
  if(item.type === 'scene' && moving) {
    const frame = document.createElement('iframe');frame.src = item.sceneUrl;frame.title = `${item.name} · 实时场景`;
    frame.setAttribute('sandbox','allow-scripts allow-same-origin');return frame;
  }
  const el = document.createElement(item.type === 'video' ? 'video':'img');
  el.src = mediaUrl(item.id);
  if (item.type === 'video') { el.muted = true; el.loop = true; el.playsInline = true; el.preload = 'metadata'; el.autoplay = moving && !matchMedia('(prefers-reduced-motion: reduce)').matches; }
  else { el.alt = item.name; el.loading = 'lazy'; }
  return el;
}
function clearMedia(container) {
  for (const video of container.querySelectorAll('video')) { video.pause(); video.removeAttribute('src'); video.load(); }
  container.replaceChildren();
}
function render() {
  clearMedia($('grid'));
  const shown = items.filter(i=>(filter === 'all' || i.type === filter) && i.name.toLocaleLowerCase().includes($('search').value.toLocaleLowerCase()));
  $('count').textContent = `${shown.length} / ${items.length}`;
  if (!shown.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = '没有匹配的壁纸。换个文件夹或搜索词试试。'; $('grid').append(p); }
  for (const item of shown) {
    const card = document.createElement('button'); card.className = 'card'; card.setAttribute('aria-pressed',String(selected?.id === item.id));
    const title = document.createElement('span'); title.textContent = item.name;
    const badge = document.createElement('em'); badge.textContent = item.type === 'scene'?'互动场景':item.type === 'video'?'视频':'图片';
    card.append(media(item),title,badge);
    card.onclick = () => {
      selected = item; $('name').textContent = item.name; $('apply').disabled = false;
      clearMedia($('preview')); clearMedia($('backdrop'));
      $('preview').append(media(item,true)); $('backdrop').append(media(item,item.type !== 'scene')); render();
    };
    $('grid').append(card);
  }
}
$('load').onclick = () => perform($('load'),async()=>{
  const data = await api({action:'scan',folder:$('folder').value.trim()});
  items = data.items; selected = null; $('folder').value = data.folder; $('apply').disabled = true;
  clearMedia($('preview')); clearMedia($('backdrop')); $('name').textContent = '画面预览'; render();
  message(`已加载 ${items.length} 个文件，选择一张壁纸预览。`);
});
$('folder').onkeydown = e => { if(e.key === 'Enter') $('load').click(); };
$('steam').onclick = () => perform($('steam'),async()=>{
  const data = await api({action:'steam'});items = data.items;selected = null;$('apply').disabled = true;
  clearMedia($('preview'));clearMedia($('backdrop'));$('name').textContent = '画面预览';render();
  message(`已连接 Wallpaper Engine：${items.filter(i=>i.type === 'scene').length} 个场景、${items.filter(i=>i.type === 'video').length} 个视频。选择后可预览，点击应用切换聊天背景。`);
});
$('clearScene').onclick = () => perform($('clearScene'),async()=>message((await api({action:'clear_scene'})).message));
$('search').oninput = render;
document.querySelectorAll('[data-filter]').forEach(button=>button.onclick=()=>{
  filter = button.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b=>b.setAttribute('aria-pressed',String(b === button))); render();
});
$('apply').onclick=()=>perform($('apply'),async()=>{
  const result = await api({action:'apply',id:selected?.id}); message(result.message); $('rotation').textContent = '轮播已停止；当前配置为所选壁纸';
});
$('reveal').oninput=()=>{ $('value').textContent = `${$('reveal').value}%`; $('backdrop').style.opacity = $('reveal').value / 100; };
$('saveReveal').onclick=()=>perform($('saveReveal'),async()=>message((await api({action:'set_reveal',percent:Number($('reveal').value)})).message));
for (const action of ['pause','resume']) $(action).onclick=()=>perform($(action),async()=>{
  const result = await api({action});
  for (const el of document.querySelectorAll('#preview video,#backdrop video')) { if(action === 'pause') el.pause(); else el.play().catch(()=>{}); }
  for (const frame of document.querySelectorAll('#preview iframe')) frame.contentWindow.postMessage({type:'gpt-wallpaper:pause',paused:action === 'pause'},location.origin);
  if(action === 'pause') $('rotation').textContent = '轮播已停止';
  message(result.message);
});
$('rotate').onclick=()=>perform($('rotate'),async()=>{
  const r = await api({action:'rotation_start',seconds:Number($('seconds').value)});
  $('rotation').textContent = `${r.count} 个文件，每 ${r.seconds} 秒切换`; message(r.message);
});
$('stop').onclick=()=>perform($('stop'),async()=>{ await api({action:'rotation_stop'}); $('rotation').textContent = '轮播已停止，保留当前壁纸'; });
$('manager').onclick=()=>perform($('manager'),async()=>message((await api({action:'open_manager'})).message));
document.addEventListener('visibilitychange',()=>{
  for (const el of document.querySelectorAll('#preview video,#backdrop video')) {
    if (document.hidden) { el.dataset.wasPlaying = String(!el.paused); el.pause(); }
    else if(el.dataset.wasPlaying === 'true') el.play().catch(()=>{});
  }
});
api({action:'status'}).then(s=>{ $('reveal').value = Math.round(s.reveal * 100); $('value').textContent = `${$('reveal').value}%`; message(s.activeTheme ? `当前配置：${s.activeTheme}。聊天背景是否显示，请在真实界面确认。` : '尚未配置壁纸。加载本地文件夹，选择画面开始。'); }).catch(e=>message(e.message)).finally(()=>$('steam').click());
