import { StudioScene, defaultScene, PRESETS, assetURL } from './scene.mjs?v=20260930h';
import { reconstruct } from './reconstruct.mjs';
import { readSkeletonImage } from './openpose.mjs';
import { GUIDE_LABELS, guidePrompt, guideSource, cannyEdges } from './guides.mjs?v=20260930g';

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
let linkedStructure = { connected: false };
let unwiredAnyAngle = false;
let pendingReference = null;
let pendingStructure = null;
let explicitStructureRead = false;
let overlayShown = false;
let previewVisible = false, previewGuide = null, previewRevision = -1;
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
function currentGuide() { return doc.conditioning.model === 'anyangle' ? 'coarse' : doc.conditioning.guide; }
function usesLocalGuide(guide = currentGuide()) {
  return guide === 'pose' && doc.openpose?.origin === 'dwpose'
    || guide === 'depth' && doc.conditioning.mapOrigin === 'da3'
    || guide === 'canny' && ['auto', 'reference'].includes(doc.conditioning.mapOrigin);
}
function hasGuide() {
  const guide = currentGuide();
  if (linkedStructure.connected && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(guide)
      && !usesLocalGuide(guide)
      && (!linkedStructure.asset || linkedStructure.pending)) return false;
  const source = guideSource(doc);
  return source.kind === 'image' || source.kind === 'canny-image' || source.kind === 'canny-scene'
    || source.kind === 'pose' && doc.source.kind === 'human' || source.kind === 'scene' && doc.source.kind !== 'empty';
}
function setBusy(value) {
  busy = value; $('#workspace').inert = value; $('#apply').disabled = value || !ready || !hasGuide()
    || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending))
    || (linkedStructure.connected && !!linkedStructure.pending && !usesLocalGuide());
  $('#undo').disabled = value || !undo.length; $('#redo').disabled = value || !redo.length;
  if (!value && pendingReference) queueMicrotask(readPendingReference);
  if (!value && pendingStructure) queueMicrotask(readPendingStructure);
}
async function run(task) {
  if (busy) return;
  setBusy(true);
  try {
    while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
    await task();
  } catch (e) { error(e); }
  finally { setBusy(false); await renderPreview(); }
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
  document.querySelectorAll('.shot-thumb.active').forEach(button => button.classList.remove('active'));
  $('#status').textContent = '草稿有更改 · 应用后才会更新节点'; $('#status').dataset.state = 'dirty';
  refresh(); schedulePreview();
}
function schedulePreview() {
  clearTimeout(previewTimer); previewTimer = setTimeout(renderPreview, 110);
}
async function imageCanvas(source, width, height) {
  const image = new Image(); image.src = source; await image.decode();
  const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
  const scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
  const w = image.naturalWidth * scale, h = image.naturalHeight * scale;
  context.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  return canvas;
}
async function captureGuide(width = doc.width, height = doc.height) {
  const input = guideSource(doc);
  if (input.kind === 'pose') return studio.captureOpenPose(width, height);
  if (input.kind === 'image') return (await imageCanvas(assetURL(input.asset.name), width, height)).toDataURL('image/png');
  if (input.kind === 'missing') throw new Error('请先生成、导入或连接当前引导图');
  if (input.kind === 'scene') return studio.capture(width, height);
  const source = input.kind === 'canny-image' ? assetURL(input.asset.name) : await studio.capture(width, height);
  const decoded = new Image(); decoded.src = source; await decoded.decode();
  const scale = Math.min(1, 1536 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
  const workWidth = Math.max(1, Math.round(decoded.naturalWidth * scale)), workHeight = Math.max(1, Math.round(decoded.naturalHeight * scale));
  const work = await imageCanvas(source, workWidth, workHeight);
  const context = work.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, workWidth, workHeight);
  pixels.data.set(cannyEdges(pixels.data, workWidth, workHeight, doc.conditioning.cannyLow, doc.conditioning.cannyHigh));
  context.putImageData(pixels, 0, 0);
  if (workWidth === width && workHeight === height) return work.toDataURL('image/png');
  return (await imageCanvas(work.toDataURL('image/png'), width, height)).toDataURL('image/png');
}
async function renderPreview() {
  if (!ready || !hasGuide() || busy) return;
  if (previewRunning) { schedulePreview(); return; }
  previewRunning = true;
  const version = revision;
  try {
    const scale = Math.min(1, 500 / Math.max(doc.width, doc.height));
    const png = await captureGuide(Math.round(doc.width * scale), Math.round(doc.height * scale));
    if (version === revision) {
      $('#guide').src = $('#stage-guide').src = png;
      previewRevision = version; refresh();
    }
  } catch (e) { $('#stage-guide-message').textContent = e.message || '预览生成失败，请重试'; error(e); }
  finally { previewRunning = false; }
}
function refresh() {
  if (studio && (doc.source.kind === 'splat' || doc.source.kind === 'empty') &&
      (studio.mode !== 'camera' || $('#edit-mode').classList.contains('active'))) setMode('camera');
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  const guide = currentGuide(), base = doc.conditioning.model === 'base', input = guideSource(doc);
  const staticGuide = input.kind === 'image' || input.kind === 'canny-image';
  const poseImage = guide === 'pose' && input.kind === 'image';
  if (previewGuide !== guide) { previewGuide = guide; previewVisible = guide !== 'coarse'; }
  $('#stage').classList.toggle('previewing-guide', previewVisible);
  $('#stage-guide-view').hidden = !previewVisible;
  $('#stage-guide-title').textContent = GUIDE_LABELS[guide];
  $('#stage-guide-detail').textContent = `实际输出 · image_2 · ${doc.width} × ${doc.height}`;
  $('#stage-guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#stage-guide-empty').hidden = hasGuide() && previewRevision === revision;
  $('#stage-guide-message').textContent = hasGuide() ? '正在生成引导图预览…'
    : guide === 'coarse' ? '先从原图重建三维主体' : '请在右侧生成或导入引导图';
  $('#view-detail').textContent = previewVisible ? `${GUIDE_LABELS[guide]} · 实际输出` : '三维工作台 · 调整机位与姿势';
  for (const [id, active] of [['view-output', previewVisible], ['view-scene', !previewVisible]]) {
    $(`#${id}`).classList.toggle('active', active); $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#view-scene').hidden = staticGuide || guide === 'depth';
  $('#view-scene').disabled = doc.source.kind === 'empty';
  for (const id of ['camera-heading', 'camera-eyebrow', 'camera-sliders', 'view-presets', 'shot-shelf', 'scene-panel']) $(`#${id}`).hidden = staticGuide;
  $('#stage-help').textContent = previewVisible ? staticGuide ? '原图结构与构图 · 应用到节点后输出当前引导图' : '当前三维机位的引导图 · 切换 3D 工作台调整机位'
    : studio?.mode === 'edit' ? '点选关节 / 拖 IK 手脚 · 右键环绕 · 中键平移'
      : '拖动调整拍摄机位 · 中键或 Shift 平移 · 滚轮缩放';
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
    $(`#${id}`).hidden = !human || staticGuide;
  }
  $('#reference').hidden = !doc.reference; $('#reference-empty').hidden = !!doc.reference;
  if (doc.reference) $('#reference').src = assetURL(doc.reference.name);
  $('#reference-overlay-toggle').disabled = !doc.reference;
  $('#reference-overlay-toggle').classList.toggle('active', overlayShown && !!doc.reference);
  $('#reference-overlay').hidden = !overlayShown || !doc.reference;
  if (doc.reference) $('#reference-overlay').src = assetURL(doc.reference.name);
  $('#reference-button').disabled = $('#reference-drop').disabled = linkedReference.connected;
  $('#read-reference').hidden = !linkedReference.connected;
  $('#read-reference').disabled = !!linkedReference.pending;
  $('#reference-origin').textContent = linkedReference.connected ? linkedReference.message : '支持节点左侧 IMAGE 连线，也可上传原图。';
  $('#reconstruction-state').hidden = !doc.reference;
  $('#reconstruction-state').textContent = splat ? '原图 3D 保持重建姿势，无可编辑骨架；拖动相机改变视角。需要手动摆姿可切换人偶。' : '从原图重建对应主体，再调整机位。';
  $('#reconstruct').disabled = !doc.reference;
  $('#reconstruct').textContent = splat ? '重新载入原图 3D' : '从原图重建 3D';
  $('#empty-scene').hidden = !empty;
  $('#coarse-inputs').hidden = guide !== 'coarse';
  $('#extract-coarse').disabled = !doc.reference || !!linkedReference.pending;
  $('#preview-coarse').disabled = empty;
  $('#coarse-status').textContent = splat ? '原图三维主体已就绪，可预览或调整新机位。'
    : human ? '当前场景是手动人偶；重建原图后可生成对应主体的粗图。'
      : empty ? '先从原图重建三维主体，再输出拍摄机位粗图。' : '当前 GLB 场景可直接渲染粗图。';
  $('#model-anyangle').classList.toggle('active', !base); $('#model-base').classList.toggle('active', base);
  $('#model-badge').textContent = base ? 'QWEN 2.1' : 'ANYANGLE';
  document.querySelectorAll('[data-guide]').forEach(button => {
    button.classList.toggle('active', button.dataset.guide === guide);
    button.setAttribute('aria-pressed', String(button.dataset.guide === guide));
  });
  $('#openpose-panel').hidden = !base || guide !== 'pose';
  $('#extract-pose').disabled = !doc.reference || !!linkedReference.pending;
  $('#map-inputs').hidden = !base || !['depth', 'canny'].includes(guide);
  $('#extract-depth').hidden = guide !== 'depth';
  $('#extract-depth').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-canny').hidden = guide !== 'canny';
  $('#generate-canny').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-scene-canny').hidden = guide !== 'canny';
  $('#generate-scene-canny').disabled = empty;
  $('#import-map').textContent = guide === 'depth' ? '导入 Depth Anything 图' : '导入 Canny 图';
  $('#read-map').hidden = !linkedStructure.connected;
  $('#read-map').disabled = !!linkedStructure.pending;
  $('#import-map').disabled = linkedStructure.connected;
  $('#map-status').textContent = guide === 'depth' && doc.conditioning.mapOrigin === 'da3' && doc.conditioning.map ? '已从原图估计深度；对应原机位。'
    : guide === 'canny' && input.kind === 'canny-image' ? '当前输出原图 Canny 轮廓。'
    : guide === 'canny' && input.kind === 'canny-scene' ? '当前输出三维机位 Canny 轮廓。'
    : linkedStructure.connected ? linkedStructure.message || '结构图已连接'
    : doc.conditioning.map && doc.conditioning.mapKind === guide ? `已导入 ${doc.conditioning.map.label || GUIDE_LABELS[guide]}`
      : guide === 'depth' ? '可从原图直接估计，也可接入深度 IMAGE 或导入 PNG。'
        : '可从原图或三维机位生成，也可导入外部 Canny 图。';
  $('#canny-options').hidden = !base || guide !== 'canny' || !!doc.conditioning.map;
  $('#canny-low').value = doc.conditioning.cannyLow; $('#canny-high').value = doc.conditioning.cannyHigh;
  $('#guide-explanation').textContent = !base ? '同一场景的新机位粗图，配合 AnyAngle LoRA 使用。'
    : guide === 'depth' ? '深度图决定空间层次；从原图估计的深度仍对应原机位。'
      : guide === 'pose' ? poseImage ? '输出原图可见骨架，中央预览与节点输出一致。' : '输出三维人偶在当前机位的骨架，可调整姿势与相机。'
        : guide === 'canny' ? '中央显示实际轮廓图；阈值调整会直接更新边缘。'
          : '底模参考粗图，机位遵循程度需实测。';
  $('#guide-heading').innerHTML = `${GUIDE_LABELS[guide]} <small>· image_2</small>`;
  $('#prompt-preview').textContent = guidePrompt(doc.conditioning);
  $('#lora-hint').textContent = base ? 'LoRA 强度输出 0 → 使用底模' : 'LoRA 强度输出 1 → AnyAngle';
  $('#protocol-hint').textContent = base && unwiredAnyAngle ? '当前工作流的 AnyAngle LoRA 强度仍固定。请连接 Studio 的强度输出，或移除 LoRA 加载器。'
    : base ? '底模将结构图作为第二张参考图理解；姿势、深度和轮廓的遵循程度需实测。'
    : 'AnyAngle 必须使用当前机位粗图。请把 LoRA 强度输出接至模型加载器。';
  $('#protocol-hint').classList.toggle('wiring-warning', base && unwiredAnyAngle);
  $('#openpose-status').textContent = doc.openpose ? poseImage ? doc.openpose.fullBody === false
    ? '已提取可见骨架；半身或遮挡照片直接输出原图姿势。' : '已生成原图骨架；可直接输出或选择三维编辑。'
    : '当前输出三维人偶骨架 · 可调整姿势与机位。' : '可提取原图或导入骨架；当前人偶可手动摆姿。';
  $('#retarget-pose').hidden = !poseImage;
  $('#retarget-pose').disabled = doc.openpose?.origin === 'dwpose' && doc.openpose?.fullBody === false;
  $('#retarget-pose').title = $('#retarget-pose').disabled ? '三维人偶编辑需要可见的全身骨架' : '';
  $('#pose-original').hidden = !doc.openpose?.rawAsset || poseImage;
  $('#pose-flips').hidden = !doc.openpose || poseImage;
  document.querySelectorAll('[data-flip]').forEach(button => button.classList.toggle('on', !!doc.openpose?.flips?.[button.dataset.flip]));
  $('#read-openpose').hidden = !linkedStructure.connected;
  $('#read-openpose').disabled = !!linkedStructure.pending;
  $('#guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#guide-state').textContent = !hasGuide() ? guide === 'pose' ? '先连接原图提取姿势，或导入 OpenPose 图。'
    : guide === 'depth' ? '先从原图估计深度，或导入、连接深度图。'
      : guide === 'canny' ? '请连接原图或载入三维主体，也可导入 Canny 图。'
        : '请先载入三维主体。'
    : guide === 'coarse' ? '网格与控制器不会进入粗图。' : '预览即将输出到 image_2 的实际引导图。';
  $('#save-shot').disabled = $('#fit-frame').disabled = empty;
  $('#download-guide').disabled = !hasGuide();
  $('#apply').disabled = busy || !ready || !hasGuide() || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending))
    || (linkedStructure.connected && !!linkedStructure.pending && !usesLocalGuide(guide));
  $('#edit-mode').disabled = splat || empty;
  $('#edit-mode').title = splat ? '原图重建主体没有可编辑骨架；请使用拍摄机位' : empty ? '请先载入三维主体' : '';
  $('#mode-hint').hidden = !splat;
  $('#fit-frame').textContent = splat ? '回到原图机位' : '适合画幅';
  $('.eyebrow').textContent = `${splat ? '原图预测机位' : '场景正面'} · Y-UP · 透视`;
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
  mode = studio.mode;
  $('#camera-mode').classList.toggle('active', mode === 'camera'); $('#edit-mode').classList.toggle('active', mode === 'edit');
  $('#camera-mode').setAttribute('aria-pressed', String(mode === 'camera')); $('#edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  $('#use-view').hidden = mode !== 'edit';
  $('#stage-help').textContent = mode === 'camera' ? '拖动调整拍摄机位 · 中键或 Shift 平移 · 滚轮缩放'
    : doc.source.kind === 'human' ? '点选关节 / 拖 IK 手脚 · 右键环绕 · 中键平移 · 拍摄机位保持不变'
      : '右键环绕 · 中键平移 · 可将当前视图设为机位';
}
$('#view-output').onclick = () => { previewVisible = true; refresh(); schedulePreview(); };
$('#view-scene').onclick = () => { previewVisible = false; setMode(studio.mode); refresh(); };
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
$('#model-anyangle').onclick = () => { if (doc.conditioning.model === 'anyangle') return; begin(); doc.conditioning.model = 'anyangle'; changed(); };
$('#model-base').onclick = () => { if (doc.conditioning.model === 'base') return; begin(); doc.conditioning.model = 'base'; changed(); };
document.querySelectorAll('[data-guide]').forEach(button => button.onclick = () => run(async () => {
  const guide = button.dataset.guide;
  if (currentGuide() === guide) { previewVisible = guide !== 'coarse'; refresh(); return; }
  begin(); if (guide !== 'coarse') doc.conditioning.model = 'base'; doc.conditioning.guide = guide;
  if (doc.conditioning.mapKind !== guide) { doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null; }
  if (guide === 'canny' && !doc.conditioning.map) doc.conditioning.mapOrigin = doc.reference ? 'reference' : 'auto';
  if (guide === 'pose' && doc.openpose?.rawAsset) {
    doc.conditioning.map = doc.openpose.rawAsset; doc.conditioning.mapKind = 'pose';
    doc.conditioning.mapOrigin = doc.openpose.origin;
  }
  if (linkedStructure.asset && ['pose', 'depth', 'canny'].includes(guide) && !usesLocalGuide(guide)) await applyStructureAsset(linkedStructure.asset);
  else changed();
}));
for (const [id, key] of [['canny-low', 'cannyLow'], ['canny-high', 'cannyHigh']]) {
  $(`#${id}`).onchange = event => { begin(); doc.conditioning[key] = Math.max(0, Math.min(255, Number(event.target.value) || 0)); changed(); };
}
$('#reference-overlay-toggle').onclick = () => { overlayShown = !overlayShown; refresh(); };
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
async function applyOpenPoseAsset(asset, detectedPoints = null, fullBody = null) {
  begin();
  doc.openpose = { name: asset.label || 'OpenPose 骨架', sourceName: asset.name, rawAsset: asset,
    origin: detectedPoints ? 'dwpose' : 'import', points: detectedPoints, fullBody, flips: {} };
  doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
  doc.conditioning.map = asset; doc.conditioning.mapKind = 'pose'; doc.conditioning.mapOrigin = doc.openpose.origin;
  previewGuide = 'pose'; previewVisible = true; changed();
}
async function retargetPose() {
  if (doc.openpose?.origin === 'dwpose' && doc.openpose.fullBody === false)
    throw new Error('当前照片未显示完整身体；请直接使用原图骨架，全身照片才可转换为三维姿势');
  const asset = doc.openpose?.rawAsset || doc.conditioning.map;
  if (!asset) throw new Error('请先提取或导入骨架图');
  let people;
  if (doc.openpose?.points) people = [doc.openpose.points];
  else {
    const image = new Image(); image.src = assetURL(asset.name); await image.decode();
    people = readSkeletonImage(image);
  }
  const height = person => Math.max(...Object.values(person).map(point => point[1])) - Math.min(...Object.values(person).map(point => point[1]));
  const points = people.slice().sort((a, b) => height(b) - height(a))[0];
  if (!points) throw new Error('没有找到可用的 OpenPose 身体骨架');
  const previous = clone(doc);
  begin();
  try {
    if (doc.source.kind !== 'human') {
      doc.source = { kind: 'human' }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
      await studio.restore(doc); await ensureHumanTools();
    }
    doc.openpose = { ...doc.openpose, points, flips: {} };
    doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
    doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null;
    const facingAway = studio.applyOpenPose(points);
    previewVisible = false;
    changed();
    const notes = [facingAway ? '识别为背面' : '识别为正面'];
    if (people.length > 1) notes.push(`检测到 ${people.length} 人，已取最大主体`);
    if (people.warnings?.length) notes.push('部分关节已近似补全');
    $('#openpose-status').textContent = `${asset.label || 'OpenPose 骨架'}：${notes.join('，')}`;
  } catch (error) { doc = previous; await studio.restore(doc); throw error; }
}
$('#retarget-pose').onclick = () => run(retargetPose);
$('#pose-original').onclick = () => {
  if (!doc.openpose?.rawAsset) return;
  begin(); doc.conditioning.map = doc.openpose.rawAsset; doc.conditioning.mapKind = 'pose';
  doc.conditioning.mapOrigin = doc.openpose.origin; previewVisible = true; changed();
};
async function applyStructureAsset(asset) {
  if (currentGuide() === 'pose') return applyOpenPoseAsset(asset);
  begin(); doc.conditioning.map = asset; doc.conditioning.mapKind = currentGuide(); doc.conditioning.mapOrigin = 'import'; changed();
}
$('#import-openpose').onclick = () => $('#openpose-file').click();
$('#extract-pose').onclick = () => run(async () => {
  if (!doc.reference?.name) throw new Error('请先连接或导入原图');
  $('#loading-text').textContent = '正在从原图提取姿势';
  $('#loading-detail').textContent = '首次使用可能需要下载 DWPose 模型';
  $('#loading').hidden = false;
  try {
    const response = await fetch('/anyangle-studio/dwpose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: doc.reference.name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'DWPose 提取失败');
    await applyOpenPoseAsset(result.asset, result.points, result.fullBody);
    toast(result.fullBody ? '原图姿势已提取，中央预览为实际输出骨架' : '原图可见姿势已提取，未显示的肢体不会补成人偶姿势');
  } finally { $('#loading').hidden = true; }
});
$('#import-map').onclick = () => $('#map-file').click();
$('#extract-depth').onclick = () => run(async () => {
  if (!doc.reference?.name) throw new Error('请先连接或导入原图');
  $('#loading-text').textContent = '正在估计原图深度';
  $('#loading-detail').textContent = '首次使用可能需要下载 Depth Anything 3 Small 模型';
  $('#loading').hidden = false;
  try {
    const response = await fetch('/anyangle-studio/depth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reference: doc.reference.name }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '深度估计失败');
    begin(); doc.conditioning.map = result.asset; doc.conditioning.mapKind = 'depth';
    doc.conditioning.mapOrigin = 'da3'; previewVisible = true; changed();
  } finally { $('#loading').hidden = true; }
});
async function generateCanny(origin) {
  await run(async () => {
    if (origin === 'reference' && !doc.reference) throw new Error('请先连接或导入原图');
    if (origin === 'auto' && doc.source.kind === 'empty') throw new Error('请先重建或载入三维场景');
    begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null;
    doc.conditioning.mapOrigin = origin; previewVisible = true; changed();
  });
  if (previewRevision === revision) toast('Canny 轮廓已生成，中央预览为实际输出');
}
$('#generate-canny').onclick = () => generateCanny('reference');
$('#generate-scene-canny').onclick = () => generateCanny('auto');
$('#openpose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  await applyOpenPoseAsset(await upload(file));
});
$('#map-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  await applyStructureAsset(await upload(file));
});
$('#read-map').onclick = $('#read-openpose').onclick = () => {
  explicitStructureRead = true;
  linkedStructure = { ...linkedStructure, connected: true, pending: true, message: '正在读取上游结构图…' };
  refresh(); send('anyangle-read-structure');
};
document.querySelectorAll('[data-flip]').forEach(button => {
  button.onclick = () => {
    if (!doc.openpose || doc.source.kind !== 'human') return;
    begin(); const key = button.dataset.flip;
    doc.openpose.flips = { ...doc.openpose.flips, [key]: !doc.openpose.flips[key] };
    studio.applyOpenPose(doc.openpose.points, doc.openpose.flips); changed();
  };
});
$('#reference-button').onclick = $('#reference-drop').onclick = () => $('#reference-file').click();
$('#read-reference').onclick = () => {
  linkedReference = { ...linkedReference, connected: true, pending: true, message: '正在读取上游图像…' };
  refresh(); send('anyangle-read-reference');
};
$('#reference-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const asset = await upload(file);
  begin(); doc.reference = asset;
  if (doc.source.kind === 'splat') doc.source = { kind: 'empty' };
  await studio.restore(doc); changed();
  if (doc.source.kind === 'empty' && currentGuide() === 'coarse') await reconstructPhoto();
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
    doc.width = Math.max(64, Math.round(reference.width * outputScale));
    doc.height = Math.max(64, Math.round(reference.height * outputScale));
    $('#loading-text').textContent = '载入三维主体和参考机位';
    await studio.restore(doc);
    doc.conditioning.guide = 'coarse';
    previewGuide = 'coarse'; previewVisible = false; studio.setMode('camera');
    changed(); renderShots();
    $('#status').textContent = '原图三维重建已载入 · 拖动调整机位后应用';
  } catch (e) {
    doc = previous;
    await studio.restore(doc);
    $('#status').textContent = '原图重建未完成 · 可重试'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#reconstruct').onclick = () => run(reconstructPhoto);
$('#extract-coarse').onclick = () => run(reconstructPhoto);
$('#preview-coarse').onclick = () => { previewVisible = true; refresh(); schedulePreview(); };
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
    button.onclick = () => run(async () => { begin(); doc.mesh = clone(pose.mesh); doc.pose = clone(pose.pose);
      doc.openpose = pose.openpose ? clone(pose.openpose) : null; await studio.restore(doc); changed(); });
    const remove = iconButton('trash', `删除姿势 ${pose.name}`); remove.onclick = () => { poseLibrary = poseLibrary.filter(p => p.id !== pose.id); saveLibrary(); };
    row.append(button, remove); $('#saved-poses').append(row);
  }
}
$('#save-pose').onclick = async () => {
  const name = await askName('保存姿势', `姿势 ${poseLibrary.length + 1}`); if (!name) return;
  poseLibrary.push({ id: crypto.randomUUID(), name, mesh: clone(doc.mesh), pose: studio.pose(), openpose: clone(doc.openpose) });
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
    body: JSON.stringify({ version: 1, kind: 'anyangle-pose', mesh: doc.mesh, pose: studio.pose(), openpose: doc.openpose }) });
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
  doc.openpose = imported.openpose || null;
  try { await studio.restore(doc); changed(); }
  catch (e) { doc = previous; await studio.restore(doc); throw e; }
});
$('#download-guide').onclick = () => run(async () => {
  const png = await captureGuide();
  const blob = await (await fetch(png)).blob();
  const asset = await upload(new File([blob], 'anyangle-guide.png', { type: 'image/png' }));
  download(assetURL(asset.name), `${currentGuide()}-guide.png`);
  toast('引导图 PNG 已导出');
});

