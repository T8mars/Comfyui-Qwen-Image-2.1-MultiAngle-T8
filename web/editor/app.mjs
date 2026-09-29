import { StudioScene, defaultScene, PRESETS, assetURL } from './scene.mjs';
import { reconstruct } from './reconstruct.mjs';

const $ = selector => document.querySelector(selector);
const clone = value => structuredClone(value);
const params = new URLSearchParams(location.search);
const embedded = params.has('session') && parent !== window;
const session = params.get('session');
let doc = defaultScene(), studio, revision = 0, busy = true, ready = false;
let undo = [], redo = [], previewTimer, previewRunning = false, selectedBone = '';
let selectedShot = null, snapshot = null;
let humanToolsReady = false;
let linkedReference = { connected: false };
let pendingReference = null;
const controls = new Map();
let poseLibrary;
try { poseLibrary = JSON.parse(localStorage.getItem('anyangle-studio.poses.v1') || '[]'); }
catch { poseLibrary = []; }
if (!Array.isArray(poseLibrary)) poseLibrary = [];

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function error(error) { console.error(error); toast(error?.message || String(error)); }
function setBusy(value) {
  busy = value; $('#workspace').inert = value; $('#apply').disabled = value || !ready || doc.source.kind === 'empty' || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending));
  $('#undo').disabled = value || !undo.length; $('#redo').disabled = value || !redo.length;
  if (!value && pendingReference) queueMicrotask(readPendingReference);
}
async function run(task) {
  if (busy) return;
  setBusy(true);
  try {
    while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
    await task();
  } catch (e) { error(e); }
  finally { setBusy(false); }
}
function begin() {
  if (!ready || studio.restoring) return;
  studio.syncPose();
  const serialized = JSON.stringify(doc);
  if (JSON.stringify(undo.at(-1)) !== serialized) undo.push(clone(doc));
  if (undo.length > 40) undo.shift();
  redo = []; $('#undo').disabled = false; $('#redo').disabled = true;
}
function changed() {
  if (!ready || studio.restoring) return;
  studio.syncPose(); revision++; selectedShot = null;
  document.querySelectorAll('.preset-card.active').forEach(button => button.classList.remove('active'));
  $('#status').textContent = '草稿有更改 · 应用后才会更新节点'; $('#status').dataset.state = 'dirty';
  refresh(); schedulePreview();
}
function schedulePreview() {
  clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 110);
}
async function renderPreview() {
  if (!ready || doc.source.kind === 'empty' || busy) return;
  if (previewRunning) { schedulePreview(); return; }
  previewRunning = true;
  const version = revision;
  try {
    const scale = Math.min(1, 500 / Math.max(doc.width, doc.height));
    const png = await studio.capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
    if (version === revision) $('#guide').src = png;
  } catch (e) { error(e); }
  finally { previewRunning = false; }
}
function refresh() {
  if (studio && (doc.source.kind === 'splat' || doc.source.kind === 'empty') &&
      (studio.mode !== 'camera' || $('#edit-mode').classList.contains('active'))) setMode('camera');
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  for (const control of controls.values()) control.refresh();
  $('#width').value = doc.width; $('#height').value = doc.height;
  $('#background').value = doc.background;
  const ratio = ['1:1', '16:9', '9:16', '4:3'].find(value => { const [w, h] = value.split(':').map(Number); return Math.abs(doc.width / doc.height - w / h) < 0.015; });
  $('#ratio').value = ratio || 'custom';
  $('#guide-size').textContent = `${doc.width} × ${doc.height}`;
  const human = doc.source.kind === 'human';
  const splat = doc.source.kind === 'splat', empty = doc.source.kind === 'empty';
  $('#front').disabled = $('#front-number').disabled = human || splat || empty;
  $('#scale').disabled = $('#scale-number').disabled = splat || empty;
  $('#front').closest('.control').hidden = human || splat || empty;
  $('#scale').closest('.control').hidden = splat || empty;
  $('#calibration-hint').textContent = splat
    ? '原图重建主体与预测机位已对齐，姿势固定。请用拍摄相机调整角度、缩放和构图。'
    : empty ? '连接原图并重建主体，或导入 GLB 后调整场景。'
      : human ? '人偶可调整资产尺度；姿势、手势和关节可在编辑场景中修改。'
        : 'GLB 默认 Y 轴朝上。旋转资产以校准正面；资产尺度与镜头缩放相互独立。';
  $('#asset-label').textContent = empty ? '等待原图重建' : human ? 'MakeHuman · 手动人偶' : doc.source.label || 'GLB 场景';
  $('#source-badge').textContent = empty ? 'PHOTO → 3D' : splat ? 'TRIPOSPLAT · 原图重建' : human ? 'HUMAN · 手动人偶' : 'GLB · 场景';
  for (const id of ['pose-panel', 'hands-panel', 'body-panel', 'joint-panel']) {
    $(`#${id}`).classList.toggle('disabled-panel', !human);
    $(`#${id}`).inert = !human;
    $(`#${id}`).hidden = !human;
  }
  $('#reference').hidden = !doc.reference; $('#reference-empty').hidden = !!doc.reference;
  if (doc.reference) $('#reference').src = assetURL(doc.reference.name);
  $('#reference-button').disabled = $('#reference-drop').disabled = linkedReference.connected;
  $('#read-reference').hidden = !linkedReference.connected;
  $('#read-reference').disabled = !!linkedReference.pending;
  $('#reference-origin').textContent = linkedReference.connected ? linkedReference.message : '支持节点左侧 IMAGE 连线，也可上传原图。';
  $('#reconstruction-state').hidden = !doc.reference;
  $('#reconstruction-state').textContent = splat ? '原图 3D 保持重建姿势，无可编辑骨架；拖动相机改变视角。需要手动摆姿可切换人偶。' : '从原图重建对应主体，再调整机位。';
  $('#reconstruct').disabled = !doc.reference;
  $('#reconstruct').textContent = splat ? '重新载入原图 3D' : '从原图重建 3D';
  $('#empty-scene').hidden = !empty;
  $('#guide').hidden = empty;
  $('#guide-state').textContent = empty ? '生成对应主体后显示新机位粗图。' : '只有画面内容会输出，网格与控制器不会进入粗图。';
  $('#apply').disabled = busy || !ready || empty || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending));
  $('#edit-mode').disabled = splat || empty;
  $('#edit-mode').title = splat ? '原图重建主体没有可编辑骨架；请使用拍摄机位' : empty ? '请先载入三维主体' : '';
  $('#mode-hint').hidden = !splat;
  $('#fit-frame').textContent = splat ? '回到原图机位' : '适合画幅';
  $('.eyebrow').textContent = splat ? '相对于模型预测的原图机位' : '相对于已校准的场景正面';
  $('[data-angle="0"]').textContent = splat ? '原图机位' : '正面';
  $('#bone-name').textContent = selectedBone || '未选择';
  $('#bone-select').value = selectedBone;
  for (const axis of ['x', 'y', 'z']) controls.get(`bone-${axis}`)?.refresh();
}

