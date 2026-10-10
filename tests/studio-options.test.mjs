import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { SplatScene } from '../web/editor/splat.mjs';
import { guidePrompt } from '../web/editor/guides.mjs';
import { scenePrompt, actorMode, actorPrompt, buildManifest } from '../web/editor/manifest.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

test('prompt controls select a LoRA-free single guide and preserve user text without rendering', () => {
  const elements = new Map(), changes = [];
  const state = { doc: defaultScene(), begin() {}, changed: preview => changes.push(preview), guidePrompt, scenePrompt, actorMode, actorPrompt, buildManifest,
    studio: { updatePerformance() {} }, schedulePreview() {}, clearTimeout() {}, renderPreview() {},
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } };
  const start = app.indexOf("$('#prompt-mode').onchange");
  vm.runInNewContext(app.slice(start, app.indexOf("$('#model-anyangle').onclick", start)), state);
  elements.get('#prompt-mode').onchange({ target: { value: 'single' } });
  assert.equal(state.doc.conditioning.model, 'base');
  assert.doesNotMatch(guidePrompt(state.doc.conditioning), /<image2>/);
  elements.get('#prompt-extra').oninput({ target: { value: 'An astronaut' } });
  assert.ok(guidePrompt(state.doc.conditioning).endsWith('An astronaut'));
  elements.get('#prompt-mode').onchange({ target: { value: 'custom' } });
  elements.get('#custom-prompt').oninput({ target: { value: '  Follow <image3>.\n' } });
  elements.get('#image-order').onchange({ target: { value: 'guide-first' } });
  assert.equal(guidePrompt(state.doc.conditioning), '  Follow <image3>.\n');
  assert.deepEqual(changes.slice(-2), [false, false]);
});

test('selecting AnyAngle restores the author image order without changing the scene or custom prompts', () => {
  const elements = new Map(), changes = [];
  const state = { doc: defaultScene(), begin() {}, changed: () => changes.push(true),
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } };
  const start = app.indexOf("$('#model-anyangle').onclick");
  vm.runInNewContext(app.slice(start, app.indexOf('document.querySelectorAll', start)), state);
  state.doc.conditioning.model = 'base'; state.doc.conditioning.imageOrder = 'guide-first';
  const camera = structuredClone(state.doc.camera), pose = structuredClone(state.doc.pose);
  elements.get('#model-anyangle').onclick();
  assert.equal(state.doc.conditioning.model, 'anyangle');
  assert.equal(state.doc.conditioning.imageOrder, 'reference-first');
  assert.equal(guidePrompt(state.doc.conditioning), 'Change the camera angle from <image2> to <image1>.');
  assert.deepEqual(state.doc.camera, camera); assert.deepEqual(state.doc.pose, pose);
  elements.get('#model-anyangle').onclick(); assert.equal(changes.length, 1);
  state.doc.conditioning.imageOrder = 'guide-first';
  elements.get('#model-anyangle').onclick();
  assert.equal(state.doc.conditioning.imageOrder, 'reference-first');
  state.doc.conditioning.model = 'base'; state.doc.conditioning.promptMode = 'custom';
  state.doc.conditioning.imageOrder = 'guide-first'; state.doc.conditioning.customPrompt = '  My prompt <image3>.\n';
  elements.get('#model-anyangle').onclick();
  assert.equal(state.doc.conditioning.imageOrder, 'guide-first');
  assert.equal(guidePrompt(state.doc.conditioning), '  My prompt <image3>.\n');
  elements.get('#model-base').onclick();
  assert.equal(state.doc.conditioning.model, 'base');
  assert.equal(state.doc.conditioning.imageOrder, 'guide-first');
});

