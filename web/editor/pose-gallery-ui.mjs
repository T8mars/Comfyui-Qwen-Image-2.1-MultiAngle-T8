import { indexGallery, searchGallery, relatedSuggestions } from './gallery-search.mjs?v=20261029v180';
import { addGalleryReference } from './gallery-pose.mjs?v=20261029v180';
import { uuid } from '../uuid.mjs?v=20261010lan1';

const API='/anyangle-studio/pose-gallery', $=id=>document.getElementById(id);
const clone=value=>structuredClone(value);
export const galleryImage=name=>`${API}/blobs/${encodeURIComponent(name)}`;
async function api(path='',data,method='POST'){
  const response=await fetch(API+path,data===undefined?{}:{method,headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
  const result=await response.json().catch(()=>null);
  if(!response.ok||!result)throw new Error(result?.error||`图片姿势库请求失败（HTTP ${response.status}）`);
  return result;
}
function button(text,action){const node=document.createElement('button');node.type='button';node.textContent=text;node.onclick=action;return node;}
const filterControls={type:'pg-type',people:'pg-people',frame:'pg-frame',angle:'pg-angle',sort:'pg-sort',collection:'pg-collection',offline:'pg-offline',query:'pl-search',category:'pl-category',tab:'pl-tab',source:'pl-source'};

export function installPoseGallery(context,hooks){
  let data={revision:0,items:[],presets:[],collections:[]}, index=[], selected=null, viewId=null, token=0, busy=false, disposed=false, remembering=false, importAbort=null, activeJob=null;
  const selection=new Map();let resumeJob=null;
  const filters=document.createElement('div');filters.className='pg-filters';
  filters.innerHTML=`<select id="pg-type" aria-label="姿势类型"><option value="">全部类型</option><option value="pose">可编辑动作</option><option value="composition">多人编排</option><option value="reference-set">图片姿势参考</option></select>
    <select id="pg-people" aria-label="人数"><option value="">全部人数</option><option value="1">单人</option><option value="2">双人</option></select>
    <select id="pg-frame" aria-label="动作画幅"><option value="">全身与半身</option><option value="full">全身</option><option value="upper">上半身</option></select>
    <select id="pg-angle" aria-label="图库视角"><option value="">全部视角</option><option value="front">正面</option><option value="side">侧面</option><option value="diag">斜侧</option><option value="high">俯视</option><option value="low">仰视</option></select>
    <select id="pg-sort" aria-label="排序"><option value="">相关度 / 名称</option><option value="recent">最近应用</option><option value="favorite">收藏优先</option></select>
    <select id="pg-collection" aria-label="图片收藏夹"><option value="">全部收藏夹</option></select><select id="pg-offline" aria-label="离线资源"><option value="">全部资源</option><option value="ready">原图已就绪</option></select>`;
  hooks.dialog.querySelector('.pl-toolbar').after(filters);
  const chips=document.createElement('div');chips.className='pg-active-filters';filters.after(chips);
  $('pl-tab').append(new Option('最近应用的图片','recent'),new Option('已隐藏的图片','hidden'));
  $('pl-search').placeholder='动作、编号或组合：举手 / 叉腰 / 双人 侧面';
  const management=document.createElement('details');management.className='pl-sources pg-management';
  management.innerHTML=`<summary>图片姿势库 · 导入、搜索预设与收藏夹</summary><p class="hint">导入完整图库目录或ZIP。图片按动作分组，选视角作为参考，也可提取骨架后复制到人偶。</p>
    <div class="compact-actions"><button id="pg-import-zip">导入图片图库 ZIP</button><button id="pg-import-dir">导入图片图库目录</button><button id="pg-export">导出全部图片图库</button><button id="pg-jobs">导入任务 / 继续导入</button><button id="pg-cache-clear">清理导出与无引用缓存</button></div><div id="pg-job-list"></div>
    <div class="pg-settings-row"><select id="pg-presets" aria-label="已保存搜索"><option value="">选择搜索预设</option></select><button id="pg-preset-save">保存当前搜索</button><button id="pg-preset-update">更新</button><button id="pg-preset-rename">改名</button><button id="pg-preset-delete">删除</button></div>
    <div class="pg-settings-row"><button id="pg-collection-new">新建收藏夹</button><button id="pg-collection-rename">改名当前收藏夹</button><button id="pg-collection-delete">删除当前收藏夹</button><button id="pg-settings-export">导出预设与收藏夹</button><button id="pg-settings-import">导入预设与收藏夹</button></div>
    <p id="pg-status" class="hint" role="status"></p>`;
  hooks.dialog.querySelector('.pl-management').after(management);
  const detail=document.createElement('aside');detail.className='pl-detail pg-detail';detail.hidden=true;
  detail.innerHTML=`<div class="pg-image-stage"><img id="pg-image" alt="当前视角的姿势参考"><span id="pg-image-state"></span></div><h3 id="pg-name"></h3><p id="pg-info" class="hint"></p><div id="pg-views" class="pg-views"></div>
    <p id="pg-matches" class="hint"></p><label>动作参考用于<select id="pg-target"><option value="scene">整个画面</option></select></label>
    <button id="pg-reference" class="primary">作为动作参考</button><button id="pg-extract" class="wide-button">提取 POSE / 复制到人偶</button><p class="hint">当前视角是二维参考。复制到人偶会先检测、预览并选择目标；没有检测到的肢体保持原状。</p>
    <div class="pl-entry-actions"><button id="pg-favorite">收藏</button><button id="pg-rename">改名</button><button id="pg-tags">动作标签</button><button id="pg-hide">隐藏</button><button id="pg-collection-add">加入当前收藏夹</button><button id="pg-export-one">导出此动作组</button></div>
    <details><summary>按图库视角批量</summary><p class="hint">勾选实际视角，每张图生成一个任务。人偶动作×机位仍使用原来的姿势批量。</p><div id="pg-batch-views"></div><button id="pg-batch-add">加入视角批量</button><p id="pg-batch-count"></p><button id="pg-batch-run">运行已选视角批量</button><button id="pg-batch-clear">清空批量选择</button></details>
    <details><summary>来源与图片信息</summary><pre id="pg-provenance"></pre></details>`;
  hooks.dialog.querySelector('.pl-content').append(detail);
  const zip=document.createElement('input'),directory=document.createElement('input'),settingsFile=document.createElement('input');
  for(const input of [zip,directory,settingsFile]){input.type='file';input.hidden=true;document.body.append(input);}
  zip.accept='.zip';directory.webkitdirectory=true;directory.multiple=true;settingsFile.accept='.json';
  const message=text=>{if(!disposed)$('pg-status').textContent=text;};
  const execute=fn=>Promise.resolve().then(fn).catch(error=>{if(!disposed){message(error.message);context.toast(error.message);}});
  const mutate=fn=>{if(busy)return;busy=true;controls();return execute(fn).finally(()=>{busy=false;if(!disposed){controls();hooks.refresh();}});};
  function accept(next){if(next.revision>=data.revision){data=next;index=indexGallery(data.items);settings();}}
  function options(){const result=Object.fromEntries(Object.entries(filterControls).map(([key,id])=>[key,$(id).value]));const folder=data.collections.find(row=>row.id===result.collection);if(folder)result.collectionIds=folder.ids;return result;}
  function restoreOptions(value){for(const [key,id]of Object.entries(filterControls))if(value[key]!==undefined)$(id).value=value[key];hooks.filterChanged();}
  function settings(){
    for(const [id,rows,label]of [['pg-presets',data.presets,'选择搜索预设'],['pg-collection',data.collections,'全部收藏夹']]){
      const value=$(id).value;$(id).replaceChildren(new Option(label,''),...rows.map(row=>new Option(row.name,row.id)));$(id).value=value;
    }
  }
  async function reload(){accept(await api());}
  async function remember(){if(remembering||disposed)return;remembering=true;try{const current=options();delete current.collectionIds;accept(await api('/preferences',{revision:data.revision,changes:{lastFilters:current}}));}catch(error){message(`筛选未保存：${error.message}`);}finally{remembering=false;}}
  function controls(){
    // Keep selection and targets fixed while an asset, edit or batch is being prepared.
    for(const node of [detail,management,filters,chips,...hooks.dialog.querySelectorAll('.pl-list,.pl-toolbar,.pl-management,.pl-sources')])node.inert=busy;
    detail.setAttribute('aria-busy',String(busy));
  }
  function item(){return data.items.find(row=>row.id===selected);}
  function view(){return item()?.views.find(row=>row.id===viewId);}
  function render(entry){
    chips.replaceChildren();for(const [key,id] of Object.entries(filterControls)){const control=$(id);if(!control.value||key==='tab'&&control.value==='all')continue;
      const label=control.tagName==='SELECT'?control.selectedOptions[0]?.textContent:control.value;
      chips.append(button(`${label} ×`,()=>{control.value=key==='tab'?'all':'';hooks.filterChanged();}));}
    const active=entry?.kind==='reference-set';detail.hidden=!active;
    if(!active){if(selected!==null){token++;selected=null;viewId=null;$('pg-image').removeAttribute('src');}return;}
    const changed=entry.id!==selected;
    if(changed){token++;selected=entry.id;viewId=entry.matchedViewIds?.[0]||entry.views[0].id;}
    if(!entry.views.some(row=>row.id===viewId))viewId=entry.views[0].id;
    const current=view();
    $('pg-name').textContent=entry.name;$('pg-info').textContent=`${entry.systemName} · ${entry.number} · ${entry.people}人 · ${entry.views.length}个实际视角${entry.sourceMissing?' · 新来源索引已不含此动作，保留本地副本':''}`;
    $('pg-image').src=galleryImage((current.original.ready?current.original:current.thumbnail).name);
    $('pg-image-state').textContent=current.original.ready?'':'仅缩略图，原图尚未就绪';
    $('pg-image').onerror=()=>{$('pg-image-state').textContent='图片读取失败，请继续图库导入或刷新';};
    $('pg-matches').textContent=entry.matchReasons?.length?`命中：${entry.matchReasons.join(' · ')}`:'';
    $('pg-views').replaceChildren();
    for(const angle of ['front','side','diag','high','low']){
      const candidate=entry.views.find(row=>row.angle===angle),label={front:'正面',side:'侧面',diag:'斜侧',high:'俯视',low:'仰视'}[angle];
      const node=button(candidate?label:`${label} · 缺`,()=>{token++;viewId=candidate.id;render(entry);});node.disabled=!candidate;node.classList.toggle('selected',candidate?.id===viewId);$('pg-views').append(node);
    }
    const target=$('pg-target').value;
    $('pg-target').replaceChildren(new Option('整个画面','scene'),new Option('当前所选人物','selected'),...(context.doc().actors||[]).filter(role=>role.visible!==false).map(role=>new Option(role.label,role.id)));
    $('pg-target').value=[...$('pg-target').options].some(option=>option.value===target)?target:'scene';
    $('pg-favorite').textContent=entry.favorite?'取消收藏':'收藏';$('pg-hide').textContent=entry.hidden?'恢复显示':'隐藏此动作';
    $('pg-provenance').textContent=JSON.stringify({source:entry.source,view:current,tags:entry.tags},null,2);
    if(changed){$('pg-batch-views').replaceChildren();for(const candidate of entry.views){const label=document.createElement('label'),check=document.createElement('input');check.type='checkbox';check.value=candidate.id;check.checked=selection.has(candidate.id);label.append(check,document.createTextNode(candidate.label));$('pg-batch-views').append(label);}}
    $('pg-batch-count').textContent=`已选 ${selection.size} 个视角`;
    $('pg-reference').disabled=busy||entry.hidden||!current.original.ready;$('pg-extract').disabled=busy||entry.hidden||!current.original.ready;
  }
  function target(){const value=$('pg-target').value,doc=context.doc();if(value==='scene')return{kind:'scene',ids:[],text:''};const ids=value==='selected'?(doc.selectedActorIds||[]):[value];const visible=ids.filter(id=>doc.actors?.some(role=>role.id===id&&role.visible!==false));if(!visible.length)throw new Error('请先选择可见的人物');return{kind:'actors',ids:visible,text:''};}
  async function getAsset(id=selected,view=viewId){return api('/asset',{id,view});}
  async function markUsed(id){try{accept(await api(`/items/${id}`,{revision:data.revision,changes:{used:true}},'PATCH'));}catch(error){message(`动作已应用；最近使用未记录：${error.message}`);}}
  async function addCurrent(){
    const stamp=token,id=selected,mapping=target(), result=await getAsset();
    if(stamp!==token||!hooks.dialog.open)return;
    await context.run(async()=>{context.begin();addGalleryReference(context.doc(),result.asset,result.source,mapping);
      context.changed();hooks.dialog.close();context.toast('已加入动作参考；可在参考素材里继续调整用途与目标');});
    await markUsed(id);
  }
  async function extract(){const stamp=token,id=selected,result=await getAsset();if(stamp!==token||!hooks.dialog.open)return;
    if(!context.galleryExtract)throw new Error('姿势提取界面尚未就绪，请刷新页面');
    const applied=await context.galleryExtract(result.asset,result.source,item().people);if(applied){hooks.dialog.close();await markUsed(id);}
  }
  async function exportPack(ids){message('正在整理图片包…');const result=await api('/export',{ids});
    context.download(result.url,'anyangle-image-poses.zip');message('图片包已准备，浏览器直接下载；包含来源说明、收藏夹与搜索预设');}
  async function patch(changes){accept(await api(`/items/${selected}`,{revision:data.revision,changes},'PATCH'));hooks.refresh();render(item());}
  async function saveSettings(changes){accept(await api('/preferences',{revision:data.revision,changes}));hooks.refresh();}
  async function poll(ident){
    activeJob=ident;
    while(!disposed&&activeJob===ident){const state=await api('/jobs/'+ident);message(`图库导入 · ${state.completed}/${state.total||'…'} · ${state.view||state.state}`);
      if(state.state==='ready'){await reload();hooks.catalogChanged();message(`已导入 ${state.result.groups} 组动作、${state.result.views} 个视角`);break;}
      if(['failed','cancelled','paused'].includes(state.state)){message(state.error||'已取消，已校验的文件保留，可继续导入');break;}
      await new Promise(resolve=>setTimeout(resolve,600));}
    await showJobs();
  }
  async function showJobs(){const rows=await api('/jobs');$('pg-job-list').replaceChildren();
    for(const row of rows){const div=document.createElement('div');div.className='pg-job';const info=document.createElement('span');info.textContent=`${row.name} · ${row.state} · ${row.completed}/${row.total||'…'}`;div.append(info);
      if(row.state==='running')div.append(button('取消',()=>execute(()=>api(`/jobs/${row.id}/cancel`,{}))));
      else {
        if(row.state!=='ready'){
          div.append(button('重新选择文件继续上传',()=>{resumeJob=row;(row.kind==='zip'?zip:directory).click();}));
          div.append(button('校验已上传文件 / 重试导入',()=>execute(async()=>{await api(`/jobs/${row.id}/start`,{});await poll(row.id);})));}
        div.append(button('删除上传临时文件',()=>execute(async()=>{await api(`/jobs/${row.id}/remove`,{});await showJobs();message('上传临时文件已清理；已导入动作与场景素材保留');})));}
      $('pg-job-list').append(div);}
  }
  async function importFiles(list,kind){
    if(importAbort)throw new Error('另一个图库正在上传');
    const files=[...list];if(!files.length)return;
    const previous=resumeJob;resumeJob=null;
    const sourceName=kind==='zip'?files[0].name:files[0].webkitRelativePath.split('/')[0];
    if(previous&&(previous.kind!==kind||previous.name!==sourceName))throw new Error('继续上传请重新选择同名的原始目录或 ZIP；其他图库请创建新导入');
    const job=previous?await api(`/jobs/${previous.id}/resume`,{}):await api('/jobs',{kind,name:kind==='zip'?files[0].name:files[0].webkitRelativePath.split('/')[0]});importAbort=new AbortController();activeJob=job.id;
    const cancel=button('取消上传',()=>importAbort?.abort());$('pg-job-list').replaceChildren(cancel);
    try{let count=0;for(const file of files){message(`正在上传图库 ${++count}/${files.length} · ${file.name}`);const response=await fetch(`${API}/jobs/${job.id}/file?path=${encodeURIComponent(file.webkitRelativePath||file.name)}`,{method:'PUT',body:file,signal:importAbort.signal});
        if(!response.ok){const result=await response.json();throw new Error(result.error||'上传失败');}}
      await api(`/jobs/${job.id}/start`,{});importAbort=null;await showJobs();await poll(job.id);
    }catch(error){if(error.name==='AbortError'){await api(`/jobs/${job.id}/cancel`,{});message('上传已取消');}else throw error;}
    finally{importAbort=null;await showJobs();}
  }
  async function presetChange(mode){const id=$('pg-presets').value,rows=clone(data.presets),row=rows.find(row=>row.id===id);
    if(mode!=='save'&&!row)throw new Error('先选择一个搜索预设');
    if(mode==='delete'){await saveSettings({presets:rows.filter(value=>value.id!==id)});return;}
    const name=mode==='update'?row.name:await context.askName(mode==='save'?'保存搜索预设':'重命名搜索预设',row?.name||$('pl-search').value||'常用搜索');if(!name)return;
    const value=options();delete value.collectionIds;
    if(mode==='save')rows.push({id:uuid(),name,filters:value});else Object.assign(row,{name},mode==='update'?{filters:value}:{});
    await saveSettings({presets:rows});
  }
  async function collectionChange(mode){const id=$('pg-collection').value,rows=clone(data.collections),row=rows.find(row=>row.id===id);
    if(mode!=='new'&&!row)throw new Error('先选择一个收藏夹');
    if(mode==='delete'){await saveSettings({collections:rows.filter(value=>value.id!==id)});return;}
    if(mode==='add'){if(!selected)throw new Error('先选择动作');row.ids=row.ids.includes(selected)?row.ids.filter(value=>value!==selected):[...row.ids,selected];await saveSettings({collections:rows});return;}
    const name=await context.askName(mode==='new'?'新建收藏夹':'重命名收藏夹',row?.name||'常用动作');if(!name)return;
    if(mode==='new')rows.push({id:uuid(),name,ids:[]});else row.name=name;await saveSettings({collections:rows});
  }
  for(const id of Object.values(filterControls))$(id).addEventListener('change',()=>{hooks.filterChanged();});
  $('pl-search').addEventListener('compositionstart',()=>hooks.composing(true));$('pl-search').addEventListener('compositionend',()=>{hooks.composing(false);hooks.filterChanged();});
  hooks.dialog.addEventListener('keydown',event=>{if(event.key==='/'&&!event.isComposing&&!/INPUT|TEXTAREA|SELECT/.test(event.target.tagName)){event.preventDefault();$('pl-search').focus();}});
  hooks.dialog.addEventListener('close',()=>{token++;remember();});
  $('pg-reference').onclick=()=>mutate(addCurrent);$('pg-extract').onclick=()=>mutate(extract);
  $('pg-favorite').onclick=()=>mutate(()=>patch({favorite:!item().favorite}));
  $('pg-hide').onclick=()=>mutate(()=>patch({hidden:!item().hidden}));
  $('pg-rename').onclick=()=>mutate(async()=>{const name=await context.askName('动作改名',item().name);if(name)await patch({name});});
  $('pg-tags').onclick=()=>mutate(async()=>{const tags=await context.askName('动作标签（逗号分隔）',(item().tags||[]).join('，'));if(tags!==null)await patch({tags:tags.split(/[,，]/).map(x=>x.trim()).filter(Boolean)});});
  $('pg-export-one').onclick=()=>mutate(()=>exportPack([selected]));$('pg-export').onclick=()=>mutate(()=>exportPack());
  $('pg-import-zip').onclick=()=>{resumeJob=null;zip.click();};$('pg-import-dir').onclick=()=>{resumeJob=null;directory.click();};
  zip.onchange=()=>{const files=[...zip.files];zip.value='';execute(()=>importFiles(files,'zip'));};directory.onchange=()=>{const files=[...directory.files];directory.value='';execute(()=>importFiles(files,'directory'));};
  $('pg-jobs').onclick=()=>execute(showJobs);
  $('pg-cache-clear').onclick=()=>mutate(async()=>{const result=await api('/cache/clear',{});message(`已清理 ${(result.removedBytes/1024/1024).toFixed(1)} MiB 导出/无引用缓存；图库与已应用素材保留`);});
  $('pg-presets').onchange=()=>{const row=data.presets.find(row=>row.id===$('pg-presets').value);if(row)restoreOptions(row.filters);};
  for(const mode of ['save','update','rename','delete'])$('pg-preset-'+mode).onclick=()=>mutate(()=>presetChange(mode));
  for(const mode of ['new','rename','delete','add'])$('pg-collection-'+mode).onclick=()=>mutate(()=>collectionChange(mode));
  $('pg-settings-export').onclick=()=>context.download(new Blob([JSON.stringify({kind:'anyangle-gallery-settings',version:1,presets:data.presets,collections:data.collections},null,2)],{type:'application/json'}),'anyangle-gallery-settings.json');
  $('pg-settings-import').onclick=()=>settingsFile.click();settingsFile.onchange=()=>mutate(async()=>{const file=settingsFile.files[0];settingsFile.value='';if(!file)return;if(file.size>1024*1024)throw new Error('设置文件超过1 MiB');const value=JSON.parse(await file.text());if(value.kind!=='anyangle-gallery-settings'||value.version!==1)throw new Error('请选择图库设置JSON');
    const changes={};for(const key of ['presets','collections']){if(!Array.isArray(value[key]))throw new Error('图库设置格式无效');const rows=new Map(data[key].map(row=>[row.id,row]));for(const row of value[key])rows.set(row.id,row);changes[key]=[...rows.values()];}await saveSettings(changes);});
  $('pg-batch-add').onclick=()=>{for(const node of $('pg-batch-views').querySelectorAll('input')){if(node.checked)selection.set(node.value,{id:selected,view:node.value});else selection.delete(node.value);}render(item());};
  $('pg-batch-clear').onclick=()=>{selection.clear();$('pg-batch-views').querySelectorAll('input').forEach(node=>node.checked=false);render(item());};
  $('pg-batch-run').onclick=()=>mutate(async()=>{if(!selection.size)throw new Error('先勾选视角并加入批量');if(!context.galleryBatch)throw new Error('视角批量尚未就绪，请刷新页面');
    const stamp=token,mapping=target(),rows=clone([...selection.values()]),plan=[];
    for(const row of rows){const asset=await getAsset(row.id,row.view);if(stamp!==token||!hooks.dialog.open)return;plan.push({...row,...asset});}
    await context.galleryBatch(plan,mapping);
  });
  return {reload,items:()=>data.items,matches:()=>searchGallery(index,options()),options,render,
    restoreFilters:()=>restoreOptions(data.lastFilters||{}),suggestions:()=>relatedSuggestions(index,options()),
    preview:item=>{render(item);},destroy:()=>{disposed=true;activeJob=null;token++;importAbort?.abort();for(const input of [zip,directory,settingsFile])input.remove();}};
}
