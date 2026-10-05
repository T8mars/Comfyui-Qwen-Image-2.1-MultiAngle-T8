import { StudioScene, defaultScene, restoreSceneDefaults, PRESETS, assetURL } from './scene.mjs?v=20261005audit14';
import { reconstruct, reconstructionConfig, selectedReconstructionModels, saveReconstructionModels } from './reconstruct.mjs?v=20261004mp1';
import { readSkeletonImage } from './openpose.mjs?v=20261004mp1';
import { GUIDE_LABELS, guideImageIndex, guideSource, cannyEdges, hasCannyEdges } from './guides.mjs?v=20261005audit14';
import { supportsCameraBatch, cameraBatchPlan, runCameraBatch } from './batch.mjs?v=20261004mp1';
import { randomPose } from './poses.mjs?v=20261004mp1';
import { installActorsUI, refreshActorsUI, updateActorReferences, selectRole, chooseDetectedPeople, randomRoles } from './actors-ui.mjs?v=20261005audit4';
import { activeActor, saveActor } from './actors.mjs?v=20261004mp1';
import { buildManifest, actorMode, actorPrompt, scenePrompt } from './manifest.mjs?v=20261004mp3';

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
let pendingActors = null;
let pendingKeypoints = null;
let explicitStructureRead = false;
let overlayShown = false;
let previewVisible = false, previewGuide = null, previewRevision = -1;
let cannyWarningRevision = -1;
const EMPTY_CANNY_WARNING = '未检测到 Canny 轮廓；可降低阈值或检查画幅，仍可输出当前空白图。';
let batchRunning = false, batchController = null, batchViews = [], batchId = null;
const batchReplies = new Map();
const controls = new Map();
let poseLibrary;
try { poseLibrary = JSON.parse(localStorage.getItem('anyangle-studio.poses.v1') || '[]'); }
catch { poseLibrary = []; }
if (!Array.isArray(poseLibrary)) poseLibrary = [];
poseLibrary = poseLibrary.filter(pose => pose && typeof pose.id === 'string' && typeof pose.name === 'string');

