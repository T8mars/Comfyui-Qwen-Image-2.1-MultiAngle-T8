import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { createActor, applySceneTemplate } from '../web/editor/actors.mjs';
import { cameraBatchPlan, runCameraBatch } from '../web/editor/batch.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const points = [new THREE.Vector3(5, 9, -1), new THREE.Vector3(0, 18, 3), new THREE.Vector3(7, -8, -2)];
const projection = studio => {
  studio.viewer.captureCamera.updateMatrixWorld(true);
  return points.map(point => point.clone().project(studio.viewer.captureCamera).toArray());
};
function closeProjection(actual, expected) {
  actual.flat().forEach((value, i) => assert.ok(Math.abs(value - expected.flat()[i]) < 1e-10, `projection ${i}: ${value} != ${expected.flat()[i]}`));
}
function fixture() {
  const doc = defaultScene(); doc.source.kind = 'human'; doc.width = 864; doc.height = 1536;
  doc.cameraTarget = [2, 7, -1]; Object.assign(doc.camera, { azimuth: -30, elevation: 14, offsetX: 1.5, offsetY: -2, offsetZ: 2, focalLength: 85 });
  doc.actors = [createActor(0, { id: 'Alice' }), createActor(1, { id: 'Bob' })];
  const studio = Object.create(StudioScene.prototype); studio.doc = doc; studio.mode = 'camera'; studio.baseTarget = new THREE.Vector3(...doc.cameraTarget);
  studio.photoFrame = {}; studio.shotHelper = { update() {} };
  const camera = new THREE.PerspectiveCamera(38, 1.6, .1, 1000);
  studio.viewer = { THREE, camera, captureCamera: new THREE.PerspectiveCamera(30, 1, .1, 1000), captureFrame: new THREE.Object3D(),
    orbit: { target: new THREE.Vector3(), update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } },
    _applySAMProjectionCaptureCamera: () => false, requestRender() {}, updateCaptureCamera: PoseViewerCore.prototype.updateCaptureCamera };
  studio.updateShot();
  const created = [], elements = new Map();
  const state = { studio, doc, defaultScene, clone: structuredClone, selectedShot: null, previewVisible: false,
    begin() {}, changed() {}, toast() {}, run: task => task(), askName: async () => 'Saved framing',
    setMode: mode => { studio.mode = mode; studio.updateShot(true); }, uuid: () => 'saved-shot',
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} }); return elements.get(id); },
    document: { createElement: () => { const element = { classList: { toggle() {} }, append() {}, setAttribute() {} }; created.push(element); return element; } } };
  studio.capture = async () => 'data:image/png;saved-camera';
  const start = app.indexOf('function iconButton(');
  vm.runInNewContext(app.slice(start, app.indexOf('function saveLibrary(', start)), state);
  return { doc, studio, state, created, elements };
}

test('actual bookmark handlers restore the full Three camera projection after a template changes its target, without touching actors', async () => {
  const { doc, studio, created, elements } = fixture(), expected = projection(studio);
  await elements.get('#save-shot').onclick();
  assert.deepEqual(doc.shots[0].cameraTarget, [2, 7, -1]);
  applySceneTemplate(doc, { actors: doc.actors.map(actor => ({ ...structuredClone(actor), pose: { bones: { head: [0, 25, 0] } } })),
    cameraTarget: [70, -9, 8], camera: { ...doc.camera, azimuth: 70, zoom: 3 } });
  studio.updateShot(); assert.notDeepEqual(projection(studio), expected);
  const actorsAfterTemplate = structuredClone(doc.actors);
  created.find(element => element.className === 'shot-thumb').onclick();
  closeProjection(projection(studio), expected);
  assert.deepEqual(doc.actors, actorsAfterTemplate); assert.deepEqual(studio.baseTarget.toArray(), [2, 7, -1]);
});

test('legacy bookmarks without target retain the current scene target', async () => {
  const { doc, studio, created, elements } = fixture(); await elements.get('#save-shot').onclick();
  delete doc.shots[0].cameraTarget; doc.cameraTarget = [50, 3, 14]; studio.updateShot();
  created.find(element => element.className === 'shot-thumb').onclick();
  assert.deepEqual(doc.cameraTarget, [50, 3, 14]); assert.deepEqual(studio.baseTarget.toArray(), [50, 3, 14]);
});

test('saved camera batches carry distinct targets; the following legacy view uses the base target and final restoration restores it', async () => {
  const { doc, studio, elements } = fixture(), expected = projection(studio); await elements.get('#save-shot').onclick();
  doc.cameraTarget = [70, -9, 8]; studio.updateShot(); const currentProjection = projection(studio);
  doc.shots.push({ name: 'Legacy current target', camera: structuredClone(doc.shots[0].camera), width: doc.width, height: doc.height });
  const originalActors = structuredClone(doc.actors), captures = [], views = [...cameraBatchPlan(doc, { mode: 'saved' }).views()];
  assert.deepEqual(views.map(view => view.scene.cameraTarget), [[2, 7, -1], [70, -9, 8]]);
  const result = await runCameraBatch(cameraBatchPlan(doc, { mode: 'saved' }), {
    capture: async view => { studio.doc = view; studio.updateShot(); captures.push(projection(studio)); assert.deepEqual(view.actors, originalActors); return 'png'; },
    save: async () => ({ version: 1, id: 'a'.repeat(64) }),
  });
  assert.equal(result.error, null); closeProjection(captures[0], expected); closeProjection(captures[1], currentProjection);
  assert.deepEqual(result.views.map(view => view.cameraTarget), [[2, 7, -1], [70, -9, 8]]);
  studio.doc = doc; studio.updateShot(); closeProjection(projection(studio), currentProjection);
  assert.deepEqual(doc.actors, originalActors); assert.deepEqual(studio.baseTarget.toArray(), [70, -9, 8]);
});
