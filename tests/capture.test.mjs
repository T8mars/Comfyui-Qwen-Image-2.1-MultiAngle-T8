import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { SplatScene } from '../web/editor/splat.mjs';

function fixture() {
  const studio = Object.create(StudioScene.prototype);
  const scene = new THREE.Scene();
  const content = new THREE.Group(), helper = new THREE.Group(), marker = new THREE.Group();
  content.add(marker); scene.add(content, helper, new THREE.AmbientLight());
  scene.background = new THREE.Color('#171f28');
  const renderer = {
    capabilities: { isWebGL2: true, maxSamples: 4 }, target: null,
    viewport: new THREE.Vector4(0, 0, 800, 600), scissor: new THREE.Vector4(10, 20, 400, 300), scissorTest: true,
    getRenderTarget() { return this.target; }, setRenderTarget(target) { this.target = target; },
    getViewport(out) { return out.copy(this.viewport); },
    setViewport(...args) { this.viewport.copy(args.length === 1 ? args[0] : new THREE.Vector4(...args)); },
    getScissor(out) { return out.copy(this.scissor); }, setScissor(out) { this.scissor.copy(out); },
    getScissorTest() { return this.scissorTest; }, setScissorTest(value) { this.scissorTest = value; },
    setSize() { assert.fail('Capture must never resize the visible canvas'); },
    setPixelRatio() { assert.fail('Capture must never resize the visible drawing buffer'); },
    render(currentScene, camera) {
      assert.equal(currentScene, scene);
      assert.notEqual(camera, studio.viewer.camera);
      assert.notEqual(camera, studio.viewer.captureCamera);
      assert.ok(this.target?.isWebGLRenderTarget);
      assert.equal(this.target.texture.colorSpace, studio.splat ? THREE.NoColorSpace : THREE.SRGBColorSpace);
      assert.equal(this.target.width, 2); assert.equal(this.target.height, 2);
      assert.equal(helper.visible, false); assert.equal(marker.visible, studio.doc.source.kind !== 'human');
      assert.equal(content.visible, true); assert.equal(this.scissorTest, false);
      if (this.fail) throw new Error('render failed');
    },
    readRenderTargetPixels(target, x, y, width, height, out) {
      out.set([1, 0, 0, 255, 2, 0, 0, 255, 3, 0, 0, 255, 4, 0, 0, 255]);
    },
  };
  studio.doc = defaultScene(); studio.doc.source.kind = 'human';
  studio.viewer = {
    scene, renderer, skinnedMesh: content, camera: new THREE.PerspectiveCamera(), captureCamera: new THREE.PerspectiveCamera(),
    jointMarkers: [marker], waitForCaptureReady: () => Promise.resolve(),
    updateCaptureCamera(width, height) { this.captureCamera.aspect = width / height; this.captureCamera.updateProjectionMatrix(); },
    beginCaptureBatch() { assert.fail('Visible capture batch must not be used'); },
  };
  studio.updateShot = () => { studio.updated = true; };
  return { studio, renderer, helper, marker, background: scene.background };
}

test('preview capture uses an independent target, flips PNG rows and restores editor state', async () => {
  const { studio, renderer, helper, marker, background } = fixture();
  const camera = studio.viewer.camera.clone();
  let image;
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData: value => { image = value; } }),
    toDataURL: type => { assert.equal(type, 'image/png'); return 'data:image/png;test'; },
  }) };
  try {
    assert.equal(await studio.capture(2, 2), 'data:image/png;test');
    assert.deepEqual([...image.data.filter((_, i) => i % 4 === 0)], [3, 4, 1, 2]);
    assert.equal(renderer.target, null);
    assert.deepEqual(renderer.viewport.toArray(), [0, 0, 800, 600]);
    assert.deepEqual(renderer.scissor.toArray(), [10, 20, 400, 300]);
    assert.equal(renderer.scissorTest, true);
    assert.equal(helper.visible, true); assert.equal(marker.visible, true);
    assert.equal(studio.viewer.scene.background, background);
    assert.deepEqual(studio.viewer.camera.projectionMatrix.toArray(), camera.projectionMatrix.toArray());
    assert.equal(studio.capturing, false); assert.equal(studio.updated, true);
  } finally { globalThis.document = oldDocument; }
});