function toast(message) {
  $('#toast').textContent = message; $('#toast').hidden = false;
  clearTimeout(toast.timer); toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function showLoadError(error) {
  $('#loading').hidden = true;
  $('#load-error-message').textContent = error?.message || String(error);
  $('#repair-human').hidden = error?.name !== 'HumanAssetError';
  $('#load-error-help').hidden = error?.name !== 'HumanAssetError';
  $('#repair-state').textContent = error?.name === 'HumanAssetError'
    ? '也可在节点目录运行 python install_assets.py，再重启 ComfyUI。' : '解决以上错误后重试加载。';
  const dialog = $('#load-error-dialog'); if (!dialog.open) dialog.showModal();
}
function error(error) {
  console.error(error); toast(error?.message || String(error));
  if (error?.name === 'HumanAssetError') showLoadError(error);
}
function currentGuide() { return doc.conditioning.model === 'anyangle' ? 'coarse' : doc.conditioning.guide; }
function usesLocalGuide(guide = currentGuide()) {
  return guide === 'pose' && (['dwpose', 'json', 'keypoints'].includes(doc.openpose?.origin) || doc.openpose?.useRig || doc.conditioning.mapOrigin === 'rig')
    || guide === 'depth' && ['da3', 'scene'].includes(doc.conditioning.mapOrigin)
    || guide === 'canny' && ['auto', 'reference'].includes(doc.conditioning.mapOrigin);
}
function hasGuide() {
  const guide = currentGuide();
  if (linkedStructure.connected && doc.conditioning.model === 'base' && ['pose', 'depth', 'canny'].includes(guide)
      && !usesLocalGuide(guide)
      && (!linkedStructure.asset || linkedStructure.pending)) return false;
  const source = guideSource(doc);
  return source.kind === 'image' || source.kind === 'canny-image' || source.kind === 'canny-scene'
    || source.kind === 'depth-scene'
    || source.kind === 'pose' && doc.source.kind === 'human' || source.kind === 'scene' && doc.source.kind !== 'empty';
}
function setBusy(value) {
  busy = value; $('#workspace').inert = value; $('#apply').disabled = value || !ready || !hasGuide()
    || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending))
    || (linkedStructure.connected && !!linkedStructure.pending && !usesLocalGuide());
  $('#undo').disabled = value || !undo.length; $('#redo').disabled = value || !redo.length;
  if (!value && pendingReference) queueMicrotask(readPendingReference);
  if (!value && pendingStructure) queueMicrotask(readPendingStructure);
  if (!value && pendingActors) queueMicrotask(readPendingActors);
  if (!value && pendingKeypoints) queueMicrotask(readPendingKeypoints);
}
async function run(task) {
  if (busy) return;
  studio?.finishDrag?.(false);
  setBusy(true);
  try {
    while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
    await task();
  } catch (e) { error(e); }
  finally { setBusy(false); await renderPreview(); }
}
function begin() {
  if (!ready || studio.restoring) return;
  // Finish the previous gesture without overwriting this control's new DOM value.
  studio.finishDrag?.(false);
  const previousUndo = undo.slice(), previousRedo = redo;
  const undoDisabled = $('#undo').disabled, redoDisabled = $('#redo').disabled;
  studio.syncPose();
  const serialized = JSON.stringify(doc);
  if (JSON.stringify(undo.at(-1)) !== serialized) undo.push(clone(doc));
  if (undo.length > 40) undo.shift();
  redo = []; $('#undo').disabled = false; $('#redo').disabled = true;
  return () => {
    undo = previousUndo; redo = previousRedo;
    $('#undo').disabled = undoDisabled; $('#redo').disabled = redoDisabled;
  };
}
function changed(updatePreview = true, updateControls = true) {
  if (!ready || studio.restoring) return;
  studio.syncPose(); revision++; selectedShot = null;
  if (!updatePreview && previewRevision === revision - 1) previewRevision = revision;
  document.querySelectorAll('.preset-card.active').forEach(button => button.classList.remove('active'));
  document.querySelectorAll('.shot-thumb.active').forEach(button => button.classList.remove('active'));
  $('#status').textContent = '草稿有更改 · 应用后才会更新节点'; $('#status').dataset.state = 'dirty';
  if (updateControls) refresh();
  if (updatePreview) schedulePreview();
}
function schedulePreview() {
  clearTimeout(previewTimer);
  if (doc.interaction?.livePreview !== false) previewTimer = setTimeout(renderPreview, 450);
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
  const input = guideSource(doc), captureRevision = revision;
  if (input.kind === 'pose') return studio.captureOpenPose(width, height);
  if (input.kind === 'image') return (await imageCanvas(assetURL(input.asset.name), width, height)).toDataURL('image/png');
  if (input.kind === 'missing') throw new Error('请先生成、导入或连接当前引导图');
  if (input.kind === 'scene') return studio.capture(width, height);
  if (input.kind === 'depth-scene') return studio.capture(width, height, { depth: true });
  const source = input.kind === 'canny-image' ? assetURL(input.asset.name) : await studio.capture(width, height, { canny: true });
  const decoded = new Image(); decoded.src = source; await decoded.decode();
  const scale = Math.min(1, 1536 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
  const workWidth = Math.max(1, Math.round(decoded.naturalWidth * scale)), workHeight = Math.max(1, Math.round(decoded.naturalHeight * scale));
  const work = await imageCanvas(source, workWidth, workHeight);
  const context = work.getContext('2d', { willReadFrequently: true });
  const pixels = context.getImageData(0, 0, workWidth, workHeight);
  const edges = cannyEdges(pixels.data, workWidth, workHeight, doc.conditioning.cannyLow, doc.conditioning.cannyHigh);
  cannyWarningRevision = hasCannyEdges(edges) ? -1 : captureRevision;
  pixels.data.set(edges);
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
  } catch (e) { previewRevision = -1; refresh(); $('#stage-guide-message').textContent = e.message || '预览生成失败，请重试'; error(e); }
  finally { previewRunning = false; }
}
function refresh() {
  if (studio && (doc.source.kind === 'splat' || doc.source.kind === 'empty') &&
      (studio.mode !== 'camera' || $('#edit-mode').classList.contains('active'))) setMode('camera');
  if (linkedReference.connected) doc.reference = linkedReference.asset || null;
  const guide = currentGuide(), base = doc.conditioning.model === 'base', input = guideSource(doc);
  const manifest = buildManifest(doc), multi = actorMode(doc);
  const castMapping = doc.source.kind === 'human' && doc.conditioning.identityMode === 'actors' && base;
  const imageIndex = castMapping ? manifest.guide.index : guideImageIndex(doc.conditioning), promptMode = doc.conditioning.promptMode || 'default';
  const referenceIndex = castMapping ? manifest.references.find(reference => reference.asset.name === doc.reference?.name)?.index
    : promptMode === 'single' ? null : 3 - imageIndex;
  $('#reference-heading').innerHTML = `原图 <small>· ${referenceIndex ? `image_${referenceIndex}` : '姿势 / 重建来源'}</small>`;
  const staticGuide = input.kind === 'image' || input.kind === 'canny-image';
  const poseImage = guide === 'pose' && input.kind === 'image';
  if (previewGuide !== guide) { previewGuide = guide; previewVisible = guide !== 'coarse'; }
  $('#stage').classList.toggle('previewing-guide', previewVisible);
  $('#stage-guide-view').hidden = !previewVisible;
  $('#stage-guide-title').textContent = GUIDE_LABELS[guide];
  $('#stage-guide-detail').textContent = `实际输出 · image_${imageIndex} · ${doc.width} × ${doc.height}`;
  $('#stage-guide').hidden = !hasGuide() || previewRevision !== revision;
  $('#stage-guide-empty').hidden = hasGuide() && previewRevision === revision;
  $('#stage-guide-message').textContent = hasGuide() ? '正在生成引导图预览…'
    : guide === 'coarse' ? '先从原图重建三维主体' : '请在右侧生成或导入引导图';
  $('#view-detail').textContent = previewVisible ? `${GUIDE_LABELS[guide]} · 实际输出` : '三维工作台 · 调整机位与姿势';
  for (const [id, active] of [['view-output', previewVisible], ['view-scene', !previewVisible]]) {
    $(`#${id}`).classList.toggle('active', active); $(`#${id}`).setAttribute('aria-pressed', String(active));
  }
  $('#view-scene').hidden = staticGuide || guide === 'depth' && input.kind !== 'depth-scene';
  $('#view-scene').disabled = doc.source.kind === 'empty';
  $('#lens-panel').hidden = staticGuide;
  $('#lens-mode').value = doc.camera.focalLength ? 'custom' : 'original';
  $('#lens-controls').hidden = !doc.camera.focalLength;
  $('#copy-photo-pose').disabled = !doc.reference?.name || !!linkedReference.pending;
  $('#pose-category').value = (doc.randomMaster || doc.poseRandom)?.category || 'mixed';
  if (document.activeElement !== $('#pose-seed')) $('#pose-seed').value = (doc.randomMaster || doc.poseRandom)?.seed || 0;
  for (const id of ['camera-heading', 'camera-eyebrow', 'camera-sliders', 'view-presets', 'shot-shelf', 'scene-panel']) $(`#${id}`).hidden = staticGuide;
  $('#stage-help').textContent = previewVisible ? staticGuide ? '原图结构与构图 · 应用到节点后输出当前引导图' : '当前三维机位的引导图 · 切换 3D 工作台调整机位'
    : studio?.mode === 'position' ? '点选人物 · 拖动调整站位 · 右键环绕 · 中键平移'
    : studio?.mode === 'edit' ? '点选关节 / 拖 IK 手脚 · 右键环绕 · 中键平移'
      : '黄框为输出范围 · 拖动调整机位 · 中键或 Shift 平移 · 滚轮缩放';
  for (const control of controls.values()) control.refresh();
  $('#width').value = doc.width; $('#height').value = doc.height;
  $('#background').value = doc.background;
  const ratio = ['1:1', '16:9', '9:16', '4:3'].find(value => { const [w, h] = value.split(':').map(Number); return Math.abs(doc.width / doc.height - w / h) < 0.015; });
  $('#ratio').value = ratio || 'custom';
  $('#guide-size').textContent = `${doc.width} × ${doc.height}`;
  const human = doc.source.kind === 'human';
  const splat = doc.source.kind === 'splat', empty = doc.source.kind === 'empty';
  $('#front').disabled = $('#front-number').disabled = human || splat || empty;
  $('#scale').disabled = $('#scale-number').disabled = splat || empty || human && !!activeActor(doc)?.locked;
  $('#front').closest('.control').hidden = human || splat || empty;
  $('#scale').closest('.control').hidden = splat || empty;
  $('#calibration-hint').textContent = splat
    ? '原图重建主体与预测机位已对齐，姿势固定。请用拍摄相机调整角度、缩放和构图。'
    : empty ? '连接原图并重建主体，或导入 GLB 后调整场景。'
      : human ? '人偶可调整资产尺度；姿势、手势和关节可在编辑场景中修改。'
        : 'GLB 默认 Y 轴朝上。旋转资产以校准正面；资产尺度与镜头缩放相互独立。';
  $('#asset-label').textContent = empty ? '等待原图重建' : human ? 'MakeHuman · 手动人偶' : doc.source.label || 'GLB 场景';
  $('#source-badge').textContent = empty ? 'PHOTO → 3D' : splat ? doc.source.keep_background ? 'TRIPOSPLAT · 保留背景' : 'TRIPOSPLAT · 原图主体' : human ? 'HUMAN · 手动人偶' : 'GLB · 场景';
  for (const id of ['pose-panel', 'hands-panel', 'body-panel', 'joint-panel']) {
    $(`#${id}`).classList.toggle('disabled-panel', !human);
    $(`#${id}`).inert = !human || id !== 'pose-panel' && !!activeActor(doc)?.locked;
    $(`#${id}`).hidden = !human || staticGuide;
  }
  for (const id of ['presets', 'pose-actions', 'saved-poses']) $(`#${id}`).inert = !human || !!activeActor(doc)?.locked;
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
  const keepBackground = doc.reconstruction.keepBackground;
  $('#keep-background').checked = keepBackground;
  $('#keep-background').disabled = !doc.reference || !!linkedReference.pending;
  const reconstructionChanged = splat && !!doc.source.keep_background !== keepBackground;
  $('#reconstruction-state').textContent = splat ? '原图 3D 保持重建姿势，无可编辑骨架；拖动相机改变视角。需要手动摆姿可切换人偶。' : '从原图重建对应主体，再调整机位。';
  $('#reconstruct').disabled = !doc.reference;
  if (reconstructionChanged) $('#reconstruction-state').textContent = '背景选项已改变 · 点击重建后应用；当前预览仍为上次结果。';
  $('#reconstruct').textContent = reconstructionChanged ? '按新设置重新重建 3D' : keepBackground ? '保留背景重建 3D' : splat ? '重新载入原图 3D' : '从原图重建 3D';
  $('#empty-scene').hidden = !empty;
  $('#coarse-inputs').hidden = guide !== 'coarse';
  $('#extract-coarse').disabled = !doc.reference || !!linkedReference.pending;
  $('#preview-coarse').disabled = empty;
  $('#coarse-status').textContent = splat ? doc.source.keep_background ? '保留背景的三维重建已就绪，可预览或调整机位；大场景效果仍属实验。' : '原图三维主体已就绪，可预览或调整新机位。'
    : human ? '当前场景是手动人偶；重建原图后可生成对应主体的粗图。'
      : empty ? '先从原图重建三维主体，再输出拍摄机位粗图。' : '当前 GLB 场景可直接渲染粗图。';
  $('#model-anyangle').classList.toggle('active', !base); $('#model-base').classList.toggle('active', base);
  $('#model-anyangle').disabled = promptMode === 'single';
  $('#model-anyangle').title = promptMode === 'single' ? '单引导图模式使用 Qwen 底模' : '';
  $('#model-badge').textContent = base ? 'QWEN 2.1' : 'ANYANGLE';
  document.querySelectorAll('[data-guide]').forEach(button => {
    button.classList.toggle('active', button.dataset.guide === guide);
    button.setAttribute('aria-pressed', String(button.dataset.guide === guide));
  });
  $('#openpose-panel').hidden = !base || guide !== 'pose';
  $('#pose-source-description').textContent = poseImage
    ? '直接输出原图的彩色骨架，保留原构图。可复制可见关节到人偶，画外肢体保持原姿势。'
    : '当前输出三维场景骨架，随人物动作、站位和拍摄机位变化。也可从原图提取或导入骨架，再复制到人偶。';
  $('#extract-pose').disabled = !doc.reference || !!linkedReference.pending;
  $('#map-inputs').hidden = !base || !['depth', 'canny'].includes(guide);
  $('#extract-depth').hidden = guide !== 'depth';
  $('#extract-depth').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-scene-depth').hidden = guide !== 'depth';
  $('#generate-scene-depth').disabled = !['human', 'glb'].includes(doc.source.kind);
  $('#depth-invert-row').hidden = guide !== 'depth' || input.kind !== 'depth-scene';
  $('#depth-invert').checked = !!doc.conditioning.depthInvert;
  $('#pose-occlusion').value = doc.conditioning.poseOcclusion || 'all';
  $('#pose-hands').checked = !!doc.conditioning.poseHands;
  $('#generate-canny').hidden = guide !== 'canny';
  $('#generate-canny').disabled = !doc.reference || !!linkedReference.pending;
  $('#generate-scene-canny').hidden = guide !== 'canny';
  $('#generate-scene-canny').disabled = empty;
  $('#import-map').textContent = guide === 'depth' ? '导入 Depth Anything 图' : '导入 Canny 图';
  $('#read-map').hidden = !linkedStructure.connected;
  $('#read-map').disabled = !!linkedStructure.pending;
  $('#import-map').disabled = linkedStructure.connected;
  $('#map-status').textContent = guide === 'depth' && input.kind === 'depth-scene' ? '全场共享深度范围 · 随当前拍摄机位变化；仅 Mesh 场景可用。'
    : guide === 'depth' && doc.conditioning.mapOrigin === 'da3' && doc.conditioning.map ? '已从原图估计深度；对应原机位。'
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
        : guide === 'canny' ? input.kind === 'canny-scene' && !studio?.splat
          ? '使用高对比灰模提取几何轮廓，保留当前机位与遮挡；阈值可调整。'
          : '中央显示实际轮廓图；阈值调整会直接更新边缘。'
          : '底模参考粗图，机位遵循程度需实测。';
  $('#guide-heading').innerHTML = `${GUIDE_LABELS[guide]} <small>· image_${imageIndex}</small>`;
  $('#guide').alt = `当前会输出到 image_${imageIndex} 的引导图`;
  $('#prompt-mode').value = promptMode; $('#image-order').value = manifest.imageOrder;
  $('#image-order-row').hidden = promptMode === 'single';
  $('#custom-prompt-row').hidden = promptMode !== 'custom'; $('#prompt-extra-row').hidden = promptMode === 'custom';
  if (document.activeElement !== $('#custom-prompt')) $('#custom-prompt').value = doc.conditioning.customPrompt || '';
  if (document.activeElement !== $('#prompt-extra')) $('#prompt-extra').value = doc.conditioning.promptExtra || '';
  $('#image-wiring').textContent = promptMode === 'single' ? '当前引导图 → image_1；无需连接原图。用附加描述定义人物、场景与风格。'
    : `原图 → image_${3 - imageIndex}；当前引导图 → image_${imageIndex}。更改顺序后请对应调整编码器连线。`;
  $('#prompt-mode-hint').textContent = promptMode === 'custom' ? '提示词按原文输出，不自动改写图片编号；可留空并在工作流中自行拼接。'
    : promptMode === 'single' ? '单图模式关闭 AnyAngle LoRA；请连接强度输出或移除旧工作流的 LoRA。'
      : '保持原有双图模板，可调整图片编号并附加描述。';
  $('#mouse-pitch').checked = doc.interaction?.mousePitch !== false;
  $('#preview-quality').value = doc.interaction?.quality || 'balanced';
  $('#live-preview').checked = doc.interaction?.livePreview !== false;
  $('#prompt-preview').textContent = scenePrompt(doc, manifest);
  if (castMapping && !multi && !manifest.references.length && promptMode !== 'custom') {
    $('#image-wiring').textContent = '当前结构图 → image_1；没有共享原图，使用引导图与附加描述生成。人物绑定保留。';
    $('#prompt-mode-hint').textContent = '当前静态结构图使用单图模板；切回三维引导后恢复人物身份映射。';
  }
  if (multi) {
    $('#image-wiring').textContent = `引导图 → image_${manifest.guide.index}；${manifest.references.map(ref => `人物照片 → image_${ref.index} (${ref.actorIds.length} 人共用)`).join('；') || '人物使用文字身份'}。连接“多人编码 · T8”读取实际映射。`;
    $('#prompt-mode-hint').textContent = `${manifest.guide.index === 1 ? `首张引导图按 32 对齐编码；请求 ${doc.width} × ${doc.height}。` : '首张人物照片及编码节点的参考预算决定画幅。'}实际尺寸在多人编码节点的 latent 输出旁显示。${doc.width % 32 || doc.height % 32 ? '推荐把输出宽高设为 32 的整数倍。' : ''}`;
    $('#prompt-mode-hint').textContent += ` ${manifest.warnings.join(' ') || `${manifest.imageCount} 张参考 · 官方参考预算为 10 张。角色绑定与实际图片编号自动同步。`}`;
    if (promptMode === 'custom') $('#prompt-mode-hint').textContent += ' 左侧原图需绑定人物才用于身份；自定义提示词按原文输出，图片编号由用户维护。';
  }
  $('#lora-hint').textContent = base ? 'LoRA 强度输出 0 → 使用底模' : 'LoRA 强度输出 1 → AnyAngle';
  $('#protocol-hint').textContent = base && unwiredAnyAngle ? '当前工作流的 AnyAngle LoRA 强度仍固定。请连接 Studio 的强度输出，或移除 LoRA 加载器。'
    : base ? `底模使用 image_${imageIndex} 作为引导图；结构遵循程度需实测。`
    : human ? '修改人物动作请选 Qwen 底模 + POSE 姿势；AnyAngle 用于改变机位。'
      : 'AnyAngle 必须使用当前机位粗图。请把 LoRA 强度输出接至模型加载器。';
  $('#protocol-hint').classList.toggle('wiring-warning', base && unwiredAnyAngle);
  $('#openpose-status').textContent = doc.openpose ? poseImage ? doc.openpose.fullBody === false
    ? '已提取可见骨架；半身或遮挡照片直接输出原图姿势。' : '已生成原图骨架；可直接输出或选择三维编辑。'
    : '当前输出三维人偶骨架 · 可调整姿势与机位。' : '可提取原图或导入骨架；当前人偶可手动摆姿。';
  $('#retarget-pose').hidden = !doc.openpose?.rawAsset && !doc.conditioning.map;
  $('#retarget-pose').textContent = poseImage ? '用三维人偶调整姿势' : '重新复制照片姿势';
  $('#retarget-pose').disabled = false;
  $('#retarget-pose').title = '复制可见关节；旧版半身骨架需要重新提取';
  $('#pose-copy-mode').value = doc.openpose?.retargetMode || (doc.openpose?.origin === 'import' ? 'estimated' : 'conservative');
  $('#pose-copy-mode').querySelector('[value="estimated"]').disabled = doc.openpose?.fullBody === false;
  $('#pose-original').hidden = !doc.openpose?.rawAsset || poseImage;
  const poseSource = activeActor(doc)?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose);
  $('#pose-flips').hidden = !poseSource?.points || poseSource.fullBody === false || poseImage || poseSource.retargetMode === 'conservative';
  $('#pose-flips').inert = !!activeActor(doc)?.locked;
  document.querySelectorAll('[data-flip]').forEach(button => button.classList.toggle('on', !!poseSource?.flips?.[button.dataset.flip]));
  $('#read-openpose').hidden = !linkedStructure.connected;
  $('#read-openpose').disabled = !!linkedStructure.pending;
  $('#guide').hidden = !hasGuide() || previewRevision !== revision;
  const emptyCanny = ['canny-scene', 'canny-image'].includes(input.kind) && cannyWarningRevision === revision;
  $('#guide-state').classList.toggle('wiring-warning', emptyCanny);
  $('#guide-state').textContent = emptyCanny ? EMPTY_CANNY_WARNING : !hasGuide() ? guide === 'pose' ? '先连接原图提取姿势，或导入 OpenPose 图。'
    : guide === 'depth' ? '先从原图估计深度，或导入、连接深度图。'
      : guide === 'canny' ? '请连接原图或载入三维主体，也可导入 Canny 图。'
        : '请先载入三维主体。'
    : guide === 'coarse' ? '网格与控制器不会进入粗图。' : `预览即将输出到 image_${imageIndex} 的实际引导图。`;
  $('#save-shot').disabled = $('#fit-frame').disabled = empty;
  $('#open-batch').disabled = !supportsCameraBatch(doc);
  $('#open-batch').title = supportsCameraBatch(doc) ? '按角度步进或收藏机位批量渲染 / 生成'
    : '需使用三维粗图、人偶骨架或三维 Canny；原图提取的结构图保持原视角';
  $('#download-guide').disabled = !hasGuide();
  $('#apply').disabled = busy || !ready || !hasGuide() || (linkedReference.connected && (!linkedReference.asset || linkedReference.pending))
    || (linkedStructure.connected && !!linkedStructure.pending && !usesLocalGuide(guide));
  $('#edit-mode').disabled = splat || empty;
  $('#position-mode').disabled = !human;
  $('#edit-mode').title = splat ? '原图重建主体没有可编辑骨架；请使用拍摄机位' : empty ? '请先载入三维主体' : '';
  $('#mode-hint').hidden = !splat;
  $('#fit-frame').textContent = splat ? '回到原图机位' : '适合画幅';
  $('.eyebrow').textContent = `${splat ? '原图预测机位' : '场景正面'} · Y-UP · 透视`;
  $('[data-angle="0"]').textContent = splat ? '原图机位' : '正面';
  $('#bone-name').textContent = selectedBone || '未选择';
  $('#bone-select').value = selectedBone;
  for (const axis of ['x', 'y', 'z']) controls.get(`bone-${axis}`)?.refresh();
  refreshActorsUI();
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
makeControl('#focal-sliders', { id: 'focal-length', label: '焦距', min: 12, max: 200, step: 1, unit: 'mm',
  read: () => doc.camera.focalLength || 50, write: value => { doc.camera.focalLength = value; studio.updateShot(); } });