function bookmarkFixture() {
  const studio = Object.create(StudioScene.prototype), doc = defaultScene();
  studio.doc = doc; doc.source.kind = 'human'; doc.width = 864; doc.height = 1536;
  studio.mode = 'edit'; studio.baseTarget = new THREE.Vector3(0, 10, 0);
  const camera = new THREE.PerspectiveCamera(38, 1.5, 0.1, 1000);
  camera.position.set(12, 22, 34);
  studio.viewer = { THREE, camera, captureCamera: new THREE.PerspectiveCamera(), orbit: { target: new THREE.Vector3(2, 9, 1) },
    _applySAMProjectionCaptureCamera: () => false, requestRender() {}, updateCaptureCamera: PoseViewerCore.prototype.updateCaptureCamera };
  studio.updateShot = () => {
    const c = doc.camera;
    studio.viewer.sceneCameraTarget = studio.baseTarget.clone(); studio.viewer.sceneCameraTarget.z -= c.offsetZ || 0;
    studio.viewer.updateCaptureCamera(doc.width, doc.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
  };
  const captures = [], created = [], elements = new Map();
  const state = { studio, doc, defaultScene, clone: structuredClone, selectedShot: null, previewVisible: true,
    begin() {}, changed() {}, toast() {}, run: task => task(), askName: async () => 'My camera',
    setMode: mode => { studio.mode = mode; studio.updateShot(); }, uuid: () => 'shot-id',
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} }); return elements.get(id); },
    document: { createElement: () => { const element = { classList: { toggle() {} }, append() {}, setAttribute() {} };
      created.push(element); return element; } } };
  studio.capture = async () => {
    captures.push({ camera: structuredClone(doc.camera), pose: structuredClone(doc.pose) });
    return 'data:image/png;thumbnail';
  };
  const start = app.indexOf('function iconButton(');
  vm.runInNewContext(app.slice(start, app.indexOf('function saveLibrary(', start)), state);
  return { state, studio, doc, captures, created, elements };
}

test('bookmarking an edit view captures its actual azimuth, pitch and framing', async () => {
  const { state, studio, doc, captures, elements } = bookmarkFixture();
  const direction = studio.viewer.camera.position.clone().sub(studio.viewer.orbit.target);
  const pose = structuredClone(doc.pose);
  await elements.get('#save-shot').onclick();
  assert.equal(studio.mode, 'camera');
  assert.ok(Math.abs(doc.camera.azimuth - THREE.MathUtils.radToDeg(Math.atan2(direction.x, direction.z))) < 1e-9);
  assert.ok(Math.abs(doc.camera.elevation - THREE.MathUtils.radToDeg(Math.asin(direction.y / direction.length()))) < 1e-9);
  assert.deepEqual(doc.shots[0].camera, captures[0].camera);
  assert.deepEqual(doc.pose, pose);
  assert.equal(state.selectedShot, 'shot-id');
  doc.camera.azimuth = -90;
  assert.notEqual(doc.shots[0].camera.azimuth, -90);
});

test('selecting a bookmark returns to the photo camera and restores all offsets, pitch and dimensions', async () => {
  const { state, studio, doc, created, elements } = bookmarkFixture();
  await elements.get('#save-shot').onclick();
  const saved = structuredClone(doc.shots[0]), pose = structuredClone(doc.pose);
  const thumb = created.find(element => element.className === 'shot-thumb');
  studio.mode = 'edit'; doc.camera = { azimuth: -90, elevation: -30, zoom: 4 }; doc.width = doc.height = 1024;
  thumb.onclick();
  assert.equal(studio.mode, 'camera'); assert.equal(state.previewVisible, false);
  assert.deepEqual(structuredClone(doc.camera), saved.camera);
  assert.deepEqual([doc.width, doc.height], [saved.width, saved.height]);
  assert.deepEqual(doc.pose, pose);
  assert.equal(state.selectedShot, 'shot-id');
});

test('disabling mouse pitch keeps elevation fixed while preserving rotation and middle-button pan', () => {
  const studio = Object.create(StudioScene.prototype), listeners = new Map();
  studio.doc = defaultScene(); studio.doc.interaction.mousePitch = false; studio.mode = 'camera';
  studio.canvas = { addEventListener: (name, listener) => listeners.set(name, listener), setPointerCapture() {},
    getBoundingClientRect: () => ({ width: 800, height: 600 }) };
  studio.callbacks = { begin() {}, change() {}, camera() {} }; studio.updateShot = () => {};
  studio.viewer = { captureCamera: new THREE.PerspectiveCamera() };
  studio.bindCamera();
  const event = props => ({ clientX: 0, clientY: 0, pointerId: 1, button: 0, preventDefault() {}, stopImmediatePropagation() {}, ...props });
  listeners.get('pointerdown')(event()); listeners.get('pointermove')(event({ clientX: 50, clientY: 100 }));
  assert.equal(studio.doc.camera.elevation, 8); assert.notEqual(studio.doc.camera.azimuth, 35);
  listeners.get('pointerup')(event());
  studio.doc.interaction.mousePitch = true;
  listeners.get('pointerdown')(event()); listeners.get('pointermove')(event({ clientY: 20 }));
  assert.equal(studio.doc.camera.elevation, 13);
  listeners.get('pointerup')(event()); studio.doc.interaction.mousePitch = false;
  listeners.get('pointerdown')(event({ button: 1 })); listeners.get('pointermove')(event({ clientX: 20, clientY: 40 }));
  assert.equal(studio.doc.camera.offsetX, 0.5); assert.equal(studio.doc.camera.offsetY, -1);
  assert.equal(studio.doc.camera.elevation, 13);
});

