import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene, PRESETS } from '../web/editor/scene.mjs';
import { guideSource } from '../web/editor/guides.mjs';
import { saveActor, activeActor } from '../web/editor/actors.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');

function rig() {
  const studio = Object.create(StudioScene.prototype);
  studio.doc = defaultScene(); studio.doc.source.kind = 'human';
  studio.doc.conditioning = { model: 'base', guide: 'pose', mapKind: 'pose', mapOrigin: 'dwpose', map: { name: 'original.png' } };
  studio.doc.openpose = { origin: 'dwpose', fullBody: false, rawAsset: studio.doc.conditioning.map };
  let pose = structuredClone(studio.doc.pose);
  studio.viewer = { getPose: () => pose, setPose: value => { pose = structuredClone(value); } };
  studio.setMode = () => {};
  return studio;
}

test('editing a rig replaces the extracted image with the current 3D pose guide', () => {
  const studio = rig();
  studio.viewer.setPose({ bones: { upperarm_l: [0, 0, 100] } });
  studio.syncPose();
  assert.equal(guideSource(studio.doc).kind, 'pose');
  assert.equal(studio.doc.openpose.useRig, true);
  assert.equal(studio.doc.openpose.rawAsset.name, 'original.png');
  assert.equal(studio.doc.conditioning.mapOrigin, 'rig');
});

test('selecting even the current preset explicitly uses the rig rather than a cropped image', () => {
  const studio = rig();
  studio.setPreset(PRESETS[0]);
  assert.equal(guideSource(studio.doc).kind, 'pose');
  assert.equal(studio.doc.openpose.useRig, true);
});

test('camera changes, restoration and thumbnail generation preserve the original pose image', () => {
  const studio = rig();
  studio.doc.camera.azimuth = 90; studio.syncPose();
  assert.equal(guideSource(studio.doc).kind, 'image');
  studio.restoring = true; studio.setPreset(PRESETS[3]);
  assert.equal(guideSource(studio.doc).kind, 'image');
  assert.equal(studio.doc.openpose.useRig, undefined);
});

test('reopening sparse saved poses preserves original-image and edited-rig output choices', async () => {
  for (const edited of [false, true]) {
    const studio = rig();
    if (edited) studio.setPreset(PRESETS[3]);
    studio.doc = JSON.parse(JSON.stringify(studio.doc));
    const normalized = { ...studio.doc.pose, bonePositions: {}, modelRotation: [0, 0, 0], ikEffectorPositions: {} };
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshBasicMaterial());
    const cameras = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
    Object.assign(studio.viewer, { camera: cameras[0], captureCamera: cameras[1], skinnedMesh: mesh,
      meshCenter: new THREE.Vector3(0, 1, 0), setMannequinVisible() {}, waitForCaptureReady: async () => {} });
    studio.actorRoots = new Map(); studio.viewer.clearPassiveCharacters = () => {};
    studio.humanBounds = () => new THREE.Box3().setFromObject(mesh);
    studio.cameraClips = cameras.map(camera => ({ near: camera.near, far: camera.far }));
    studio.pack = {}; studio.grid = new THREE.Object3D(); studio.ring = new THREE.Object3D();
    studio.buildHuman = () => studio.viewer.setPose(normalized); studio.updateShot = () => {};
    await studio.restore(studio.doc);
    studio.doc.camera.azimuth = 90; studio.syncPose();
    assert.deepEqual(studio.doc.pose, normalized);
    assert.equal(studio.doc.openpose.useRig, edited ? true : undefined);
    assert.equal(guideSource(studio.doc).kind, edited ? 'pose' : 'image');
    assert.equal(studio.doc.openpose.rawAsset.name, 'original.png');
    mesh.geometry.dispose(); mesh.material.dispose();
  }
});

test('editing a pose preserves independently selected depth and canny images', () => {
  for (const guide of ['depth', 'canny']) {
    const studio = rig();
    studio.doc.conditioning.guide = studio.doc.conditioning.mapKind = guide;
    studio.setPreset(PRESETS[3]);
    assert.equal(guideSource(studio.doc).kind, 'image');
    assert.equal(studio.doc.conditioning.map.name, 'original.png');
  }
});