$('#lens-mode').onchange = event => {
  begin(); doc.camera.focalLength = event.target.value === 'custom' ? 50 : 0; studio.updateShot(true); changed();
};
document.querySelectorAll('[data-focal]').forEach(button => { button.onclick = () => {
  begin(); doc.camera.focalLength = Number(button.dataset.focal); studio.updateShot(true); changed();
}; });
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
  $('#position-mode').classList.toggle('active', mode === 'position'); $('#position-mode').setAttribute('aria-pressed', String(mode === 'position'));
  $('#camera-mode').setAttribute('aria-pressed', String(mode === 'camera')); $('#edit-mode').setAttribute('aria-pressed', String(mode === 'edit'));
  $('#use-view').hidden = mode !== 'edit';
  $('#stage-help').textContent = mode === 'camera' ? '黄框为输出范围 · 拖动调整机位 · 中键或 Shift 平移 · 滚轮缩放'
    : mode === 'position' ? '点选人物 · 拖动调整站位 · 右键环绕 · 中键平移'
    : doc.source.kind === 'human' ? '点选关节 / 拖 IK 手脚 · 右键环绕 · 中键平移 · 拍摄机位保持不变'
      : '右键环绕 · 中键平移 · 可将当前视图设为机位';
}
$('#view-output').onclick = () => { previewVisible = true; refresh(); renderPreview(); };
$('#view-scene').onclick = () => { previewVisible = false; setMode(studio.mode); refresh(); };
$('#camera-mode').onclick = () => setMode('camera'); $('#edit-mode').onclick = () => setMode('edit');
$('#position-mode').onclick = () => { previewVisible = false; setMode('position'); refresh(); };
$('#use-view').onclick = () => { begin(); studio.currentViewAsShot(); setMode('camera'); changed(); };
$('#fit-frame').onclick = () => { begin(); studio.fit(); changed(); };
document.querySelectorAll('[data-angle]').forEach(button => { button.onclick = () => { begin(); doc.camera.azimuth = Number(button.dataset.angle); doc.camera.elevation = 0; studio.updateShot(); changed(); }; });
$('#reset-camera').onclick = () => { begin(); doc.camera = doc.source.kind === 'splat' ? referenceCamera() : defaultScene().camera; studio.updateShot(true); changed(); };
$('#bone-select').onchange = event => { studio.finishDrag(false); selectedBone = event.target.value; studio.viewer.selectBoneByName(selectedBone); refresh(); };
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
$('#prompt-mode').onchange = event => {
  begin();
  if (event.target.value === 'custom' && doc.conditioning.customPrompt === undefined) {
    const customDoc = { ...doc, conditioning: { ...doc.conditioning, promptMode: 'custom' } };
    doc.conditioning.customPrompt = actorMode(customDoc) ? actorPrompt(doc, buildManifest(customDoc)) : scenePrompt(doc);
  }
  doc.conditioning.promptMode = event.target.value;
  if (event.target.value === 'single') doc.conditioning.model = 'base';
  changed();
};
$('#image-order').onchange = event => { begin(); doc.conditioning.imageOrder = event.target.value; changed(false); };
for (const [id, key] of [['custom-prompt', 'customPrompt'], ['prompt-extra', 'promptExtra']])
  $(`#${id}`).oninput = event => { begin(); doc.conditioning[key] = event.target.value; changed(false); };