function makeControl(container, { id, label, min, max, step = 1, unit = '', read, write, commit }) {
  const wrap = document.createElement('div'); wrap.className = 'control';
  const top = document.createElement('div'); top.className = 'control-top';
  const title = document.createElement('label'); title.textContent = label; title.htmlFor = `${id}-number`;
  const value = document.createElement('div'); value.className = 'control-value';
  const number = document.createElement('input'); Object.assign(number, { id: `${id}-number`, type: 'number', min, max, step });
  const suffix = document.createElement('span'); suffix.textContent = unit; value.append(number, suffix); top.append(title, value);
  const range = document.createElement('input'); Object.assign(range, { id, type: 'range', min, max, step }); range.setAttribute('aria-label', label);
  const endpoints = document.createElement('div'); endpoints.className = 'control-range-labels';
  for (const text of [`${min}${unit}`, `${max}${unit}`]) { const span = document.createElement('span'); span.textContent = text; endpoints.append(span); }
  wrap.append(top, range, endpoints); $(container).append(wrap);
  let gesture = false;
  const start = () => { if (!gesture) { begin(); gesture = true; } };
  const update = raw => {
    const input = Number(raw); if (!Number.isFinite(input)) return;
    write(Math.min(max, Math.max(min, input))); changed();
  };
  range.oninput = () => { start(); update(range.value); };
  range.onchange = () => { gesture = false; if (commit) run(async () => { await commit(); changed(); }); };
  number.oninput = () => { if (number.value === '' || !Number.isFinite(number.valueAsNumber)) return; start(); update(number.value); };
  number.onblur = () => {
    const edited = gesture; gesture = false;
    if (edited && commit) run(async () => { await commit(); changed(); });
    control.refresh();
  };
  const control = { refresh() { const v = Number(read()); range.value = v; if (document.activeElement !== number) number.value = Number(v.toFixed(step < 1 ? 2 : 1)); } };
  controls.set(id, control); control.refresh();
}

