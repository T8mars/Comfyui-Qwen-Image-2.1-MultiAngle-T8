import { StudioScene, defaultScene } from './scene.mjs?v=20261029v180';
import { activeActor, createActor, bindActor, editableActors } from './actors.mjs?v=20261010lan1';
import { applyCatalogTransaction, filterCatalog, finishCatalogPose } from './pose-catalog.mjs?v=20261020stable1';
import { installPoseGallery, galleryImage } from './pose-gallery-ui.mjs?v=20261029v180';

const clone = value => structuredClone(value);
const $ = id => document.getElementById(id);
const API = '/anyangle-studio/pose-library';
async function readResult(response) {
  const result=await response.json().catch(()=>null);
  if(!response.ok)throw new Error(result?.error || `姿势库请求失败（HTTP ${response.status}）${response.status===413?'：请减少文件或预览图大小':''}`);
  if(!result || typeof result!=='object')throw new Error('姿势库服务返回无效数据，请刷新后重试');
  return result;
}
async function api(path = '', data, method = 'POST') {
  const response = await fetch(API + path, data === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return readResult(response);
}
function control(label, action, className = '') {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = label; button.className = className; button.onclick = action; return button;
}

export function installPoseLibrary(context) {
  let catalog = { revision: 0, items: [], catalog: [] }, selected = null, page = 0, pending = null;
  let preview = null, previewToken = 0, previewWork = Promise.resolve(), disposed = false, importToken = 0, writing = false, composing = false, filtersRestored = false;
  const batchIds = new Set();
  const dialog = document.createElement('dialog'); dialog.id = 'pose-library-dialog'; dialog.className = 'pose-library-dialog';
  dialog.innerHTML = `<div class="pl-header"><div><span class="pl-eyebrow">POSE LIBRARY</span><h2>姿势库 <small id="pl-total"></small></h2></div><button id="pl-close" aria-label="关闭姿势库">关闭</button></div>
    <div class="pl-toolbar"><input id="pl-search" type="search" placeholder="搜索中文名、原名或标签" aria-label="搜索姿势"><select id="pl-category" aria-label="动作分类"><option value="">全部动作</option></select><select id="pl-tab" aria-label="姿势范围"><option value="all">全部</option><option value="imported">已导入</option><option value="favorites">收藏</option></select><select id="pl-source" aria-label="姿势来源"><option value="">全部来源</option></select></div>
    <div class="pl-management"><button id="pl-files">导入文件 / ZIP</button><button id="pl-directory">导入姿势目录</button><button id="pl-export">导出姿势包</button><button id="pl-save">保存当前动作</button><button id="pl-save-composition">保存所选多人编排</button><button id="pl-migrate" hidden>迁移旧姿势</button><button id="pl-reload">刷新本地列表</button><button id="pl-show-hidden">恢复已隐藏内置项</button></div>
    <details class="pl-sources"><summary>添加外部姿势库 · 手动读取，本地保存</summary><p class="hint">包含精选与四个社区库。读取动作数据，不安装其他插件。第三方来源与许可保留在详情中；未声明许可的内容不会随本节点再分发。</p><label><input id="pl-latest" type="checkbox">读取来源最新版本（默认固定已调查版本）</label><div id="pl-sources"></div><p id="pl-source-status" role="status"></p></details>
    <div id="pl-import" class="pl-import" hidden><h3>导入检查</h3><p id="pl-import-summary"></p><div id="pl-import-rows"></div><div class="compact-actions"><button id="pl-import-all">全选有效项</button><button id="pl-import-none">全不选</button><button id="pl-import-commit" class="primary">将所选姿势保存到库</button><button id="pl-import-cancel">取消导入</button></div></div>
    <p id="pl-status" role="status" class="hint"></p>
    <div class="pl-content"><section class="pl-list"><div id="pl-grid" class="pl-grid"></div><div class="pl-pagination"><button id="pl-prev">上一页</button><span id="pl-page"></span><button id="pl-next">下一页</button></div></section>
    <aside class="pl-detail"><div id="pl-preview-stage" class="pl-preview-stage"><canvas id="pl-preview" aria-label="隔离姿势三维预览"></canvas><p id="pl-preview-hint">选择姿势查看三维预览</p></div><h3 id="pl-name">选择一个姿势</h3><p id="pl-description" class="hint"></p><p id="pl-target" class="pl-target"></p>
    <label>应用人物<select id="pl-scope"><option value="current">当前人物</option><option value="selected">所选未锁定人物</option><option value="all">全部可编辑人物</option></select></label>
    <label>动作范围<select id="pl-part"><option value="full">完整动作</option><option value="body">身体 · 保留手势</option><option value="arms">双臂</option><option value="legs">双腿</option><option value="hands">手腕与手指</option></select></label>
    <label class="option-toggle"><input id="pl-preserve-hands" type="checkbox"><span>保留当前手势</span></label><label class="option-toggle"><input id="pl-ground" type="checkbox"><span>应用后贴地</span></label><label id="pl-contact-row" class="option-toggle" hidden><input id="pl-release" type="checkbox"><span id="pl-contact-text"></span></label>
    <button id="pl-apply" class="primary" disabled>应用到人物</button><button id="pl-fit" class="wide-button">适合当前画幅</button><p class="hint">只改动作，身份、体型与机位保留。切换动作不保证自动对齐接触点，可继续手动微调。</p>
    <div class="pl-entry-actions"><button id="pl-favorite">收藏</button><button id="pl-rename">重命名</button><button id="pl-delete">删除 / 隐藏</button><button id="pl-batch">加入姿势批量</button><button id="pl-export-one">导出此姿势</button></div><details><summary>来源与兼容详情</summary><pre id="pl-provenance"></pre></details></aside></div>`;
  document.body.append(dialog);
  const boneDetail=dialog.querySelector('.pl-detail');
  const gallery=installPoseGallery(context,{dialog,refresh:()=>render(),filterChanged:()=>{page=0;render();},composing:value=>{composing=value;},catalogChanged:()=>execute(async()=>{await reload();render();})});
  const files = document.createElement('input'); files.type = 'file'; files.multiple = true; files.accept = '.json,.zip,.webp,.png,.jpg,.jpeg'; files.hidden = true;
  const directory = document.createElement('input'); directory.type = 'file'; directory.multiple = true; directory.webkitdirectory = true; directory.hidden = true;
  document.body.append(files, directory);
  const open = control('打开姿势库 · 搜索 / 导入 / 收藏', () => execute(async () => { await reload(); render(); if(!dialog.open)dialog.showModal(); if(entry())await showPreview(); }), 'wide-button accent-button');
  open.id = 'open-pose-library'; document.querySelector('.reference-tabs').after(open);
  const message = text => { if(!disposed)$('pl-status').textContent = text; };
  const execute = task => Promise.resolve().then(task).catch(error => { if(!disposed){message(error.message); context.toast(error.message);} });
  const mutate = task => {
    if(writing)return;writing=true;render();
    return execute(task).finally(()=>{writing=false;if(!disposed)render();});
  };
  const entry = () => matches().find(item=>item.id===selected) || [...catalog.items,...gallery.items()].find(item => item.id === selected && (!item.hidden || $('pl-tab').value==='hidden'));
  const accept = next => {if(next.revision>=catalog.revision)catalog=next;};
  async function reload() {
    const [poses]=await Promise.all([api(),gallery.reload()]);accept(poses);
    $('pl-total').textContent = `${catalog.items.filter(item => !item.hidden).length} 项`;
    const cat = $('pl-category').value, source = $('pl-source').value;
    const all=[...catalog.items,...gallery.items()];
    $('pl-category').replaceChildren(new Option('全部动作',''), ...[...new Set(all.map(item => item.category))].sort().map(value => new Option(value,value))); $('pl-category').value = cat;
    $('pl-source').replaceChildren(new Option('全部来源',''), ...[...new Map(all.map(item => [item.source?.id || 'local',item.source?.name || '本地导入'])).entries()].map(([value,name]) => new Option(value==='builtin'?'AnyAngle内置':value==='local'?'本地保存 / 导入':name,value))); $('pl-source').value = source;
    if(!filtersRestored){filtersRestored=true;gallery.restoreFilters();}
    $('pl-sources').replaceChildren();
    for (const source of catalog.catalog || []) $('pl-sources').append(control(`读取 ${source.name}`, () => execute(() => readSource(source))));
    let legacy = [], migrated=false;
    try { legacy = JSON.parse(localStorage.getItem('anyangle-studio.poses.v1') || '[]'); migrated=localStorage.getItem('anyangle-studio.poses.migrated.v1')==='yes'; } catch { /* Server catalog remains available when browser storage is blocked. */ }
    $('pl-migrate').hidden = !Array.isArray(legacy) || !legacy.length || migrated;
    $('pl-migrate').textContent = `迁移旧姿势 ${legacy.length || 0} 项`;
    $('pl-migrate').onclick = () => execute(async () => {
      const form = new FormData();
      for (const [i, item] of legacy.entries()) if (item?.pose?.bones) form.append('files', new Blob([JSON.stringify({version:1,kind:'anyangle-pose',pose:item.pose})],{type:'application/json'}), `${item.name || `旧姿势${i+1}`}.json`);
      if (await inspect(form)) pending.migration = true;
    });
  }
  function matches() {
    const options=gallery.options();
    const bones=options.type==='reference-set'||options.angle||options.frame||options.collection||['recent','hidden'].includes(options.tab)?[]:filterCatalog(catalog.items,options).filter(item=>(!options.type||(item.kind||'pose')===options.type)&&(!options.people||String(item.slots?.length||1)===options.people));
    return [...bones,...gallery.matches()];
  }
  function targets() {
    const roles = editableActors(context.doc(), $('pl-scope').value);
    $('pl-target').textContent = context.doc().source.kind === 'human' ? `将应用到：${roles.map(role => role.label).join('、') || '没有可编辑人物'}` : '当前是静态图或重建主体；请先切换到可编辑人偶';
    const ids = new Set(roles.map(role=>role.id)), contacts = (context.doc().contacts || []).filter(contact => contact.actors?.some(id=>ids.has(id)));
    $('pl-contact-row').hidden = !contacts.length; $('pl-contact-text').textContent = `允许解除涉及这些人物的 ${contacts.length} 项接触关系`;
    const composition=entry()?.kind==='composition';
    $('pl-part').disabled=composition;$('pl-preserve-hands').disabled=composition;
    $('pl-apply').textContent=composition ? `应用 ${entry().slots.length} 人编排（更改站位）` : '应用到人物';
    if(composition)$('pl-target').textContent+=` · 需 ${entry().slots.length} 人，按显示顺序匹配角色`;
    $('pl-apply').disabled = writing || !entry() || !roles.length || context.doc().source.kind !== 'human' || contacts.length > 0 && !$('pl-release').checked || composition && roles.length!==entry().slots.length;
  }
  function render() {
    if(disposed)return;
    const images=gallery.items().filter(item=>!item.hidden);
    $('pl-total').textContent = `${catalog.items.filter(item=>!item.hidden).length} 动作/编排 · ${images.length} 图片组 / ${images.reduce((sum,item)=>sum+item.views.length,0)} 视角`;
    dialog.setAttribute('aria-busy',String(writing));
    for(const id of ['pl-save','pl-save-composition','pl-show-hidden','pl-files','pl-directory','pl-reload','pl-migrate','pl-import-commit','pl-import-cancel'])$(id).disabled=writing;
    for(const id of ['pl-save','pl-save-composition'])$(id).disabled=writing||context.doc().source.kind!=='human';
    $('pl-sources').querySelectorAll('button').forEach(button=>button.disabled=writing);
    const items = matches(), pages = Math.max(1,Math.ceil(items.length/24)); page = Math.min(page,pages-1);
    $('pl-grid').replaceChildren();
    for (const item of items.slice(page*24,(page+1)*24)) {
      const card = control('', () => { selected = item.id; render(); execute(showPreview); if (matchMedia('(max-width:700px)').matches) dialog.querySelector('.pl-detail:not([hidden])').scrollIntoView({block:'start',behavior:'smooth'}); }, 'pl-card' + (selected === item.id ? ' selected' : ''));
      if(item.kind==='reference-set'){const img=document.createElement('img'),view=item.views.find(view=>view.id===item.matchedViewIds?.[0])||item.views[0];img.src=galleryImage(view.thumbnail.name);img.loading='lazy';img.alt=`${item.name} · ${view.label}`;card.append(img);}
      else if (item.preview || item.builtin) { const img = document.createElement('img'); img.src = item.preview ? `${API}/previews/${encodeURIComponent(item.preview)}` : new URL(`./pose-previews/${encodeURIComponent(item.id)}.png`,import.meta.url).href; img.loading = 'lazy'; img.alt = item.name; card.append(img); }
      else { const graphic = document.createElement('span'); graphic.className='pl-placeholder'; graphic.textContent = item.category === '舞蹈' ? '✧' : item.category === '运动' ? '↗' : '◯'; card.append(graphic); }
      const name = document.createElement('strong'); name.textContent = item.name;
      const meta = document.createElement('small'); meta.textContent = `${item.favorite ? '★ ' : ''}${item.kind==='reference-set'?`${item.people}人图片 · ${item.views.length}视角`:item.kind==='composition' ? `${item.slots.length}人编排` : item.category} · ${item.builtin ? '内置' : '已导入'}${batchIds.has(item.id) ? ' · 批量已选' : ''}`;
      card.append(name,meta); $('pl-grid').append(card);
    }
    if (!items.length) { const empty=document.createElement('p'); empty.textContent='没有匹配姿势，可更改筛选或导入本地/外部姿势库。'; $('pl-grid').append(empty);for(const suggestion of gallery.suggestions())$('pl-grid').append(control(`取消${{angle:'视角',people:'人数',frame:'画幅',category:'分类',source:'来源',tab:'范围'}[suggestion.field]}筛选 · ${suggestion.count}组`,()=>{document.getElementById({angle:'pg-angle',people:'pg-people',frame:'pg-frame',category:'pl-category',source:'pl-source',tab:'pl-tab'}[suggestion.field]).value=suggestion.field==='tab'?'all':'';page=0;render();})); }
    $('pl-page').textContent = `${page+1} / ${pages} · ${items.length} 项`; $('pl-prev').disabled = page === 0; $('pl-next').disabled = page === pages-1;
    const item = entry();
    dialog.querySelector('.pl-content').dataset.selected = String(!!item);
    boneDetail.hidden=item?.kind==='reference-set';gallery.render(item);
    if(item?.kind==='reference-set'){previewToken++;return;}
    if (!item) {
      previewToken++; $('pl-preview').hidden = true; $('pl-preview-hint').hidden = false;
      $('pl-preview-hint').textContent = '选择姿势查看三维预览';
    }
    $('pl-name').textContent = item?.name || '选择一个姿势';
    $('pl-description').textContent = item ? `${item.originalName} · ${item.warnings?.join('；') || '可编辑骨骼姿势'}` : '卡片单击仅预览，应用后才改变当前人物。';
    $('pl-provenance').textContent = item ? JSON.stringify({source:item.source,rigProfile:item.rigProfile,poseHash:item.poseHash},null,2) : '';
    $('pl-favorite').textContent = item?.favorite ? '取消收藏' : '收藏';
    for (const id of ['pl-favorite','pl-rename','pl-delete','pl-batch','pl-export-one']) $(id).disabled = writing || !item;
    $('pl-batch').textContent = item && batchIds.has(item.id) ? '移出姿势批量' : '加入姿势批量';
    targets();
  }
  async function showPreview() {
    const item = clone(entry()); if (!item) return;
    if(item.kind==='reference-set'){previewToken++;gallery.preview(item);return;}
    const token = ++previewToken; $('pl-preview').hidden = true;
    $('pl-preview-hint').hidden = false; $('pl-preview-hint').textContent = '正在载入隔离的人偶预览…';
    previewWork = previewWork.catch(()=>{}).then(async () => {
      if (disposed || token !== previewToken || !dialog.open) return;
      const doc=defaultScene(), target=activeActor(context.doc());
      doc.source={kind:'human'};doc.width=doc.height=384;doc.interaction.quality='economy';
      doc.actors=(item.kind==='composition' ? item.slots : [{pose:item.pose}]).map((slot,i)=>createActor(i,{id:`library-preview-${i}`,mesh:clone(target?.mesh || doc.mesh),pose:clone(slot.pose),transform:{x:0,y:0,z:0,yaw:0,scale:1,...slot.transform}}));doc.activeActorId='library-preview-0';doc.selectedActorIds=doc.actors.map(role=>role.id);bindActor(doc);
      doc.camera={...doc.camera,azimuth:25,elevation:5,zoom:1};
      if (!preview) { preview=new StudioScene($('pl-preview'),{begin:()=>{},change:()=>{},camera:()=>{},select:()=>{},error:error=>message(error.message)});await preview.init(doc); }
      else await preview.restore(doc);
      if(item.kind==='composition')await finishCatalogPose(preview,{actorIds:doc.actors.map(role=>role.id),align:(item.align||[]).map(pair=>({actors:pair.slots.map(i=>doc.actors[i].id),hands:pair.hands}))});
      if (disposed || token !== previewToken || !dialog.open) return;
      preview.fit(true);$('pl-preview').hidden=false;$('pl-preview-hint').hidden=true;
    });
    await previewWork;
  }
  async function apply(item = entry()) {
    if (!item) return;
    const options={scope:$('pl-scope').value,part:item.kind==='composition'?'full':$('pl-part').value,preserveHands:item.kind!=='composition'&&$('pl-preserve-hands').checked,releaseContacts:$('pl-release').checked,ground:$('pl-ground').checked};
    await context.run(async()=>{
      try {
        const result=await applyCatalogTransaction(context,item,options);dialog.close();context.toast(`已应用「${item.name}」到 ${result.actorIds.length} 人；可撤销或继续微调`);
      } catch(error) { message(error.message); throw error; }
    });
  }
  async function inspect(form) {
    const token=++importToken;
    message('正在检查姿势文件…');
    const response = await fetch(API+'/inspect',{method:'POST',body:form}); const result=await readResult(response);
    if(disposed || token!==importToken || !dialog.open)return false;
    pending=result;renderImport();message('检查完成，选择要保存的项目。取消不会写入姿势库。');
    return true;
  }
  function renderImport() {
    $('pl-import').hidden=false;$('pl-import-summary').textContent=`可导入 ${pending.entries.length} 项，未通过 ${pending.errors.length} 项`;
    $('pl-import-rows').replaceChildren();
    for(const [i,item]of pending.entries.entries()){
      const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.checked=true;check.value=i;
      label.append(check,document.createTextNode(`${item.name} · ${item.warnings?.join('；') || '骨骼格式有效'}`));$('pl-import-rows').append(label);
    }
    for(const row of pending.errors){const line=document.createElement('p');line.textContent=`${row.path}：${row.error}`;$('pl-import-rows').append(line);}
  }
  async function readSource(source) {
    const token=++importToken;
    const node=$('pl-source-status');node.textContent=`正在读取 ${source.name}…`;
    const start=await api(`/sources/${source.id}/refresh`,{latest:$('pl-latest').checked});
    while(!disposed && token===importToken && dialog.open){
      const job=await api(`/jobs/${start.id}`);
      if(disposed || token!==importToken || !dialog.open)return;
      node.textContent=`${source.name} · ${job.index} / ${job.total || '…'} · ${job.path || ''}`;
      if(job.state==='failed')throw new Error(job.error);
      if(job.state==='ready'){pending=job.result;renderImport();node.textContent=`${source.name}：${pending.entries.length} 个有效姿势，${pending.errors.length} 项未通过`;return;}
      await new Promise(resolve=>setTimeout(resolve,1000));
    }
  }
  async function exportPack(ids) {
    const response=await fetch(API+'/export',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ids})});
    if(!response.ok)await readResult(response);
    context.download(await response.blob(),'anyangle-poses.zip');
  }
  function portablePose(id=context.doc().activeActorId) {
    const studio=context.studio(),viewer=studio.viewer,passive=viewer.passiveCharacters.get(id);
    const pose=clone(passive ? context.doc().actors.find(role=>role.id===id).pose : studio.pose());
    pose.positionDeltas={};
    for(const bone of passive?.boneList || viewer.boneList){
      const rest=passive?.initialPositions.get(bone.name) || viewer.shapedBoneRestPositions?.[bone.name] || viewer.initialBoneStates?.[bone.name]?.position;
      if(rest && bone.position.distanceToSquared(rest)>1e-10)pose.positionDeltas[bone.name]=[bone.position.x-rest.x,bone.position.y-rest.y,bone.position.z-rest.z];
    }
    delete pose.bonePositions;delete pose.hipBonePosition;delete pose.ikEffectorPositions;delete pose.poleTargetPositions;
    return pose;
  }
  async function saveCurrent() {
    if(context.doc().source.kind!=='human')throw new Error('请先选择可编辑人偶');
    const name=await context.askName('保存到共享姿势库','我的姿势');if(!name)return;
    const pose=portablePose();
    accept(await api('/import',{revision:catalog.revision,entries:[{name,originalName:name,pose,source:{id:'local',name:'用户保存',license:'用户提供'}}]}));
    selected=catalog.items.find(item=>item.name===name && !item.builtin)?.id;await reload();$('pl-source').value='local';$('pl-search').value=name;render();context.toast('姿势已保存到本地ComfyUI共享库');
  }
  async function saveComposition(){
    context.studio().syncPose();const roles=editableActors(context.doc(),$('pl-scope').value);
    if(roles.length<2)throw new Error('请在应用范围选择至少两位可编辑人物');
    const name=await context.askName('保存多人编排','我的多人编排');if(!name)return;
    const origin=roles[0].transform, ids=roles.map(role=>role.id);
    const slots=roles.map(role=>({label:role.label,pose:portablePose(role.id),transform:Object.fromEntries(['x','y','z','yaw'].map(key=>[key,role.transform[key]-origin[key]]))}));
    const align=(context.doc().contacts||[]).filter(pair=>pair.actors?.every(id=>ids.includes(id))).map(pair=>({slots:pair.actors.map(id=>ids.indexOf(id)),hands:pair.sides}));
    accept(await api('/import',{revision:catalog.revision,entries:[{kind:'composition',name,originalName:name,slots,align,pose:slots[0].pose,source:{id:'local',name:'用户保存编排',license:'用户提供'}}]}));
    await reload();render();message('多人编排已保存，不含人物身份照片；应用时明确匹配目标角色。');
  }
  $('pl-close').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{previewToken++;importToken++;pending=null;$('pl-import').hidden=true;});
  for(const id of ['pl-search','pl-category','pl-tab','pl-source'])$(id).oninput=()=>{if(!composing){page=0;render();}};
  $('pl-prev').onclick=()=>{page--;render();};$('pl-next').onclick=()=>{page++;render();};
  $('pl-files').onclick=()=>files.click();$('pl-directory').onclick=()=>directory.click();
  for(const input of [files,directory])input.onchange=()=>execute(async()=>{
    const form=new FormData();for(const file of input.files)if(/\.(json|zip|webp|png|jpe?g)$/i.test(file.name))form.append('files',file,file.webkitRelativePath || file.name);input.value='';await inspect(form);
  });
  $('pl-import-all').onclick=()=>$('pl-import-rows').querySelectorAll('input').forEach(input=>input.checked=true);
  $('pl-import-none').onclick=()=>$('pl-import-rows').querySelectorAll('input').forEach(input=>input.checked=false);
  $('pl-import-cancel').onclick=()=>{importToken++;pending=null;$('pl-import').hidden=true;};
  $('pl-import-commit').onclick=()=>mutate(async()=>{
    if(!pending)throw new Error('请先检查要导入的姿势');
    const inspected=pending,token=++importToken;
    const entries=[...$('pl-import-rows').querySelectorAll('input:checked')].map(input=>inspected.entries[Number(input.value)]);
    if(!entries.length)throw new Error('请至少选择一个有效姿势');
    accept(await api('/import',{revision:catalog.revision,entries}));
    let warning='';
    if(inspected.migration)try{localStorage.setItem('anyangle-studio.poses.migrated.v1','yes');}catch{warning=' 浏览器无法保存迁移标记，原数据仍保留。';}
    if(token===importToken){pending=null;$('pl-import').hidden=true;}await reload();render();message(`已保存 ${entries.length} 项；可直接预览和应用。${warning}`);
  });
  $('pl-reload').onclick=()=>execute(async()=>{await reload();render();message('已读取本地最新姿势库');});
  $('pl-save').onclick=()=>mutate(saveCurrent);$('pl-save-composition').onclick=()=>mutate(saveComposition);$('pl-export').onclick=()=>execute(()=>exportPack());$('pl-export-one').onclick=()=>execute(()=>exportPack([selected]));
  $('pl-show-hidden').onclick=()=>mutate(async()=>{for(const item of catalog.items.filter(item=>item.builtin&&item.hidden))accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:false}},'PATCH'));await reload();render();});
  $('pl-apply').onclick=()=>mutate(()=>apply());$('pl-scope').onchange=targets;$('pl-release').onchange=targets;
  $('pl-fit').onclick=()=>execute(async()=>{dialog.close();await context.run(async()=>{context.begin();context.studio().fit(true);context.changed();});});
  $('pl-favorite').onclick=()=>mutate(async()=>{const item=entry();accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{favorite:!item.favorite}},'PATCH'));render();});
  $('pl-rename').onclick=()=>mutate(async()=>{const item=entry(),name=await context.askName('重命名姿势',item.name);if(!name)return;accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{name}},'PATCH'));render();});
  $('pl-delete').onclick=()=>mutate(async()=>{
    const item=clone(entry());if(item.builtin)accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:true}},'PATCH'));else accept(await api('/delete',{revision:catalog.revision,ids:[item.id]}));
    batchIds.delete(item.id);selected=null;render();message('条目已移除；已保存场景保留原动作。');
    const undo=control('恢复刚移除的姿势',()=>mutate(async()=>{if(item.builtin)accept(await api(`/items/${item.id}`,{revision:catalog.revision,changes:{hidden:false}},'PATCH'));else accept(await api('/import',{revision:catalog.revision,entries:[item]}));render();undo.remove();}));$('pl-status').append(' ',undo);
  });
  $('pl-batch').onclick=()=>{if(batchIds.has(selected))batchIds.delete(selected);else batchIds.add(selected);render();context.batchChanged?.();};
  $('save-pose').onclick=()=>mutate(async()=>{await reload();await saveCurrent();});
  $('import-pose').onclick=()=>execute(async()=>{await reload();render();dialog.showModal();files.click();});
  return {
    open:()=>open.click(), refresh:()=>{if(dialog.open){render();}},
    batchEntries:()=>catalog.items.filter(item=>batchIds.has(item.id)).map(clone),
    batchOptions:()=>({scope:$('pl-scope').value,part:$('pl-part').value,preserveHands:$('pl-preserve-hands').checked,releaseContacts:$('pl-release').checked,ground:$('pl-ground').checked}),
    destroy:async()=>{disposed=true;previewToken++;importToken++;gallery.destroy();await previewWork.catch(()=>{});preview?.dispose();dialog.remove();files.remove();directory.remove();},
  };
}