$('#mouse-pitch').onchange = event => { begin(); doc.interaction.mousePitch = event.target.checked; changed(false); };
$('#preview-quality').onchange = event => { begin(); doc.interaction.quality = event.target.value; studio.updatePerformance(); changed(false); };
$('#live-preview').onchange = event => { begin(); doc.interaction.livePreview = event.target.checked; changed(false); if (event.target.checked) schedulePreview(); else clearTimeout(previewTimer); };
$('#refresh-guide').onclick = () => renderPreview();
$('#model-anyangle').onclick = () => { if (doc.conditioning.model === 'anyangle') return; begin(); doc.conditioning.model = 'anyangle'; changed(); };
$('#model-base').onclick = () => { if (doc.conditioning.model === 'base') return; begin(); doc.conditioning.model = 'base'; changed(); };
document.querySelectorAll('[data-guide]').forEach(button => button.onclick = () => run(async () => {
  const guide = button.dataset.guide;
  if (currentGuide() === guide) { previewVisible = guide !== 'coarse'; refresh(); return; }
  begin(); if (guide !== 'coarse') doc.conditioning.model = 'base'; doc.conditioning.guide = guide;
  if (doc.conditioning.mapKind !== guide) { doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null; }
  if (guide === 'canny' && !doc.conditioning.map) doc.conditioning.mapOrigin = doc.reference ? 'reference' : 'auto';
  if (guide === 'pose' && doc.openpose?.rawAsset && !doc.openpose.useRig) {
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
  const previous = doc, previousSource = source.slice(), previousTarget = target.slice();
  try {
    studio.syncPose(); target.push(clone(doc)); doc = clone(source.pop());
    if (linkedReference.connected) doc.reference = linkedReference.asset || null;
    if (doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    await studio.restore(doc); changed(); renderShots(); refresh();
  } catch (error) {
    doc = previous;
    source.splice(0, source.length, ...previousSource); target.splice(0, target.length, ...previousTarget);
    try { await studio.restore(doc); } catch { /* A rollback load failure must not replace the original error. */ }
    throw error;
  }
}
$('#undo').onclick = () => run(() => undoRedo(undo, redo)); $('#redo').onclick = () => run(() => undoRedo(redo, undo));
document.addEventListener('keydown', event => {
  if (event.target.closest('input,textarea,select,[contenteditable="true"]') || busy || document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && studio.cancelDrag()) { event.preventDefault(); return; }
  if (event.ctrlKey || event.metaKey) {
    if (event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('#redo') : $('#undo')).click(); }
    if (event.key.toLowerCase() === 'y') { event.preventDefault(); $('#redo').click(); }
  }
  if (doc.source.kind === 'human' && event.key === 'Delete') { event.preventDefault(); $('#delete-actor').click(); }
  if (doc.source.kind === 'human' && event.altKey && ['ArrowLeft','ArrowRight'].includes(event.key)) {
    event.preventDefault(); const actors = doc.actors, index = actors.findIndex(actor => actor.id === doc.activeActorId);
    if (actors.length) selectRole(actors[(index + (event.key === 'ArrowRight' ? 1 : -1) + actors.length) % actors.length].id);
  }
});

async function upload(file) {
  const form = new FormData(); form.append('file', file);
  const response = await fetch('/anyangle-studio/assets', { method: 'POST', body: form });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '导入失败'); return result;
}
async function applyOpenPoseAsset(asset, detectedPoints = null, fullBody = null, visibleOnly = false) {
  begin();
  doc.openpose = { name: asset.label || 'OpenPose 骨架', sourceName: asset.name, rawAsset: asset,
    origin: detectedPoints ? 'dwpose' : 'import', points: detectedPoints, fullBody, visibleOnly,
    retargetMode: detectedPoints ? 'conservative' : 'estimated', flips: {} };
  doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
  doc.conditioning.map = asset; doc.conditioning.mapKind = 'pose'; doc.conditioning.mapOrigin = doc.openpose.origin;
  previewGuide = 'pose'; previewVisible = true; changed();
}
async function retargetPose() {
  if (doc.openpose?.people?.length) return chooseDetectedPeople(doc.openpose.people, doc.openpose.rawAsset, { reference: doc.openpose.origin === 'dwpose' ? doc.reference : null, origin: doc.openpose.origin });
  const mode = doc.openpose?.retargetMode || (doc.openpose?.origin === 'dwpose' ? 'conservative' : 'estimated');
  if (doc.openpose?.origin === 'dwpose' && doc.openpose.fullBody === false
      && (!doc.openpose.visibleOnly || mode === 'estimated'))
    throw new Error('半身照片请重新提取，并选择保守平面复制；推测立体需要全身关节');
  const asset = doc.openpose?.rawAsset || doc.conditioning.map;
  if (!asset) throw new Error('请先提取或导入骨架图');
  let people;
  if (doc.openpose?.points) people = [doc.openpose.points];
  else {
    const image = new Image(); image.src = assetURL(asset.name); await image.decode();
    people = readSkeletonImage(image);
  }
  if (people.length > 1) {
    const candidates = people.map((raw, i) => {
      const inferred = people.inferredByPerson?.[i] || people.inferredJoints || [], points = Object.fromEntries(Object.entries(raw).filter(([key])=>!inferred.includes(key))), values = Object.values(points);
      return { id: `png-${i}`, points, fullBody: !!(points.la && points.ra), canEstimate3D: !inferred.length, inferredJoints: inferred,
        warning: inferred.length ? '近似补全点不参与复制；缺失肢体保持原姿势' : '', bbox: [Math.min(...values.map(p=>p[0])), Math.min(...values.map(p=>p[1])), Math.max(...values.map(p=>p[0])), Math.max(...values.map(p=>p[1]))], canvasWidth: asset.width, canvasHeight: asset.height };
    });
    return chooseDetectedPeople(candidates, asset, { origin: 'import' });
  }
  const inferred = people.inferredByPerson?.[0] || people.inferredJoints || [];
  const points = people[0] && Object.fromEntries(Object.entries(people[0]).filter(([key])=>!inferred.includes(key)));
  const copyMode = inferred.length ? 'conservative' : mode;
  if (!points) throw new Error('没有找到可用的 OpenPose 身体骨架');
  const previous = clone(doc), rollbackHistory = begin();
  try {
    if (doc.source.kind !== 'human') {
      doc.source = { kind: 'human' }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
      await studio.restore(doc); await ensureHumanTools();
    }
    doc.openpose = { ...doc.openpose, points, inferredJoints: inferred, retargetMode: copyMode, flips: {}, useRig: true };
    doc.conditioning.model = 'base'; doc.conditioning.guide = 'pose';
    doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = null;
    const facingAway = studio.applyOpenPose(points, {}, copyMode);
    const role = activeActor(doc); if (role) role.poseSource = { ...clone(doc.openpose), points, retargetMode: copyMode };
    setMode('camera');
    previewVisible = false;
    changed();
    const notes = [copyMode === 'conservative' ? '已复制可见方向；画外肢体保持原姿势' : facingAway ? '识别为背面' : '识别为正面'];
    if (inferred.length) notes.push('近似补全点未参与复制');
    $('#openpose-status').textContent = `${asset.label || 'OpenPose 骨架'}：${notes.join('，')}`;
    return true;
  } catch (error) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original pose-copy error. */ }
    throw error;
  }
}
$('#retarget-pose').onclick = () => run(retargetPose);
$('#pose-copy-mode').onchange = event => {
  if (!doc.openpose) return;
  begin(); doc.openpose.retargetMode = event.target.value; changed(false);
};
$('#pose-original').onclick = () => {
  if (!doc.openpose?.rawAsset) return;
  begin(); doc.openpose.useRig = false;
  doc.conditioning.map = doc.openpose.rawAsset; doc.conditioning.mapKind = 'pose';
  doc.conditioning.mapOrigin = doc.openpose.origin; previewVisible = true; changed();
};
async function applyStructureAsset(asset) {
  if (currentGuide() === 'pose') return applyOpenPoseAsset(asset);
  begin(); doc.conditioning.map = asset; doc.conditioning.mapKind = currentGuide(); doc.conditioning.mapOrigin = 'import'; changed();
}
$('#import-openpose').onclick = () => $('#openpose-file').click();
async function extractPhotoPose(copyToHuman = false) {
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
    await applyOpenPoseAsset(result.asset, result.points, result.fullBody, result.visibleOnly);
    doc.openpose.people = result.people || [];
    if (copyToHuman) { const copied = await retargetPose(); toast(copied ? '已复制照片可见姿势到人偶，可继续编辑、撤销或保存' : '已取消复制；原图骨架保留，场景人物未修改'); }
    else toast(result.fullBody ? '原图姿势已提取，中央预览为实际输出骨架' : '原图可见姿势已提取，未显示的肢体不会补成人偶姿势');
  } finally { $('#loading').hidden = true; }
}
$('#extract-pose').onclick = () => run(() => extractPhotoPose());
$('#copy-photo-pose').onclick = () => run(() => extractPhotoPose(true));
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
  if (previewRevision === revision) toast(cannyWarningRevision === revision ? EMPTY_CANNY_WARNING : 'Canny 轮廓已生成，中央预览为实际输出');
}
$('#generate-canny').onclick = () => generateCanny('reference');
$('#generate-scene-canny').onclick = () => generateCanny('auto');
$('#generate-scene-depth').onclick = () => { begin(); doc.conditioning.map = null; doc.conditioning.mapKind = null; doc.conditioning.mapOrigin = 'scene'; previewVisible = true; changed(); };
$('#depth-invert').onchange = event => { begin(); doc.conditioning.depthInvert = event.target.checked; changed(); };
$('#pose-occlusion').onchange = event => { begin(); doc.conditioning.poseOcclusion = event.target.value; changed(); };
$('#pose-hands').onchange = event => { begin(); doc.conditioning.poseHands = event.target.checked; changed(); };
$('#openpose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  if (file.name.toLowerCase().endsWith('.json')) {
    const keypoints = JSON.parse(await file.text());
    const photoCanvas = doc.reference?.width && doc.reference?.height;
    const canvasWidth = photoCanvas ? doc.reference.width : doc.width, canvasHeight = photoCanvas ? doc.reference.height : doc.height;
    const frame = Array.isArray(keypoints) ? keypoints[0] : keypoints;
    const missingCanvas = frame?.canvas_width == null && frame?.canvas_height == null;
    const response = await fetch('/anyangle-studio/pose-people', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keypoints, canvas_width: canvasWidth, canvas_height: canvasHeight }) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '骨架 JSON 无效');
    await applyOpenPoseAsset(result.asset, result.points, result.fullBody, result.visibleOnly); doc.openpose.people = result.people; doc.openpose.origin = 'json'; changed();
    if (missingCanvas) toast(`JSON 未带画布尺寸；按${photoCanvas ? '原图' : '当前输出'} ${canvasWidth} × ${canvasHeight} 像素坐标导入，请确保与骨架坐标一致。`);
    return;
  }
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
    const actor = activeActor(doc), source = actor?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose);
    if (!source?.points || source.fullBody === false || source.retargetMode === 'conservative' || actor?.locked || doc.source.kind !== 'human') return;
    begin(); const key = button.dataset.flip;
    source.flips = { ...source.flips, [key]: !source.flips?.[key] };
    studio.applyOpenPose(source.points, source.flips, 'estimated'); changed();
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
const reconstructionModelLabels = {
  background_removal: '背景移除 · BiRefNet', clip_vision: '图像编码 · DINOv3', diffusion_models: '三维重建 · TripoSplat',
  vae_encoder: '图像 VAE · Flux2', vae_decoder: '三维解码 · TripoSplat VAE',
};
function showModelStatus(config) {
  $('#reconstruction-model-state').textContent = config.available ? `${doc.reconstruction.keepBackground ? '4 个重建模型已就绪 · 保留背景时无需 BiRefNet' : '5 个模型已就绪'} · 下次重建使用当前选择`
    : `尚需选择或准备：${config.missing.join('、')}`;
}
async function loadReconstructionModels() {
  $('#reconstruction-model-state').textContent = '正在读取本机模型列表…';
  $('#reconstruction-model-save').disabled = true;
  try {
    const config = await reconstructionConfig({}, doc.reconstruction.keepBackground);
    if (!config.choices) throw new Error('请重启 ComfyUI 以启用新版模型选择功能');
    const selected = selectedReconstructionModels(), fields = $('#reconstruction-model-fields');
    fields.replaceChildren();
    for (const [role, title] of Object.entries(reconstructionModelLabels)) {
      const label = document.createElement('label'), select = document.createElement('select');
      label.textContent = title; select.dataset.role = role; select.setAttribute('aria-label', title);
      if (role === 'background_removal' && doc.reconstruction.keepBackground) {
        label.textContent += ' · 当前模式不使用'; select.disabled = true;
      }
      const automatic = document.createElement('option'); automatic.value = '';
      automatic.textContent = '自动识别 · ' + (config.ambiguous[role] ? '同名文件需选择'
        : config.choices[role].includes(config.models[role]) ? config.models[role] : '未找到');
      select.append(automatic);
      for (const name of config.choices[role]) {
        const option = document.createElement('option'); option.value = option.textContent = name; select.append(option);
      }
      if (selected[role] && !config.choices[role].includes(selected[role])) {
        const missing = document.createElement('option'); missing.value = selected[role];
        missing.textContent = `文件已移动 · ${selected[role]}`; missing.disabled = true; select.append(missing);
      }
      select.value = selected[role] || ''; label.append(select); fields.append(label);
    }
    $('#reconstruction-model-save').disabled = false;
    const chosen = await reconstructionConfig(selected, doc.reconstruction.keepBackground);
    showModelStatus(chosen);
  } catch (e) { $('#reconstruction-model-state').textContent = e.message; throw e; }
}
$('#reconstruction-model-panel').ontoggle = () => {
  if ($('#reconstruction-model-panel').open && ready) run(loadReconstructionModels);
};
$('#reconstruction-model-refresh').onclick = () => run(loadReconstructionModels);
$('#reconstruction-model-save').onclick = () => run(async () => {
  const selections = {};
  for (const select of $('#reconstruction-model-fields').querySelectorAll('select'))
    if (select.value) selections[select.dataset.role] = select.value;
  const config = await saveReconstructionModels(selections, doc.reconstruction.keepBackground);
  showModelStatus(config); toast('模型选择已保存 · 点击从原图重建 3D 使用新选择');
});
async function reconstructPhoto() {
  if (!doc.reference) return;
  clearTimeout(previewTimer);
  while (previewRunning) await new Promise(resolve => setTimeout(resolve, 30));
  const reference = clone(doc.reference), keepBackground = doc.reconstruction.keepBackground;
  const previous = clone(doc);
  let rollbackHistory;
  $('#loading').hidden = false;
  $('#loading-text').textContent = keepBackground ? '准备保留背景重建' : '准备从原图重建主体';
  $('#loading-detail').textContent = keepBackground ? '本地 TripoSplat · 完整图像 → 三维重建 → 对齐参考机位'
    : '本地 TripoSplat · 去背景 → 三维重建 → 对齐参考机位';
  try {
    const source = await reconstruct(reference, text => { $('#loading-text').textContent = text; }, true, keepBackground);
    if (doc.reference?.name !== reference.name) throw new Error('原图已改变，请重新重建');
    rollbackHistory = begin();
    if (doc.source.name !== source.name || !!doc.source.keep_background !== !!source.keep_background) doc.shots = [];
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
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original reconstruction error. */ }
    $('#status').textContent = '原图重建未完成 · 可重试'; throw e;
  } finally { $('#loading').hidden = true; refresh(); schedulePreview(); }
}
$('#reconstruct').onclick = () => run(reconstructPhoto);
$('#keep-background').onchange = () => {
  begin(); doc.reconstruction.keepBackground = $('#keep-background').checked; changed();
  if ($('#reconstruction-model-panel').open) run(loadReconstructionModels);
};
$('#extract-coarse').onclick = () => run(reconstructPhoto);
$('#preview-coarse').onclick = () => { previewVisible = true; refresh(); renderPreview(); };
$('#import-glb').onclick = () => $('#glb-file').click();
$('#glb-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return;
  const asset = await upload(file), rollbackHistory = begin();
  const previous = clone(doc); doc.source = { kind: 'glb', ...asset }; doc.front = 0; doc.scale = 1; doc.camera = defaultScene().camera;
  try { await studio.restore(doc); studio.fit(); }
  catch (e) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original GLB error. */ }
    throw e;
  }
  changed(); toast('GLB 已载入。可在场景与构图中调整正面与尺度。');
});
$('#human').onclick = () => run(async () => {
  const rollbackHistory = begin();
  const previous = clone(doc);
  doc.source = { kind: 'human' }; doc.front = 0; doc.scale = 1;
  try { await studio.restore(doc); await ensureHumanTools(); }
  catch (e) {
    doc = previous; rollbackHistory?.();
    try { await studio.restore(doc); } catch { /* Keep the original human-load error. */ }
    throw e;
  }
  changed();
});

