import { createActor, activeActor, ensureActors, bindActor, cloneActor, removeActor, moveActor, editableActors, actorSeed, applySceneTemplate } from './actors.mjs?v=20261009v160';
import { randomPose } from './poses.mjs?v=20261009v160';
import { installCastTools } from './cast-tools.mjs?v=20261009v160';
import { poseCopyIssue, ORDER } from './openpose.mjs?v=20261009v160';
import { guideSource } from './guides.mjs?v=20261009v160';
import { addReference, newUse } from './reference-library.mjs?v=20261009v160';

let context, renderKey, renderedDoc, renderedRoles = [], references = [];
let refreshCastTools;
const $ = id => document.getElementById(id);
const clone = value => structuredClone(value);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function button(text, action, title = text) { const node = document.createElement('button'); node.textContent = text; node.title = title; node.onclick = action; return node; }
async function atomic(action) {
  return context.run(() => editTransaction(action));
}
async function editTransaction(action) {
  const previous = clone(context.doc()), rollbackHistory = context.begin();
  try { await action(); context.changed(); }
  catch (error) {
    context.replace(previous); rollbackHistory?.();
    try { await context.studio().restore(previous); } catch { /* Keep the original edit error. */ }
    throw error;
  }
}
export function installActorsUI(options) {
  context = options;
  $('actors-panel').innerHTML = `<div class="section-heading"><h2>场景人物 <small id="actor-count">0</small></h2><span class="tag">CAST</span></div>
    <div class="actor-toolbar"><button id="add-actor" class="accent-button">＋ 添加人物</button><button id="clone-actor">复制</button><button id="delete-actor">删除</button></div>
    <p class="hint">选择角色编辑；Ctrl 点击可多选。显示决定输出，锁定保护动作与站位。</p><div id="actor-list" class="actor-list"></div>
    <div id="active-actor-controls"><label>名称<input id="actor-label" maxlength="48"></label><label>角色色<input id="actor-color" type="color"></label>
    <div class="actor-position"><label>X<input id="actor-x" type="number" step="0.1"></label><label>Y<input id="actor-y" type="number" step="0.1"></label><label>Z<input id="actor-z" type="number" step="0.1"></label></div>
    <div class="dimensions"><label>朝向 °<input id="actor-yaw" type="number" step="1"></label><label>尺度<input id="actor-scale" type="number" min="0.01" step="0.01"></label></div>
    <label>拖动平面<select id="actor-plane"><option value="screen">视图平面 · 上下 / 左右</option><option value="ground">地面 · 前后 / 左右</option></select></label><div class="compact-actions"><button id="ground-actors">选中人物落地</button><button id="fit-actors">适合选中人物</button></div>
    <div class="actor-identity"><h3>身份参考 <small>与姿势来源独立</small></h3><label>来源<select id="actor-reference"><option value="text">文字描述 · 不用照片</option><option value="upload">上传人物照片…</option><option value="reference">共享左侧原图</option></select></label><img id="actor-reference-preview" alt="此角色身份照片" hidden><label>合影中的人物区域描述<input id="actor-source-person" placeholder="例如：左侧戴眼镜的人"></label><label>外观 / 服装<textarea id="actor-description" rows="3" maxlength="16000" placeholder="人物外观、服装、风格"></textarea></label><p id="actor-binding-state" class="hint"></p></div></div>
    <label class="option-toggle"><input id="actor-identities" type="checkbox"><span>分别绑定人物身份<small>Qwen 底模配合“多人编码”节点使用</small></span></label>
    <label class="option-toggle"><input id="color-actors" type="checkbox"><span>粗图使用角色色<small>辅助区分人物；POSE 仍保留标准关节颜色</small></span></label>`;
  const identityFile = document.createElement('input'); identityFile.type = 'file'; identityFile.accept = 'image/*'; identityFile.hidden = true; identityFile.id = 'actor-identity-file'; document.body.append(identityFile);
  const readReferences = button('读取连线人物照片', () => context.send('anyangle-read-actors')); readReferences.id = 'read-actor-references'; readReferences.className = 'wide-button'; $('actors-panel').append(readReferences);
  const readKeypoints = button('读取连线姿势关键点 · SDPose', () => context.send('anyangle-read-keypoints')); readKeypoints.id = 'read-pose-keypoints'; readKeypoints.className = 'wide-button'; readKeypoints.hidden = true; $('openpose-panel').prepend(readKeypoints);
  $('add-actor').onclick = () => atomic(async () => {
    const doc = context.doc(), wasEmpty = doc.source.kind === 'empty' && !doc.actors?.length;
    context.studio().syncPose(); ensureActors(doc); const actor = createActor(doc.actors.length);
    doc.actors.push(actor); doc.activeActorId = actor.id; doc.selectedActorIds = [actor.id]; doc.source = { kind: 'human' };
    bindActor(doc); if (wasEmpty) { doc.conditioning.model = 'base'; doc.conditioning.identityMode = 'actors'; doc.conditioning.imageOrder = 'guide-first'; }
    await context.studio().restore(doc); await context.ensureHumanTools(); context.showScene();
    context.toast(wasEmpty ? '人物已加入；可继续添加、选人编辑并绑定身份' : '人物已加入；多人摆姿推荐 Qwen 底模，当前模型选择已保留');
  });
  $('clone-actor').onclick = () => atomic(async () => {
    const doc = context.doc(); context.studio().syncPose(); const actor = cloneActor(doc);
    doc.activeActorId = actor.id; doc.selectedActorIds = [actor.id]; bindActor(doc); await context.studio().restore(doc);
  });
  $('delete-actor').onclick = () => atomic(async () => { const doc = context.doc(); removeActor(doc, doc.activeActorId); await context.studio().restore(doc); });
  for (const [id, key] of [['actor-x', 'x'], ['actor-y', 'y'], ['actor-z', 'z'], ['actor-yaw', 'yaw'], ['actor-scale', 'scale']]) $(''+id).onchange = () => {
    const actor = activeActor(context.doc()), value = Number($(id).value);
    if (!actor || actor.locked || !Number.isFinite(value) || key === 'scale' && value <= 0) return;
    context.begin(); actor.transform[key] = value; bindActor(context.doc()); context.studio().updateActorTransform(actor); context.changed();
  };
  $('actor-label').onchange = () => { const actor = activeActor(context.doc()); if (!actor) return; context.begin(); actor.label = $('actor-label').value.trim() || '人物'; context.changed(); };
  $('actor-color').onchange = () => {
    const actor = activeActor(context.doc()); if (!actor) return; context.begin(); actor.editorColor = $('actor-color').value;
    context.studio().viewer.setActiveCharacterAppearance({ color: actor.editorColor }); context.changed();
  };
  $('actor-plane').onchange = () => { context.begin(); context.doc().interaction.movePlane = $('actor-plane').value; context.changed(false); };
  $('ground-actors').onclick = () => { context.begin(); context.studio().groundActors(context.doc().selectedActorIds); context.changed(); };
  $('fit-actors').onclick = () => { context.begin(); context.studio().fit(true); context.changed(); };
  $('actor-description').onchange = () => { const actor = activeActor(context.doc()); if (!actor) return; context.begin(); actor.identity.description = $('actor-description').value; context.changed(false); };
  $('actor-source-person').onchange = () => { const actor = activeActor(context.doc()); if (!actor) return; context.begin(); const description = $('actor-source-person').value.trim(); actor.identity.sourcePerson = actor.identity.sourcePerson && typeof actor.identity.sourcePerson === 'object' ? { ...actor.identity.sourcePerson, description } : description || null; context.changed(false); };
  $('actor-identities').onchange = () => { context.begin(); context.doc().conditioning.identityMode = $('actor-identities').checked ? 'actors' : 'scene'; context.changed(false); };
  $('color-actors').onchange = () => { context.begin(); context.doc().conditioning.colorActors = $('color-actors').checked; context.changed(); };
  $('actor-reference').onchange = () => {
    const actor = activeActor(context.doc()); if (!actor) return; const value = $('actor-reference').value;
    if (value === 'upload') { identityFile.dataset.actorId = actor.id; identityFile.click(); return; }
    context.begin(); actor.identity.inputKey = value.startsWith('actor_reference_') ? value : null;
    actor.identity.asset = value === 'reference' ? context.doc().reference : references.find(ref => ref.inputKey === value)?.asset || null;
    actor.identity.sourcePerson = null; context.changed(false);
  };
  identityFile.onchange = () => { const file = identityFile.files[0], id = identityFile.dataset.actorId; identityFile.value = ''; if (!file) return;
    atomic(async () => { const asset = await context.upload(file), actor = context.doc().actors.find(item => item.id === id); if (!actor) throw new Error('此人物已删除'); actor.identity.asset = asset; actor.identity.inputKey = null; actor.identity.sourcePerson = null; });
  };
  $('random-scope').onchange = () => { context.begin(); context.doc().randomScope = $('random-scope').value; context.changed(false); };
  $('save-composition').onclick = async () => {
    const name = await context.askName('保存全场模板', '合影编排'); if (!name) return;
    context.begin(); context.studio().syncPose(); const doc = context.doc(); doc.compositionTemplates ||= [];
    doc.compositionTemplates.push({ id: crypto.randomUUID(), name, actors: clone(doc.actors).map(actor => ({ ...actor, identity: { asset: null, inputKey: null, sourcePerson: null, description: '' } })), props: clone(doc.props || []), contacts: clone(doc.contacts || []), camera: clone(doc.camera), cameraTarget: clone(doc.cameraTarget) }); context.changed(false);
  };
  $('apply-composition').onclick = () => atomic(async () => {
    const doc = context.doc(), template = doc.compositionTemplates?.find(item => item.id === $('composition-list').value);
    if (!template) throw new Error('请先选择全场模板');
    if (doc.actors.some(actor => actor.locked)) throw new Error('请先解锁人物，再应用整场模板');
    if (template.props && doc.props?.some(prop => prop.locked)) throw new Error('请先解锁道具，再应用整场模板');
    applySceneTemplate(doc, template); await context.studio().restore(doc); context.studio().useRigPose(); await context.ensureHumanTools();
  });
  $('export-scene').onclick = () => context.run(async () => {
    context.studio().syncPose(); const response = await fetch('/anyangle-studio/portable-scenes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: context.doc(), png: await context.captureGuide() }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '导出失败');
    const archive = await fetch(result.url);
    if (!archive.ok) { const failure = await archive.json().catch(() => ({})); throw new Error(failure.error || `下载场景失败（HTTP ${archive.status}）`); }
    context.downloadBlob(await archive.blob(), 'AnyAngle-scene.zip');
  });
  $('import-scene').onclick = () => $('scene-file').click();
  $('scene-file').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    atomic(async () => {
      const form = new FormData(); form.append('file', file); const response = await fetch('/anyangle-studio/import-scene', { method: 'POST', body: form });
      const result = await response.json(); if (!response.ok) throw new Error(result.error || '导入失败');
      context.replace(result.scene); await context.studio().restore(result.scene); if (result.scene.source.kind === 'human') await context.ensureHumanTools(); context.toast('便携场景已导入，人物和资源已恢复');
    });
  };
  $('export-keypoints').onclick = () => { const json = context.studio().poseJSON(); context.downloadBlob(new Blob([JSON.stringify(json, null, 2)], { type: 'application/json' }), 'AnyAngle-OpenPose.json'); };
  refreshCastTools = installCastTools(context); refreshActorsUI();
}
export function updateActorReferences(value) {
  references = value || []; renderKey = null;
  if (!context) return;
  let updated = false;
  for (const actor of context.doc().actors || []) {
    const reference = references.find(item => item.inputKey === actor.identity.inputKey);
    if (reference?.asset && reference.asset.name !== actor.identity.asset?.name) {
      if (!updated) context.begin(); actor.identity.asset = reference.asset; updated = true;
    }
  }
  if (updated) context.changed(false); refreshActorsUI();
}
export async function selectRole(id, additive = false) {
  await context.run(async () => {
    const doc = context.doc();
    if (additive) doc.selectedActorIds = doc.selectedActorIds?.includes(id) ? doc.selectedActorIds.filter(value => value !== id) : [...doc.selectedActorIds || [], id];
    else doc.selectedActorIds = [id];
    await context.studio().selectActor(id);
    context.refresh();
  });
}
export function refreshActorsUI() {
  if (!context) return;
  refreshCastTools?.();
  const doc = context.doc(), actor = activeActor(doc), human = doc.source.kind === 'human';
  const identity = $('actor-reference').closest('.actor-identity');
  identity.hidden = false;
  for (const element of identity.children) element.hidden = doc.version === 3 && element !== $('actor-description').closest('label');
  $('actor-identities').closest('label').hidden = doc.version === 3;
  const staticGuide = doc.conditioning.promptMode !== 'custom' && ['image', 'canny-image'].includes(guideSource(doc).kind);
  $('actors-panel').classList.toggle('cast-inactive', !human);
  $('read-actor-references').hidden = doc.version === 3 || !references.length;
  const key = JSON.stringify([human, doc.actors?.map(({ id, label, editorColor, visible, locked, identity }) => ({ id, label, editorColor, visible, locked, identity })), doc.activeActorId, doc.selectedActorIds, references]);
  if (key !== renderKey || doc !== renderedDoc || (doc.actors || []).some((role,index) => role !== renderedRoles[index])) {
    renderKey = key; renderedDoc = doc; renderedRoles = (doc.actors || []).slice(); $('actor-list').replaceChildren();
    for (const [index, role] of (doc.actors || []).entries()) {
      const card = document.createElement('div'); card.className = 'actor-card'; card.classList.toggle('active', role.id === doc.activeActorId); card.classList.toggle('selected', doc.selectedActorIds?.includes(role.id)); card.style.setProperty('--actor-color', role.editorColor);
      const choose = button(`${String(index + 1).padStart(2, '0')}  ${role.label}`, event => { if (human) selectRole(role.id, event.ctrlKey || event.metaKey); }); choose.className = 'actor-name';
      const controls = document.createElement('div'); controls.className = 'actor-card-actions';
      controls.append(button(role.visible === false ? '○' : '◉', () => { context.begin(); role.visible = role.visible === false; context.studio().updateActorTransform(role); context.studio().setMode(context.studio().mode); context.changed(); }, role.visible === false ? '显示人物' : '隐藏人物'),
        button(role.locked ? '锁' : '调', () => { context.begin(); role.locked = !role.locked; context.studio().setMode(context.studio().mode); context.changed(false); }, role.locked ? '解锁人物' : '锁定人物'),
        button('↑', () => { context.begin(); moveActor(doc, role.id, -1); context.changed(false); }, '图层向前'), button('↓', () => { context.begin(); moveActor(doc, role.id, 1); context.changed(false); }, '图层向后'));
      card.append(choose, controls); $('actor-list').append(card);
    }
    const selector = $('actor-reference'); selector.innerHTML = '<option value="text">文字描述 · 不用照片</option><option value="upload">上传 / 更换照片…</option><option value="reference">共享左侧原图</option>';
    if (actor?.identity.asset && !actor.identity.inputKey && actor.identity.asset.name !== doc.reference?.name) selector.append(new Option('已上传人物照片', 'asset'));
    for (const ref of references) selector.append(new Option(`${ref.inputKey}${ref.asset ? '' : ' · 未读取'}`, ref.inputKey));
    if (actor?.identity.inputKey && !references.some(ref => ref.inputKey === actor.identity.inputKey)) selector.append(new Option(`${actor.identity.inputKey} · 保存的绑定`, actor.identity.inputKey));
    selector.value = actor?.identity.inputKey || (actor?.identity.asset ? actor.identity.asset.name === doc.reference?.name ? 'reference' : 'asset' : 'text');
  }
  $('actor-count').textContent = `${(doc.actors || []).filter(role => role.visible !== false).length} / ${doc.actors?.length || 0}`;
  $('active-actor-controls').hidden = !actor || !human;
  $('clone-actor').disabled = $('delete-actor').disabled = !actor || !human;
  if (actor) {
    for (const [id, value] of [['actor-label', actor.label], ['actor-color', actor.editorColor], ...['x', 'y', 'z', 'yaw', 'scale'].map(key => [`actor-${key}`, actor.transform[key]]), ['actor-description', actor.identity.description], ['actor-source-person', typeof actor.identity.sourcePerson === 'string' ? actor.identity.sourcePerson : actor.identity.sourcePerson?.description || '']])
      if (document.activeElement !== $(id)) $(id).value = value;
    for (const key of ['x', 'y', 'z', 'yaw', 'scale']) $('actor-'+key).disabled = actor.locked;
    const image = $('actor-reference-preview'); image.hidden = doc.version === 3 || !actor.identity.asset;
    if (actor.identity.asset) image.src = `/anyangle-studio/assets/${encodeURIComponent(actor.identity.asset.name)}`;
    $('actor-binding-state').textContent = staticGuide ? `${doc.reference ? '原图结构模式使用共享原图' : '没有共享原图，当前使用结构图与文字描述'}；人物绑定保留，切回三维引导后生效。`
      : actor.identity.inputKey ? `连线 ${actor.identity.inputKey} · 更新照片不会改变姿势` : actor.identity.asset ? '身份照片已绑定；多人编码节点会读取此照片' : '纯文字身份；不会引用不存在的照片';
  }
  $('actor-plane').value = doc.interaction?.movePlane || 'screen'; $('actor-identities').checked = doc.conditioning.identityMode === 'actors'; $('color-actors').checked = !!doc.conditioning.colorActors;
  $('actor-identities').disabled = staticGuide;
  $('random-scope').value = doc.randomScope || 'current';
  for (const id of ['random-pose', 'repeat-pose']) $(id).disabled = !human || !editableActors(doc, doc.randomScope || 'current').length;
  const templateKey = JSON.stringify(doc.compositionTemplates?.map(item => [item.id, item.name]));
  if ($('composition-list').dataset.key !== templateKey) { $('composition-list').dataset.key = templateKey; $('composition-list').replaceChildren(new Option('选择全场模板', '')); for (const template of doc.compositionTemplates || []) $('composition-list').append(new Option(template.name, template.id)); }
  $('export-keypoints').disabled = !human;
}
export async function randomRoles(seed, category) {
  return editTransaction(async () => {
    const doc = context.doc(), roles = editableActors(doc, doc.randomScope || 'current');
    if (!roles.length) throw new Error('没有可随机的未锁定人物');
    context.studio().syncPose(); const active = doc.activeActorId;
    for (const role of roles) {
      const derived = actorSeed(seed, role.id); role.pose = randomPose(derived, category); role.poseRandom = { seed, derivedSeed: derived, category };
    }
    bindActor(doc, active); doc.randomMaster = { seed, category }; await context.studio().restore(doc); context.studio().useRigPose(); context.showScene(); context.toast(`已更新 ${roles.length} 人姿势 · 主种子 ${seed}`);
  });
}