test('manual preview mode cancels stale automatic captures while explicit refresh remains available', async () => {
  let scheduled = 0, refreshed = 0, cancelled = 0;
  const state = { doc: defaultScene(), previewTimer: null, setTimeout: () => scheduled++, clearTimeout: () => cancelled++,
    renderPreview: async () => refreshed++ };
  vm.runInNewContext(app.slice(app.indexOf('function schedulePreview()'), app.indexOf('async function imageCanvas(')), state);
  state.schedulePreview(); assert.equal(scheduled, 1);
  state.doc.interaction.livePreview = false; state.schedulePreview();
  assert.equal(scheduled, 1); assert.equal(cancelled, 2);
  await state.renderPreview(); assert.equal(refreshed, 1);
});

test('preview quality caps display pixels without changing export dimensions', () => {
  const studio = Object.create(StudioScene.prototype); studio.doc = defaultScene();
  const original = Object.getOwnPropertyDescriptor(globalThis, 'devicePixelRatio');
  let ratio = 3;
  studio.viewer = { renderer: { getPixelRatio: () => ratio, setPixelRatio: value => { ratio = value; } }, requestRender() {} };
  Object.defineProperty(globalThis, 'devicePixelRatio', { value: 3, configurable: true });
  try {
    for (const [quality, expected] of [['economy', 1], ['balanced', 1.5], ['sharp', 2]]) {
      studio.doc.interaction.quality = quality; studio.updatePerformance(); assert.equal(ratio, expected);
      assert.deepEqual([studio.doc.width, studio.doc.height], [1024, 1024]);
    }
  } finally { if (original) Object.defineProperty(globalThis, 'devicePixelRatio', original); else delete globalThis.devicePixelRatio; }
});

test('splat sort completion requests one redraw, with no redraw loop while idle or after disposal', async () => {
  let frames = 0, finish;
  const scene = new SplatScene({ requestRender: () => frames++ });
  const viewer = { sortPromise: null, runSplatSort(force) {
    if (force) Promise.resolve().then(() => { this.sortPromise = new Promise(resolve => { finish = resolve; }); });
    return Promise.resolve(!!force);
  } };
  scene.watchSort(viewer);
  await viewer.runSplatSort(true); await flush(); assert.equal(frames, 0);
  await viewer.runSplatSort(false); await viewer.runSplatSort(false);
  finish(); await flush(); assert.equal(frames, 1);
  for (let i = 0; i < 100; i++) await viewer.runSplatSort(false);
  await flush(); assert.equal(frames, 1);
  await viewer.runSplatSort(true); await flush(); scene.disposed = true; finish(); await flush();
  assert.equal(frames, 1);
});

test('opening a splat workbench schedules no continuous scene animation loop', async () => {
  const studio = Object.create(StudioScene.prototype), globals = ['ResizeObserver', 'requestAnimationFrame'];
  const saved = globals.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  let frames = 0;
  globalThis.ResizeObserver = class { observe() {} };
  globalThis.requestAnimationFrame = () => ++frames;
  studio.viewer = { initialized: true, init: async () => {}, camera: new THREE.PerspectiveCamera(), captureCamera: new THREE.PerspectiveCamera(),
    scene: new THREE.Scene(), setDirectionalSkydomeVisible() {}, updateLights() {}, resize() {}, requestRender() {} };
  studio.canvas = { parentElement: { getBoundingClientRect: () => ({ width: 800, height: 600 }) } };
  studio.restore = async doc => { studio.doc = doc; }; studio.bindCamera = () => {};
  const doc = defaultScene(); doc.source.kind = 'splat';
  try { await studio.init(doc); assert.equal(frames, 0); }
  finally { globals.forEach((name, i) => { if (saved[i]) Object.defineProperty(globalThis, name, saved[i]); else delete globalThis[name]; }); }
});