async function applyRandomPose(seed) {
  if (doc.source.kind !== 'human') return;
  return randomRoles(seed, $('#pose-category').value);
}
$('#pose-category').onchange = $('#pose-seed').onchange = () => {
  if (!$('#pose-seed').reportValidity()) return;
  begin(); doc.randomMaster = { seed: Number($('#pose-seed').value), category: $('#pose-category').value }; changed(false);
};
$('#random-pose').onclick = () => run(() => applyRandomPose(crypto.getRandomValues(new Uint32Array(1))[0]));
$('#repeat-pose').onclick = () => run(() => applyRandomPose(Number($('#pose-seed').value)));

$('#load-error-close').onclick = () => closeWorkbench();
$('#load-error-dialog').oncancel = event => { if (!ready) event.preventDefault(); };
$('#retry-human').onclick = () => {
  $('#load-error-dialog').close(); if (ready) $('#human').onclick(); else location.reload();
};
$('#repair-human').onclick = async () => {
  $('#repair-human').disabled = $('#retry-human').disabled = true;
  $('#repair-state').textContent = '正在校验本机资源，缺失文件将从固定来源下载，请稍候…';
  try {
    const response = await fetch('/anyangle-studio/repair-human', { method: 'POST' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || '资源修复失败');
    $('#repair-state').textContent = '资源已通过校验，正在重新加载。'; $('#retry-human').onclick();
  } catch (e) { $('#repair-state').textContent = e.message || String(e); }
  finally { $('#repair-human').disabled = $('#retry-human').disabled = false; }
};

function askName(title, initial) {
  $('#name-title').textContent = title; $('#name-input').value = initial; $('#name-dialog').returnValue = '';
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
    thumb.onclick = () => {
      begin(); doc.camera = { ...defaultScene().camera, ...clone(shot.camera) };
      if (Array.isArray(shot.cameraTarget) && shot.cameraTarget.length === 3 && shot.cameraTarget.every(Number.isFinite)) doc.cameraTarget = clone(shot.cameraTarget);
      doc.width = shot.width; doc.height = shot.height; previewVisible = false; setMode('camera'); changed(); selectedShot = shot.id; renderShots();
    };
    const caption = document.createElement('div'); caption.className = 'shot-caption';
    const rename = document.createElement('button'); rename.className = 'rename'; rename.textContent = shot.name; rename.title = '重命名机位';
    rename.onclick = async () => { const name = await askName('重命名机位', shot.name); if (name) { begin(); shot.name = name; changed(); renderShots(); } };
    const remove = iconButton('trash', `删除机位 ${shot.name}`); remove.onclick = () => { begin(); doc.shots = doc.shots.filter(s => s.id !== shot.id); changed(); renderShots(); };
    caption.append(rename, remove); item.append(thumb, caption); $('#shots').append(item);
  }
}
$('#save-shot').onclick = async () => {
  const name = await askName('收藏当前机位', `机位 ${doc.shots.length + 1}`); if (!name) return;
  return run(async () => {
    const previous = clone(doc), previousMode = studio.mode, previousShot = selectedShot, rollbackHistory = begin();
    try {
      if (studio.mode === 'edit') studio.currentViewAsShot(); setMode('camera');
      const scale = 230 / Math.max(doc.width, doc.height); const thumbnail = await studio.capture(Math.round(doc.width * scale), Math.round(doc.height * scale));
      const shot = { id: crypto.randomUUID(), name, camera: clone(doc.camera), width: doc.width, height: doc.height, thumbnail };
      if (doc.source.kind === 'human') shot.cameraTarget = studio.baseTarget.toArray();
      doc.shots.push(shot); changed(); selectedShot = shot.id; renderShots();
      toast('机位已收藏 · 点击缩略图切换；应用到节点后保存收藏。');
    } catch (error) {
      doc = previous; rollbackHistory?.(); selectedShot = previousShot;
      try { await studio.restore(doc); } catch { /* Keep the original thumbnail error. */ }
      try { setMode(previousMode); renderShots(); } catch { /* Scene recovery may also be unavailable. */ }
      throw error;
    }
  });
};