for (const [key, label, min, max, step, unit] of [
  ['azimuth', '方位角', -180, 180, 0.1, '°'], ['elevation', '俯仰角', -89, 89, 0.1, '°'],
  ['zoom', '构图缩放', 0.1, 8, 0.01, '×'],
]) makeControl('#camera-sliders', { id: key, label, min, max, step, unit,
  read: () => doc.camera[key], write: value => { doc.camera[key] = value; studio.updateShot(); } });
for (const [key, label, min, max, step] of [
  ['age', '年龄', 18, 75, 1], ['gender', '体型特征', 0, 1, 0.01], ['weight', '体重', 0, 1, 0.01], ['muscle', '肌肉', 0, 1, 0.01], ['height', '身高', 0, 1, 0.01],
]) makeControl('#body-sliders', { id: `body-${key}`, label, min, max, step,
  read: () => doc.mesh[key], write: value => { doc.mesh[key] = value; }, commit: () => studio.morph() });
for (const axis of ['x', 'y', 'z']) makeControl('#bone-sliders', { id: `bone-${axis}`, label: `旋转 ${axis.toUpperCase()}`, min: -180, max: 180, step: 1, unit: '°',
  read: () => (studio?.viewer.bones[selectedBone]?.rotation[axis] || 0) * 180 / Math.PI,
  write: value => {
    const bone = studio.viewer.bones[selectedBone]; if (!bone) return;
    bone.rotation[axis] = value * Math.PI / 180; bone.updateMatrixWorld(true);
    studio.viewer.updateIKEffectorPositions(); studio.viewer.updateMarkers(); studio.viewer.requestRender();
  } });
for (const [key, label, min, max, step, unit] of [['front', 'GLB 正面校准', -180, 180, 1, '°'], ['scale', '资产尺度', 0.25, 3, 0.01, '×']]) {
  makeControl('#scene-sliders', { id: key, label, min, max, step, unit, read: () => doc[key], write: value => { doc[key] = value; }, commit: async () => { studio.syncPose(); await studio.restore(doc); } });
}
for (const [key, label] of [['offsetX', '构图水平偏移'], ['offsetY', '构图垂直偏移']]) {
  makeControl('#scene-sliders', { id: key, label, min: -20, max: 20, step: 0.01,
    read: () => doc.camera[key], write: value => { doc.camera[key] = value; studio.updateShot(); } });
}

for (const [side, label] of [['l', '左手'], ['r', '右手']]) {
  const row = document.createElement('div'); row.className = 'hand-row';
  const title = document.createElement('h3'); title.textContent = label;
  const buttons = document.createElement('div'); buttons.className = 'three-buttons';
  for (const [key, text] of [['OPEN', '放松'], ['CHOP', '并拢'], ['FIST', '握拳']]) {
    const button = document.createElement('button'); button.textContent = text;
    button.onclick = () => { begin(); studio.hand(side, key); changed(); }; buttons.append(button);
  }
  row.append(title, buttons); $('#hands').append(row);
}