test('pose depth flips cannot retarget an unparsed or cropped photo after manual editing', () => {
  for (const openpose of [{ points: null, flips: {} }, { points: { head: [0.5, 0.2] }, fullBody: false, flips: {} }]) {
    const button = { dataset: { flip: 'leftArm' } };
    const state = { doc: { source: { kind: 'human' }, openpose }, activeActor, document: { querySelectorAll: () => [button] },
      begin: () => assert.fail('Unavailable retarget controls must not change state') };
    const start = app.indexOf("document.querySelectorAll('[data-flip]').forEach(button => {");
    vm.runInNewContext(app.slice(start, app.indexOf("$('#reference-button').onclick", start)), state);
    button.onclick();
    assert.deepEqual(openpose.flips, {});
  }
});

test('switching guide modes keeps an edited rig and original-image output remains selectable', async () => {
  const studio = rig(); studio.setPreset(PRESETS[3]);
  studio.doc.conditioning.guide = 'coarse';
  const buttons = ['pose', 'coarse', 'depth', 'canny'].map(guide => ({ dataset: { guide } }));
  const elements = new Map();
  const state = {
    doc: studio.doc, document: { querySelectorAll: () => buttons },
    $: name => { if (!elements.has(name)) elements.set(name, {}); return elements.get(name); },
    run: action => action(), begin() {}, changed() {}, refresh() {},
    linkedStructure: { connected: false }, usesLocalGuide: () => true,
    currentGuide: () => studio.doc.conditioning.guide,
  };
  const guideHandlers = app.indexOf("document.querySelectorAll('[data-guide]').forEach(button => button.onclick");
  vm.runInNewContext(app.slice(guideHandlers, app.indexOf("for (const [id, key]", guideHandlers)), state);
  await buttons[0].onclick();
  assert.equal(guideSource(studio.doc).kind, 'pose');
  vm.runInNewContext(app.slice(app.indexOf("$('#pose-original').onclick"), app.indexOf('async function applyStructureAsset')), state);
  elements.get('#pose-original').onclick();
  assert.equal(studio.doc.openpose.useRig, false);
  assert.equal(guideSource(studio.doc).asset.name, 'original.png');
});

test('preset thumbnails fit full bounds in their own aspect and restore the working scene', async () => {
  const studio = rig(), working = studio.doc;
  working.width = 864; working.height = 1536; working.camera.zoom = 4;
  const saved = structuredClone(working), captures = [];
  const content = new THREE.Mesh(new THREE.BoxGeometry(16, 36, 6), new THREE.MeshBasicMaterial());
  content.position.y = 18;
  studio.baseTarget = new THREE.Vector3(0, 10, 0);
  Object.assign(studio.viewer, { THREE, skinnedMesh: content, captureCamera: new THREE.PerspectiveCamera(),
    _applySAMProjectionCaptureCamera: () => false, requestRender() {},
    updateCaptureCamera: PoseViewerCore.prototype.updateCaptureCamera });
  studio.updateShot = () => {
    const c = working.camera;
    studio.viewer.sceneCameraTarget = studio.baseTarget.clone();
    studio.viewer.sceneCameraTarget.z -= c.offsetZ || 0;
    studio.viewer.updateCaptureCamera(working.width, working.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
    studio.viewer.captureCamera.updateMatrixWorld(true);
  };
  studio.capture = async (width, height) => {
    assert.deepEqual([working.width, working.height], [width, height]);
    const bounds = new THREE.Box3().setFromObject(content);
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(x, y, z).project(studio.viewer.captureCamera);
      assert.ok(Math.abs(point.x) <= 0.831 && Math.abs(point.y) <= 0.831, `clipped thumbnail: ${point.toArray()}`);
    }
    captures.push([width, height]); return 'data:image/png;thumbnail';
  };
  const shelf = { replaceChildren() {}, append() {} };
  const state = {
    studio, PRESETS, clone: structuredClone, saveActor,
    $: () => shelf, document: { createElement: () => ({ append() {} }) },
  };
  vm.runInNewContext(app.slice(app.indexOf('async function buildPresetCards()'), app.indexOf('async function ensureHumanTools()')), state);
  await state.buildPresetCards();
  assert.equal(captures.length, PRESETS.length);
  assert.deepEqual(working, saved);
  assert.equal(studio.restoring, false);
  content.geometry.dispose(); content.material.dispose();
});