function saveLibrary(next = poseLibrary) {
  localStorage.setItem('anyangle-studio.poses.v1', JSON.stringify(next)); poseLibrary = next; renderLibrary();
}
function renderLibrary() {
  $('#saved-poses').replaceChildren();
  for (const pose of poseLibrary) {
    const row = document.createElement('div'); row.className = 'saved-row';
    const button = document.createElement('button'); button.textContent = pose.name;
    button.onclick = () => run(async () => {
      const previous = clone(doc), previousUndo = undo.slice(), previousRedo = redo.slice();
      begin();
      try {
        doc.mesh = clone(pose.mesh); doc.pose = clone(pose.pose);
        saveActor(doc, doc.pose); if (activeActor(doc)) activeActor(doc).poseSource = clone(pose.openpose);
        await studio.restore(doc); studio.useRigPose(); changed();
      } catch (error) {
        doc = previous; undo = previousUndo; redo = previousRedo;
        try { await studio.restore(doc); } catch { /* Keep the original pose loading error. */ }
        throw error;
      }
    });
    const remove = iconButton('trash', `删除姿势 ${pose.name}`); remove.onclick = () => {
      try { saveLibrary(poseLibrary.filter(p => p.id !== pose.id)); } catch (e) { error(e); }
    };
    row.append(button, remove); $('#saved-poses').append(row);
  }
}
$('#save-pose').onclick = async () => {
  const name = await askName('保存姿势', `姿势 ${poseLibrary.length + 1}`); if (!name) return;
  const poseSource = activeActor(doc)?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose ?? null);
  const pose = { id: crypto.randomUUID(), name, mesh: clone(doc.mesh), pose: studio.pose(), openpose: clone(poseSource) };
  try { saveLibrary([...poseLibrary, pose]); toast('姿势已保存到当前浏览器'); } catch (e) { error(e); }
};
function download(data, name) {
  const url = typeof data === 'string' ? data : URL.createObjectURL(data);
  const link = document.createElement('a'); link.href = url; link.download = name; link.hidden = true;
  document.body.append(link); link.click(); link.remove();
  if (typeof data !== 'string') setTimeout(() => URL.revokeObjectURL(url), 60000);
}
$('#export-pose').onclick = () => run(async () => {
  const poseSource = activeActor(doc)?.poseSource ?? (doc.actors?.length > 1 ? null : doc.openpose ?? null);
  const response = await fetch('/anyangle-studio/poses', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: 1, kind: 'anyangle-pose', mesh: doc.mesh, pose: studio.pose(), openpose: poseSource }) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || '姿势导出失败');
  download(`/anyangle-studio/poses/${encodeURIComponent(result.id)}`, 'anyangle-pose.json');
});
$('#import-pose').onclick = () => $('#pose-file').click();
$('#pose-file').onchange = event => run(async () => {
  const file = event.target.files[0]; event.target.value = ''; if (!file) return; const imported = JSON.parse(await file.text());
  if (imported.version !== 1 || imported.kind !== 'anyangle-pose' || !imported.pose?.bones) throw new Error('请选择本编辑器导出的姿势 JSON');
  for (const values of Object.values(imported.pose.bones)) if (!Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite)) throw new Error('姿势包含无效的骨骼旋转');
  if (!imported.mesh || typeof imported.mesh !== 'object' || Array.isArray(imported.mesh)) throw new Error('姿势包含无效的体型参数');
  const previous = clone(doc), previousUndo = undo.slice(), previousRedo = redo.slice();
  begin();
  try {
    doc.mesh = { ...defaultScene().mesh, ...imported.mesh, breast_size: 0, show_genitals: false }; doc.pose = imported.pose;
    const actor = saveActor(doc, imported.pose); if (actor) actor.poseSource = clone(imported.openpose || null);
    if (!(doc.actors?.length > 1)) doc.openpose = clone(imported.openpose || null);
    await studio.restore(doc); studio.useRigPose(); changed();
  } catch (e) {
    doc = previous; undo = previousUndo; redo = previousRedo;
    try { await studio.restore(doc); } catch { /* Keep the original pose importing error. */ }
    throw e;
  }
});
$('#download-guide').onclick = () => run(async () => {
  const png = await captureGuide();
  const blob = await (await fetch(png)).blob();
  const asset = await upload(new File([blob], 'anyangle-guide.png', { type: 'image/png' }));
  download(assetURL(asset.name), `${currentGuide()}-guide.png`);
  toast('引导图 PNG 已导出');
});