function setMode(mode) {
  studio.setMode(mode);
  $('#camera-mode').classList.toggle('active', mode === 'camera'); $('#edit-mode').classList.toggle('active', mode === 'edit');
  $('#camera-mode').setAttribute('aria-pressed', String(mode === 'camera')); $('#edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  $('#use-view').hidden = mode !== 'edit';
  $('#stage-help').textContent = mode === 'camera' ? '拖动调整拍摄机位 · Shift 平移 · 滚轮缩放' : '点选关节 / 拖 IK 手脚 · 右键环绕 · 中键平移 · 拍摄机位保持不变';
}
$('#camera-mode').onclick = () => setMode('camera'); $('#edit-mode').onclick = () => setMode('edit');
$('#use-view').onclick = () => { begin(); studio.currentViewAsShot(); setMode('camera'); changed(); };
$('#fit-frame').onclick = () => { begin(); studio.fit(); changed(); };
document.querySelectorAll('[data-angle]').forEach(button => { button.onclick = () => { begin(); doc.camera.azimuth = Number(button.dataset.angle); doc.camera.elevation = 0; studio.updateShot(); changed(); }; });
$('#reset-camera').onclick = () => { begin(); doc.camera = doc.source.kind === 'splat' ? referenceCamera() : defaultScene().camera; studio.updateShot(true); changed(); };
$('#bone-select').onchange = event => { selectedBone = event.target.value; studio.viewer.selectBoneByName(selectedBone); refresh(); };
$('#reset-bone').onclick = () => { if (!selectedBone) return; begin(); studio.viewer.resetSelectedBone(); changed(); };
function dimensions(width, height) { begin(); doc.width = Math.round(Math.max(64, Math.min(4096, width))); doc.height = Math.round(Math.max(64, Math.min(4096, height))); studio.updateShot(); changed(); }
$('#width').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(value, doc.height); };
$('#height').oninput = event => { const value = Number(event.target.value); if (Number.isFinite(value) && value >= 64 && value <= 4096) dimensions(doc.width, value); };
$('#ratio').onchange = event => {
  if (event.target.value === 'custom') return;
  const [a, b] = event.target.value.split(':').map(Number); const long = Math.max(doc.width, doc.height);
  dimensions(a >= b ? long : Math.round(long * a / b / 32) * 32, a >= b ? Math.round(long * b / a / 32) * 32 : long);
};
$('#background').onchange = event => { begin(); doc.background = event.target.value; changed(); };
async function undoRedo(source, target) {
  if (!source.length) return;
  studio.syncPose(); target.push(clone(doc)); doc = source.pop();
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  if (doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
  await studio.restore(doc); changed(); renderShots(); refresh();
}
$('#undo').onclick = () => run(() => undoRedo(undo, redo)); $('#redo').onclick = () => run(() => undoRedo(redo, undo));
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select') || busy) return;
  if (event.key === 'Escape' && studio.cancelDrag()) { event.preventDefault(); return; }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('#redo') : $('#undo')).click(); }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); $('#redo').click(); }
  }
});