test('failed capture restores the visible renderer and helpers before resuming interaction', async () => {
  const { studio, renderer, helper, marker, background } = fixture();
  renderer.fail = true;
  await assert.rejects(studio.capture(2, 2), /render failed/);
  assert.equal(renderer.target, null); assert.equal(renderer.scissorTest, true);
  assert.deepEqual(renderer.viewport.toArray(), [0, 0, 800, 600]);
  assert.equal(helper.visible, true); assert.equal(marker.visible, true);
  assert.equal(studio.viewer.scene.background, background);
  assert.equal(studio.capturing, false); assert.equal(studio.updated, true);
});

for (const kind of ['human', 'glb']) test(`Canny clay capture preserves ${kind} colors, helpers and background even on failure`, async () => {
  const { studio, renderer, helper, marker, background } = fixture();
  studio.doc.source.kind = kind; studio.doc.conditioning.colorActors = true;
  if (kind === 'glb') studio.glb = studio.viewer.skinnedMesh;
  const originalOverride = new THREE.MeshBasicMaterial({ color: '#123456' });
  studio.viewer.scene.overrideMaterial = originalOverride;
  let clay, disposed = 0;
  const render = renderer.render;
  renderer.render = function(scene, camera) {
    clay = scene.overrideMaterial;
    assert.equal(clay.isMeshStandardMaterial, true);
    assert.equal(clay.color.getHexString(), 'eeeeee');
    assert.equal(clay.side, THREE.DoubleSide);
    assert.equal(scene.background.getHexString(), '000000');
    clay.addEventListener('dispose', () => disposed++);
    render.call(this, scene, camera);
    throw new Error('clay render failed');
  };
  await assert.rejects(studio.capture(2, 2, { canny: true }), /clay render failed/);
  assert.equal(studio.viewer.scene.overrideMaterial, originalOverride);
  assert.equal(studio.viewer.scene.background, background);
  assert.equal(studio.doc.conditioning.colorActors, true);
  assert.equal(helper.visible, true); assert.equal(marker.visible, true);
  assert.equal(renderer.target, null); assert.equal(studio.capturing, false);
  assert.equal(disposed, 1);
});

test('splat offscreen dimensions are independent of display size and high DPI', () => {
  const core = { renderer: {}, camera: new THREE.PerspectiveCamera() };
  const splat = new SplatScene(core);
  const original = out => out.set(800, 600);
  let restored = false;
  splat.dropIn = { viewer: {
    getRenderDimensions: original, devicePixelRatio: 2, splatMesh: { devicePixelRatio: 2 },
    updateForDropInMode(renderer, camera) { assert.equal(renderer, core.renderer); assert.equal(camera, core.camera); },
    updateSplatMesh() { restored = true; },
  } };
  const restore = splat.beginOffscreenCapture(1024, 1536), viewer = splat.dropIn.viewer;
  const size = new THREE.Vector2(); viewer.getRenderDimensions(size);
  assert.deepEqual(size.toArray(), [1024, 1536]);
  assert.equal(viewer.devicePixelRatio, 1); assert.equal(viewer.splatMesh.devicePixelRatio, 1);
  restore(); viewer.getRenderDimensions(size);
  assert.equal(viewer.getRenderDimensions, original); assert.deepEqual(size.toArray(), [800, 600]);
  assert.equal(viewer.devicePixelRatio, 2); assert.equal(viewer.splatMesh.devicePixelRatio, 2);
  assert.equal(restored, true);
});

test('waiting for splat sorting leaves the workbench visible and freezes only the capture camera', async () => {
  const { studio, renderer, helper, background } = fixture();
  studio.doc.source.kind = 'splat';
  let release, started, captureCamera, restored = false;
  const sorted = new Promise(resolve => { release = resolve; });
  const preparing = new Promise(resolve => { started = resolve; });
  studio.splat = {
    root: studio.viewer.skinnedMesh,
    configureCamera(camera) { camera.position.set(2, 3, 4); },
    beginOffscreenCapture() { return () => { restored = true; }; },
    async prepareCapture(currentRenderer, camera) { assert.equal(currentRenderer, renderer); captureCamera = camera; started(); await sorted; },
  };
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    toDataURL: () => 'data:image/png;test',
  }) };
  try {
    const pending = studio.capture(2, 2); await preparing;
    assert.equal(helper.visible, true); assert.equal(studio.viewer.scene.background, background);
    assert.equal(renderer.target, null);
    studio.viewer.captureCamera.position.set(99, 99, 99);
    assert.deepEqual(captureCamera.position.toArray(), [2, 3, 4]);
    release(); await pending;
    assert.equal(restored, true); assert.equal(studio.capturing, false);
    assert.equal(helper.visible, true); assert.equal(renderer.target, null);
  } finally { globalThis.document = oldDocument; }
});