function send(type, payload = {}) { parent.postMessage({ type, session, ...payload }, location.origin); }
function batchRequest(action, payload = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { batchReplies.delete(requestId); reject(new Error('批量提交未收到确认，请检查 ComfyUI 队列；本机位不会自动重复提交')); }, 60000);
    batchReplies.set(requestId, { resolve, reject, timer });
    send('anyangle-batch-request', { requestId, action, ...payload });
  });
}
function batchSettings() {
  return { mode: $('#batch-mode').value, start: Number($('#batch-start').value),
    end: Number($('#batch-end').value), step: Number($('#batch-step').value) };
}
function updateBatchPlan() {
  $('#batch-range').hidden = $('#batch-mode').value === 'saved';
  try {
    const plan = cameraBatchPlan(doc, batchSettings());
    $('#batch-count').textContent = `${plan.count} 个机位 · ${$('#batch-mode').value === 'saved' ? '使用收藏的相机与尺寸，保留当前姿势' : '保留当前姿势、俯仰角与构图'} · 沿用工作流采样设置`;
    $('#batch-guides').disabled = false; $('#batch-final').disabled = !embedded;
  } catch (e) {
    $('#batch-count').textContent = e.message; $('#batch-guides').disabled = $('#batch-final').disabled = true;
  }
}
$('#open-batch').onclick = () => { updateBatchPlan(); $('#batch-dialog').showModal(); };
for (const id of ['batch-mode', 'batch-start', 'batch-end', 'batch-step']) $(`#${id}`).oninput = updateBatchPlan;
$('#batch-close').onclick = () => { if (batchRunning) batchController.abort(); else $('#batch-dialog').close(); };
$('#batch-dialog').addEventListener('cancel', event => { if (batchRunning) { event.preventDefault(); batchController.abort(); } });
$('#batch-stop').onclick = () => batchController?.abort();
$('#batch-zip').onclick = () => { if (batchId) download(`/anyangle-studio/batch-guides/${batchId}`, 'anyangle-guides.zip'); };
$('#batch-manifest').onclick = () => download(new Blob([JSON.stringify({ version: 1, kind: 'anyangle-batch', views: batchViews }, null, 2)],
  { type: 'application/json' }), 'anyangle-batch.json');