async function upload(file) {
  const form = new FormData(); form.append('file', file);
  const response = await fetch('/anyangle-studio/assets', { method: 'POST', body: form });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '导入失败'); return result;
}
$('#reference-button').onclick = $('#reference-drop').onclick = () => $('#reference-file').click();
$('#read-reference').onclick = () => {
  linkedReference = { ...linkedReference, connected: true, pending: true, message: '正在读取上游图像…' };
  refresh(); send('anyangle-read-reference');
};
$('#reference-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const asset = await upload(file);
  begin(); doc.reference = asset; doc.source = { kind: 'empty' }; await studio.restore(doc); changed();
  await reconstructPhoto();
});
const referenceCamera = () => ({ azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 });
async function reconstructPhoto() {
  if (!doc.reference) return;
  clearTimeout(previewTimer);
  while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
  const reference = clone(doc.reference);
  const previous = clone(doc);
  $('#loading').hidden = false;
  $('#loading-text').textContent = '准备从原图重建主体';
  $('#loading-detail').textContent = '本地 TripoSplat · 去背景 → 三维重建 → 对齐参考机位';
  try {
    const source = await reconstruct(reference, text => { $('#loading-text').textContent = text; });
    if (doc.reference?.name !== reference.name) throw new Error('原图已改变，请重新重建');
    begin();
    if (doc.source.name !== source.name) doc.shots = [];
    doc.source = source; doc.front = 0; doc.scale = 1; doc.camera = referenceCamera();
    const outputScale = Math.min(1, 1536 / Math.max(reference.width, reference.height));
    doc.width = Math.round(reference.width * outputScale); doc.height = Math.round(reference.height * outputScale);
    $('#loading-text').textContent = '载入三维主体和参考机位';
    await studio.restore(doc); changed(); renderShots();
    $('#status').textContent = '原图三维重建已载入 · 拖动调整机位后应用';
  } catch (e) {
    doc = previous;
    await studio.restore(doc);
    $('#status').textContent = '原图重建未完成 · 可重试'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#reconstruct').onclick = () => run(reconstructPhoto);
$('#import-glb').onclick = () => $('#glb-file').click();
$('#glb-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const asset = await upload(file); begin();
  const previous = clone(doc); doc.source = { kind: 'glb', ...asset }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
  try { await studio.restore(doc); studio.fit(); } catch (e) { doc = previous; await studio.restore(doc); throw e; }
  changed(); toast('GLB 已载入。可在场景与构图中调整正面与尺度。');
});
$('#human').onclick = () => run(async () => {
  begin();
  const previous = clone(doc);
  doc.source = { kind: 'human' }; doc.front = 0; doc.scale = 1;
  try { await studio.restore(doc); await ensureHumanTools(); }
  catch (e) { doc = previous; await studio.restore(doc); throw e; }
  changed();
});

function askName(title, initial) {
  $('#name-title').textContent = title; $('#name-input').value = initial;
  $('#name-dialog').showModal(); $('#name-input').select();
  return new Promise(resolve => { $('#name-dialog').addEventListener('close', () => resolve($('#name-dialog').returnValue === 'ok' ? $('#name-input').value.trim() : null), { once: true }); });
}
function iconButton(icon, label) { const button = document.createElement('button'); button.className = 'icon-button'; button.title = label; button.setAttribute('aria-label', label); const image = document.createElement('img'); image.src = `../icons/${icon}.svg`; image.alt = ''; button.append(image); return button; }
function renderShots() {
  $('#shots').replaceChildren(); $('#shot-count').textContent = String(doc.shots.length);
  if (!doc.shots.length) { const note = document.createElement('p'); note.className = 'empty-note'; note.textContent = '把满意的机位留在这里。切换收藏只改变相机，姿势保持当前状态。'; $('#shots').append(note); }
  for (const shot of doc.shots) {
    const item = document.createElement('div'); item.className = 'shot';
    const thumb = document.createElement('button'); thumb.className = 'shot-thumb'; thumb.classList.toggle('active', selectedShot === shot.id); thumb.title = `应用机位 ${shot.name}`;
    const image = document.createElement('img'); image.src = shot.thumbnail; image.alt = shot.name; thumb.append(image);
    thumb.onclick = () => { begin(); doc.camera = clone(shot.camera); doc.width = shot.width; doc.height = shot.height; studio.updateShot(); changed(); selectedShot = shot.id; renderShots(); };
    const caption = document.createElement('div'); caption.className = 'shot-caption';
    const rename = document.createElement('button'); rename.className = 'rename'; rename.textContent = shot.name; rename.title = '重命名机位';
    rename.onclick = async () => { const name = await askName('重命名机位', shot.name); if (name) { begin(); shot.name = name; changed(); renderShots(); } };
    const remove = iconButton('trash', `删除机位 ${shot.name}`); remove.onclick = () => { begin(); doc.shots = doc.shots.filter(s => s.id !== shot.id); changed(); renderShots(); };
    caption.append(rename, remove); item.append(thumb, caption); $('#shots').append(item);
  }
}
$('#save-shot').onclick = async () => {
  const name = await askName('收藏当前机位', `机位 ${doc.shots.length + 1}`); if (!name) return;
  run(async () => { begin(); const scale = 230 / Math.max(doc.width, doc.height); const thumbnail = await studio.capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
    const shot = { id: crypto.randomUUID(), name, camera: clone(doc.camera), width: doc.width, height: doc.height, thumbnail };
    doc.shots.push(shot); changed(); selectedShot = shot.id; renderShots();
  });
};

function saveLibrary() { localStorage.setItem('anyangle-studio.poses.v1', JSON.stringify(poseLibrary)); renderLibrary(); }
function renderLibrary() {
  $('#saved-poses').replaceChildren();
  for (const pose of poseLibrary) {
    const row = document.createElement('div'); row.className = 'saved-row';
    const button = document.createElement('button'); button.textContent = pose.name;
    button.onclick = () => run(async () => { begin(); doc.mesh = clone(pose.mesh); doc.pose = clone(pose.pose); await studio.restore(doc); changed(); });
    const remove = iconButton('trash', `删除姿势 ${pose.name}`); remove.onclick = () => { poseLibrary = poseLibrary.filter(p => p.id !== pose.id); saveLibrary(); };
    row.append(button, remove); $('#saved-poses').append(row);
  }
}
$('#save-pose').onclick = async () => {
  const name = await askName('保存姿势', `姿势 ${poseLibrary.length + 1}`); if (!name) return;
  poseLibrary.push({ id: crypto.randomUUID(), name, mesh: clone(doc.mesh), pose: studio.pose() });
  try { saveLibrary(); toast('姿势已保存到当前浏览器'); } catch (e) { error(e); }
};
function download(data, name) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#export-pose').onclick = () => run(async () => {
  const response = await fetch('/anyangle-studio/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, kind: 'anyangle-pose', mesh: doc.mesh, pose: studio.pose() }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '姿势导出失败');
  download(`/anyangle-studio/poses/${encodeURIComponent(result.id)}`, 'anyangle-pose.json');
});
$('#import-pose').onclick = () => $('#pose-file').click();
$('#pose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const imported = JSON.parse(await file.text());
  if (imported.version !== 1 || imported.kind !== 'anyangle-pose' || !imported.pose?.bones) throw new Error('请选择本编辑器导出的姿势 JSON');
  for (const values of Object.values(imported.pose.bones)) if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) throw new Error('姿势包含无效的骨骼旋转');
  if (!imported.mesh || typeof imported.mesh !== 'object' || Array.isArray(imported.mesh)) throw new Error('姿势包含无效的体型参数');
  const previous = clone(doc);
  begin(); doc.mesh = { ...defaultScene().mesh, ...imported.mesh, breast_size: 0, show_genitals: false }; doc.pose = imported.pose;
  try { await studio.restore(doc); changed(); }
  catch (e) { doc = previous; await studio.restore(doc); throw e; }
});
$('#download-guide').onclick = () => run(async () => {
  const png = await studio.capture();
  const blob = await (await fetch(png)).blob();
  const asset = await upload(new File([blob], 'anyangle-guide.png', { type: 'image/png' }));
  download(assetURL(asset.name), 'anyangle-guide.png');
  toast('粗图 PNG 已导出');
});