export async function chooseDetectedPeople(people, asset, options = {}) {
  if (!people?.length) throw new Error('没有识别到可用人物');
  const dialog = $('people-dialog'), choices = $('people-choices'); choices.replaceChildren();
  const image = $('people-photo'), sourceImage = options.reference || asset; image.hidden = !sourceImage;
  if (sourceImage) image.src = `/anyangle-studio/assets/${encodeURIComponent(sourceImage.name)}`;
  const overlay = $('people-overlay'); overlay.replaceChildren();
  for (const [index, person] of people.entries()) {
    const row = document.createElement('label'); row.className = 'person-choice';
    const issue = poseCopyIssue(person.points || {}), usable = !issue;
    const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = index; checkbox.checked = usable; checkbox.disabled = !usable;
    row.append(checkbox, document.createTextNode(`人物 ${index + 1}${!usable ? ` · ${issue}` : person.fullBody === false ? ' · 半身 / 遮挡' : ''}${person.lowConfidence ? ' · 低置信度' : ''}${person.warning ? ` · ${person.warning}` : ''}`)); choices.append(row);
    const box = person.bbox, w = person.canvasWidth || options.reference?.width, h = person.canvasHeight || options.reference?.height;
    if (box && w && h) { const marker = document.createElement('button'); marker.type = 'button'; marker.textContent = String(index + 1); marker.disabled = checkbox.disabled; marker.classList.toggle('excluded', !checkbox.checked); marker.style.cssText = `left:${box[0]/w*100}%;top:${box[1]/h*100}%;width:${(box[2]-box[0])/w*100}%;height:${(box[3]-box[1])/h*100}%`; marker.onclick = () => { if (checkbox.disabled) return; checkbox.checked = !checkbox.checked; marker.classList.toggle('excluded', !checkbox.checked); }; overlay.append(marker); }
  }
  $('people-count').textContent = `${people.length} 人 · 来源骨架已保留，选择下面的复制方式`;
  $('people-bind-photo').checked = false; $('people-match-layout').checked = true;
  $('people-bind-photo').closest('label').hidden = !options.reference;
  dialog.returnValue = ''; dialog.showModal();
  const action = await new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue), { once: true }));
  if (!['current', 'all'].includes(action)) return false;
  const selected = [...choices.querySelectorAll('input:checked')].map(input => people[Number(input.value)]);
  if (!selected.length) throw new Error('请至少选择一人');
  if (action === 'current' && selected.length !== 1) throw new Error('复制到当前人物时请只勾选一人');
  const doc = context.doc(), previous = clone(doc), rollbackHistory = context.begin();
  try {
  context.studio().syncPose(); doc.source = { kind: 'human' }; ensureActors(doc, action === 'current');
  let roles;
  if (action === 'all') {
    roles = selected.map((person, i) => createActor(doc.actors.length + i)); doc.actors.push(...roles);
    if ($('people-match-layout').checked) {
      const fullHeights = selected.filter(person => person.fullBody && person.bbox).map(person => person.bbox[3]-person.bbox[1]).filter(height => height > 0);
      const scale = fullHeights.length ? 20 / Math.max(...fullHeights) : 30 / (selected[0].canvasHeight || options.reference?.height || 1024);
      for (const [i, person] of selected.entries()) { const b = person.bbox, w = person.canvasWidth || options.reference?.width || 1024;
        if (b) { roles[i].transform.x = ((b[0]+b[2])/2 - w/2)*scale; if (person.fullBody) roles[i].transform.scale = Math.max(.25, (b[3]-b[1])*scale/20); }
      }
    }
  } else { roles = [activeActor(doc)]; if (roles[0].locked) throw new Error('当前人物已锁定，请先解锁'); }
  doc.activeActorId = roles[0].id; doc.selectedActorIds = roles.map(role => role.id); bindActor(doc);
  await context.studio().restore(doc); await context.ensureHumanTools();
  const previousActive = roles[0].id;
  for (const [i, role] of roles.entries()) {
    await context.studio().selectActor(role.id); const person = selected[i];
    const mode = person.fullBody === false || person.canEstimate3D === false || ORDER.some(key => !person.points?.[key]) ? 'conservative' : doc.openpose?.retargetMode || 'conservative';
    context.studio().applyOpenPose(person.points, {}, mode);
    role.poseSource = { origin: options.origin || 'dwpose', detectionId: person.id, points: clone(person.points), fullBody: person.fullBody, visibleOnly: person.visibleOnly, retargetMode: mode, rawAsset: asset };
    if ($('people-bind-photo').checked && options.reference) role.identity = { ...role.identity, asset: options.reference, inputKey: null, sourcePerson: { id: person.id, bbox: person.bbox, canvasWidth: person.canvasWidth || options.reference.width, canvasHeight: person.canvasHeight || options.reference.height, description: `person ${people.indexOf(person)+1} in the source photo` } };
    if (doc.version === 3 && $('people-bind-photo').checked && options.reference) {
      let material = doc.referenceLibrary.items.find(item => item.asset?.name === options.reference.name);
      if (!material) material = addReference(doc, options.reference, { label: '合影身份参考', usages: [] });
      const usage = newUse('identity', { kind: 'actors', ids: [role.id], text: '' });
      usage.sourceText = `person ${people.indexOf(person)+1} in the source photo${person.bbox ? `, pixel region [${person.bbox.join(', ')}] in ${person.canvasWidth || options.reference.width} x ${person.canvasHeight || options.reference.height}` : ''}`;
      material.usages.push(usage);
    }
  }
  await context.studio().selectActor(previousActive); doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose'; doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = 'rig';
  if ($('people-bind-photo').checked || action === 'all' && doc.actors.length > 1) { doc.conditioning.identityMode = 'actors'; doc.conditioning.imageOrder = 'guide-first'; }
  if (doc.openpose) doc.openpose.useRig = true;
  if (action === 'all' && $('people-match-layout').checked) { context.studio().groundActors(roles.map(role => role.id)); doc.camera.azimuth = 0; doc.camera.elevation = 0; context.studio().fit(); }
  context.showScene(); context.changed(); context.toast(`已复制 ${roles.length} 人；相机仅在“匹配原图站位”时重设`);
  return true;
  } catch (error) {
    context.replace(previous); rollbackHistory?.();
    try { await context.studio().restore(previous); } catch { /* Keep the original pose-copy error. */ }
    throw error;
  }
}