async function startCameraBatch(queueFinal) {
  clearTimeout(previewTimer); studio.syncPose();
  const plan = cameraBatchPlan(doc, batchSettings()), original = doc, originalCannyWarning = cannyWarningRevision;
  batchRunning = true; batchController = new AbortController(); batchViews = []; batchId = null;
  $('#batch-options').inert = true; $('#batch-stop').disabled = false; $('#batch-close').textContent = '停止后续机位';
  $('#batch-zip').disabled = $('#batch-manifest').disabled = true;
  $('#batch-state').textContent = queueFinal ? '正在准备当前生成工作流…' : '正在准备批量粗图…';
  try {
    if (queueFinal) await batchRequest('prepare');
    const result = await runCameraBatch(plan, {
      signal: batchController.signal,
      capture: async scene => { doc = scene; studio.doc = doc; studio.updateShot(); return captureGuide(); },
      save: async (scene, png) => {
        const response = await fetch('/anyangle-studio/snapshots', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ scene, png }) });
        const saved = await response.json(); if (!response.ok) throw new Error(saved.error || '批量粗图保存失败'); return saved;
      },
      queue: queueFinal ? async snapshot => (await batchRequest('queue', { snapshot })).prompt_id : null,
      onProgress: ({ index, total, label, phase }) => {
        $('#batch-state').textContent = phase === 'capture' ? `渲染 ${index + 1} / ${total} · ${label}`
          : `${phase === 'queued' ? '已入队' : '已保存'} ${index} / ${total} · ${label}`;
      },
    });
    batchViews = result.views;
    const queued = batchViews.filter(view => view.prompt_id).length;
    $('#batch-state').textContent = `${result.error ? '提交中止' : result.stopped ? '已停止后续机位' : '批量准备完成'} · 粗图 ${batchViews.length} 张${queueFinal ? ` · 已入队 ${queued} 个生成任务` : ''}`;
    if (result.error) error(result.error);
    if (batchViews.length) {
      $('#batch-manifest').disabled = false;
      const response = await fetch('/anyangle-studio/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ views: batchViews }) });
      const saved = await response.json(); if (!response.ok) throw new Error(saved.error || '批量清单保存失败');
      batchId = saved.id; $('#batch-zip').disabled = false;
    }
  } catch (e) { $('#batch-state').textContent = e.message; throw e; }
  finally {
    doc = original; cannyWarningRevision = originalCannyWarning; studio.doc = doc; studio.updateShot();
    batchRunning = false; $('#batch-options').inert = false; $('#batch-stop').disabled = true;
    $('#batch-close').textContent = '关闭'; refresh(); updateBatchPlan();
  }
}
$('#batch-guides').onclick = () => run(() => startCameraBatch(false));
$('#batch-final').onclick = () => run(() => startCameraBatch(true));
function closeWorkbench() { if (embedded) send('anyangle-close'); else location.reload(); }
$('#cancel').onclick = closeWorkbench;
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
  const savedWidth = working.width, savedHeight = working.height;
  const savedSelection = working.selectedActorIds;
  studio.restoring = true;
  $('#presets').replaceChildren();
  try {
    for (const preset of PRESETS) {
      studio.setPreset(preset); working.camera = { azimuth: 25, elevation: 3, zoom: 1.1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      working.width = 150; working.height = 170; working.selectedActorIds = [working.activeActorId]; studio.fit(true);
      const png = await studio.capture(150, 170, { actorIds: [working.activeActorId] });
      const button = document.createElement('button'); button.className = 'preset-card';
      const image = document.createElement('img'); image.src = png; image.alt = '';
      const label = document.createElement('span'); label.textContent = preset.name; button.append(image, label);
      button.onclick = () => { begin(); studio.setPreset(preset); changed(); document.querySelectorAll('.preset-card').forEach(b => b.classList.toggle('active', b === button)); };
      $('#presets').append(button);
    }
  } finally {
    studio.viewer.setPose(savedPose, true); working.pose = savedPose; saveActor(working, savedPose); working.camera = savedCamera;
    working.selectedActorIds = savedSelection;
    working.width = savedWidth; working.height = savedHeight; studio.setMode(mode); studio.restoring = false;
  }
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
    restoreSceneDefaults(doc);
    linkedReference = reference;
    linkedStructure = structure;
    unwiredAnyAngle = needsWiring;
    const referenceChanged = reference.connected && !!reference.asset && reference.asset.name !== doc.reference?.name;
    if (reference.connected) doc.reference = reference.asset || null;
    if (doc.source.kind === 'splat' && doc.source.reference?.name !== doc.reference?.name) doc.source = { kind: 'empty' };
    studio = new StudioScene($('#viewport'), { begin, change: changed, camera: () => { revision++; refresh(); schedulePreview(); $('#status').textContent = '机位草稿 · 尚未应用'; $('#status').dataset.state = 'dirty'; }, pick: selectRole, select: (name, updateControls = true) => { selectedBone = name || ''; if (updateControls) refresh(); }, error });
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
  } catch (e) { showLoadError(e); error(e); }
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
function readPendingActors() {
  if (busy || !ready || !pendingActors) return;
  const message = pendingActors; pendingActors = null;
  run(async () => {
    updateActorReferences(message.actorReferences);
    if (message.error) toast(message.error);
  });
}
function readPendingKeypoints() {
  if (busy || !ready || !pendingKeypoints) return;
  const message = pendingKeypoints; pendingKeypoints = null;
  run(async () => {
    if (message.error) { toast(message.error); return; }
    const result = message.posePeople;
    if (!result || doc.openpose?.origin === 'keypoints' && !doc.openpose.useRig && doc.openpose.inputSignature === result.signature && doc.openpose.inputPlanSignature === result.planSignature && doc.openpose.sourceName === result.asset?.name) return;
    await applyOpenPoseAsset(result.asset, result.people?.[0]?.points, result.people?.[0]?.fullBody);
    doc.openpose.people = result.people; doc.openpose.origin = 'keypoints'; doc.openpose.inputSignature = result.signature; doc.openpose.inputPlanSignature = result.planSignature; changed();
  });
}
installActorsUI({ doc: () => doc, replace: value => { doc = value; }, studio: () => studio, run, begin, changed, refresh,
  ensureHumanTools, askName, upload, captureGuide, toast, send, downloadURL: download, downloadBlob: download,
  showScene: () => { previewVisible = false; setMode('camera'); } });
if (embedded) {
  let started = false;
  window.addEventListener('message', async event => {
    if (event.source !== parent || event.origin !== location.origin || event.data?.session !== session) return;
    if (event.data.type === 'anyangle-load' && !started) {
      started = true; await start(event.data.snapshot, event.data.reference, event.data.structure, event.data.unwiredAnyAngle);
      pendingActors = { actorReferences: event.data.actorReferences, error: event.data.inputError }; readPendingActors();
      $('#read-pose-keypoints').hidden = !event.data.keypointsConnected;
    } else if (event.data.type === 'anyangle-actors' && ready) {
      pendingActors = event.data; readPendingActors();
    } else if (event.data.type === 'anyangle-keypoints' && ready) {
      pendingKeypoints = event.data; readPendingKeypoints();
    } else if (event.data.type === 'anyangle-reference' && ready) {
      pendingReference = event.data.reference; readPendingReference();
    } else if (event.data.type === 'anyangle-structure' && ready) {
      pendingStructure = event.data.structure; readPendingStructure();
    } else if (event.data.type === 'anyangle-batch-reply') {
      const pending = batchReplies.get(event.data.requestId);
      if (pending) {
        clearTimeout(pending.timer); batchReplies.delete(event.data.requestId);
        if (event.data.error) pending.reject(new Error(event.data.error)); else pending.resolve(event.data.result);
      }
    } else if (event.data.type === 'anyangle-apply-error') {
      $('#status').textContent = '尚未应用到节点'; $('#status').dataset.state = 'dirty'; toast(event.data.message);
    }
  });
  send('anyangle-ready');
} else {
  $('#apply').lastChild.textContent = '保存场景'; $('#cancel').textContent = '重载';
  start(params.has('snapshot') ? { version: 1, id: params.get('snapshot') } : null);
}
window.addEventListener('pagehide', () => {
  batchController?.abort();
  for (const pending of batchReplies.values()) { clearTimeout(pending.timer); pending.reject(new Error('工作台已关闭')); }
  batchReplies.clear(); clearTimeout(previewTimer); studio?.dispose();
});