function send(type, payload = {}) { parent.postMessage({ type, session, ...payload }, location.origin); }
$('#cancel').onclick = () => { if (embedded) send('anyangle-close'); else location.reload(); };
$('#apply').onclick = () => run(async () => {
  clearTimeout(previewTimer); studio.syncPose();
  const frozen = clone(doc), appliedRevision = revision;
  const png = await studio.capture();
  const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scene: frozen, png }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '保存失败');
  if (revision !== appliedRevision) throw new Error('场景在保存时发生变化，请重新应用');
  snapshot = result;
  if (embedded) send('anyangle-apply', { snapshot: result, revision: appliedRevision });
  else { const url = new URL(location.href); url.searchParams.set('snapshot', result.id); history.replaceState(null, '', url); toast('已保存快照，可在 ComfyUI 节点中载入该场景'); }
  $('#status').textContent = embedded ? '快照已保存 · 正在应用到节点' : '场景快照已保存'; $('#status').dataset.state = embedded ? 'dirty' : 'saved';
});

async function buildPresetCards() {
  const working = studio.doc;
  const savedPose = studio.pose(); const savedCamera = clone(working.camera); const mode = studio.mode;
  studio.restoring = true;
  $('#presets').replaceChildren();
  try {
    for (const preset of PRESETS) {
      studio.setPreset(preset); working.camera = { azimuth: 25, elevation: 3, zoom: 1.1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      studio.updateShot();
      const png = await studio.capture(150, 170);
      const button = document.createElement('button'); button.className = 'preset-card';
      const image = document.createElement('img'); image.src = png; image.alt = '';
      const label = document.createElement('span'); label.textContent = preset.name; button.append(image, label);
      button.onclick = () => { begin(); studio.setPreset(preset); changed(); document.querySelectorAll('.preset-card').forEach(b => b.classList.toggle('active', b === button)); };
      $('#presets').append(button);
    }
  } finally { studio.viewer.setPose(savedPose, true); working.pose = savedPose; working.camera = savedCamera; studio.setMode(mode); studio.restoring = false; }
}

async function ensureHumanTools() {
  if (humanToolsReady) return;
  // Pose thumbnails require the human rig; never load it just to open a photo scene.
  await buildPresetCards();
  for (const bone of studio.viewer.boneList) {
    const option = document.createElement('option'); option.value = bone.name; option.textContent = bone.name;
    $('#bone-select').append(option);
  }
  humanToolsReady = true;
}

async function start(token, reference = { connected: false }) {
  try {
    if (token?.id) {
      const response = await fetch(`/anyangle-studio/snapshots/${encodeURIComponent(token.id)}`);
      const saved = await response.json(); if (!response.ok) throw new Error(saved.error || '读取快照失败');
      doc = saved.scene; snapshot = token;
    }
    linkedReference = reference;
    const referenceChanged = reference.connected && reference.asset?.name !== doc.reference?.name;
    if (reference.connected) doc.reference = reference.asset || null;
    if (doc.reference && (doc.source.kind === 'human' || (doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference.name))) doc.source = { kind: 'empty' };
    studio = new StudioScene($('#viewport'), { begin, change: changed, camera: () => { revision++; refresh(); schedulePreview(); $('#status').textContent = '机位草稿 · 尚未应用'; $('#status').dataset.state = 'dirty'; }, select: name => { selectedBone = name || ''; refresh(); }, error });
    await studio.init(doc);
    if (doc.source.kind === 'human') await ensureHumanTools();
    selectedShot = doc.shots.find(shot => shot.width === doc.width && shot.height === doc.height
      && Object.keys(doc.camera).every(key => Number(shot.camera[key] || 0) === Number(doc.camera[key] || 0)))?.id || null;
    ready = true; $('#loading').hidden = true; refresh(); renderShots(); renderLibrary();
    $('#status').textContent = snapshot ? '已载入上次应用的场景' : '连接或上传原图，重建对应的三维主体';
    $('#status').dataset.state = snapshot ? 'saved' : 'dirty';
    if (referenceChanged) { $('#status').textContent = '连线原图已更新 · 应用后保存到场景'; $('#status').dataset.state = 'dirty'; }
    setBusy(false); await renderPreview();
    if (doc.reference && doc.source.kind === 'empty') await run(reconstructPhoto);
  } catch (e) { $('#loading-text').textContent = e.message || String(e); error(e); }
}
function readPendingReference() {
  if (busy || !pendingReference) return;
  const reference = pendingReference; pendingReference = null;
  run(async () => {
    const sameAsset = !!reference.asset && reference.asset.name === doc.reference?.name;
    linkedReference = reference;
    if (reference.error) toast(reference.error);
    if (sameAsset) { refresh(); return; }
    begin(); doc.reference = reference.asset || null;
    doc.source = { kind: 'empty' }; await studio.restore(doc); changed();
    if (doc.reference) await reconstructPhoto();
  });
}
if (embedded) {
  let started = false;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.session !== session) return;
    if (event.data.type === 'anyangle-load' && !started) {
      started = true; start(event.data.snapshot, event.data.reference);
    } else if (event.data.type === 'anyangle-reference' && ready) {
      pendingReference = event.data.reference; readPendingReference();
    } else if (event.data.type === 'anyangle-apply-error') {
      $('#status').textContent = '尚未应用到节点'; $('#status').dataset.state = 'dirty'; toast(event.data.message);
    }
  });
  send('anyangle-ready');
} else {
  $('#apply').lastChild.textContent = '保存场景'; $('#cancel').textContent = '重载';
  start(params.has('snapshot') ? { version: 1, id: params.get('snapshot') } : null);
}
window.addEventListener('pagehide', () => { clearTimeout(previewTimer); studio?.dispose(); });