function send(type, payload = {}) { parent.postMessage({ type, session, ...payload }, location.origin); }
$('#cancel').onclick = () => { if (embedded) send('anyangle-close'); else location.reload(); };
$('#apply').onclick = () => run(async () => {
  clearTimeout(previewTimer); studio.syncPose();
  const frozen = clone(doc), appliedRevision = revision;
  const png = await captureGuide();
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

async function start(token, reference = { connected: false }, structure = { connected: false }, needsWiring = false) {
  try {
    if (token?.id) {
      const response = await fetch(`/anyangle-studio/snapshots/${encodeURIComponent(token.id)}`);
      const saved = await response.json().catch(() => ({}));
      if (response.ok) { doc = saved.scene; snapshot = token; }
      else if (response.status === 404) toast('上次应用的场景不在本机，已回到空白场景 · 重建主体或导入 GLB 后再应用');
      else throw new Error(saved.error || `读取快照失败（HTTP ${response.status}）`);
    }
    doc.conditioning = { ...defaultScene().conditioning, ...doc.conditioning };
    doc.openpose ??= null;
    linkedReference = reference;
    linkedStructure = structure;
    unwiredAnyAngle = needsWiring;
    const referenceChanged = reference.connected && !!reference.asset && reference.asset.name !== doc.reference?.name;
    if (reference.connected) doc.reference = reference.asset || null;
    if (doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    studio = new StudioScene($('#viewport'), { begin, change: changed, camera: () => { revision++; refresh(); schedulePreview(); $('#status').textContent = '机位草稿 · 尚未应用'; $('#status').dataset.state = 'dirty'; }, select: name => { selectedBone = name || ''; refresh(); }, error });
    await studio.init(doc);
    if (doc.source.kind === 'human') await ensureHumanTools();
    if (structure.asset && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(doc.conditioning.guide)
        && !usesLocalGuide())
      await applyStructureAsset(structure.asset);
    selectedShot = doc.shots.find(shot => shot.width === doc.width && shot.height === doc.height
      && Object.keys(doc.camera).every(key => Number(shot.camera[key] || 0) === Number(doc.camera[key] || 0)))?.id || null;
    ready = true; $('#loading').hidden = true; refresh(); renderShots(); renderLibrary();
    $('#status').textContent = snapshot ? '已载入上次应用的场景' : '连接或上传原图，重建对应的三维主体';
    $('#status').dataset.state = snapshot ? 'saved' : 'dirty';
    if (referenceChanged) { $('#status').textContent = '连线原图已更新 · 应用后保存到场景'; $('#status').dataset.state = 'dirty'; }
    setBusy(false); await renderPreview();
    if (doc.reference && doc.source.kind === 'empty' && currentGuide() === 'coarse') await run(reconstructPhoto);
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
    if (doc.source.kind === 'splat') doc.source = { kind: 'empty' };
    await studio.restore(doc); changed();
    if (doc.reference && doc.source.kind === 'empty' && currentGuide() === 'coarse') await reconstructPhoto();
  });
}
function readPendingStructure() {
  if (busy || !pendingStructure) return;
  const structure = pendingStructure; pendingStructure = null;
  const applyLinked = explicitStructureRead || !usesLocalGuide();
  explicitStructureRead = false;
  run(async () => {
    const oldAsset = linkedStructure.asset?.name;
    linkedStructure = structure;
    if (structure.error) toast(structure.error);
    if (!structure.connected && oldAsset && doc.conditioning.map?.name === oldAsset) {
      begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null; changed();
    }
    if (applyLinked && structure.asset && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(doc.conditioning.guide))
      await applyStructureAsset(structure.asset);
    refresh(); schedulePreview();
  });
}
if (embedded) {
  let started = false;
  window.addEventListener('message', event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.session !== session) return;
    if (event.data.type === 'anyangle-load' && !started) {
      started = true; start(event.data.snapshot, event.data.reference, event.data.structure, event.data.unwiredAnyAngle);
    } else if (event.data.type === 'anyangle-reference' && ready) {
      pendingReference = event.data.reference; readPendingReference();
    } else if (event.data.type === 'anyangle-structure' && ready) {
      pendingStructure = event.data.structure; readPendingStructure();
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
