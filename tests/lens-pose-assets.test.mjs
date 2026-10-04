import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { parseMorphPack, solveMorph } from '../web/vendor/vnccs_pose_morph_runtime.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { configureSplatCamera } from '../web/editor/splat.mjs';
import { applyLens, lensSettings } from '../web/editor/lens.mjs';
import { randomPose } from '../web/editor/poses.mjs';
import { copyVisiblePose } from '../web/editor/openpose.mjs';
import { loadHumanPack, HumanAssetError } from '../web/editor/human.mjs';

const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const bytes = readFileSync(new URL('../web/vendor/assets/pose_studio_makehuman.v2.bin', import.meta.url));
const packBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

test('lens changes perspective while holding the target plane size and image position', () => {
  for (const aspect of [1, 16 / 9, 9 / 16]) for (const zoom of [0.6, 1.3, 3]) {
    const target = new THREE.Vector3(3, 10, -2);
    const base = new THREE.PerspectiveCamera(30, aspect, .1, 1000);
    base.position.copy(target).add(new THREE.Vector3(0, 0, 45)); base.zoom = zoom;
    base.lookAt(target); base.updateMatrixWorld(true); base.updateProjectionMatrix();
    const planePoint = target.clone().add(new THREE.Vector3(2, 3, 0));
    const nearPoint = planePoint.clone().add(new THREE.Vector3(0, 0, 4));
    const expected = planePoint.clone().project(base);
    const sizes = [];
    for (const focal of [24, 50, 85, 200]) {
      const camera = base.clone(); applyLens(camera, target, focal);
      const projected = planePoint.clone().project(camera);
      close(projected.x, expected.x); close(projected.y, expected.y);
      close(camera.fov, 2 * Math.atan(12 / focal) * 180 / Math.PI);
      sizes.push(nearPoint.clone().project(camera).x);
    }
    assert.ok(sizes[0] > sizes[1] && sizes[1] > sizes[2] && sizes[2] > sizes[3]);
  }
  assert.deepEqual(lensSettings(30, 0), { fov: 30, distanceScale: 1 });
  assert.throws(() => lensSettings(30, -1));
});

function cameraFixture() {
  const studio = Object.create(StudioScene.prototype);
  studio.doc = defaultScene(); studio.doc.source.kind = 'human'; studio.mode = 'camera';
  studio.baseTarget = new THREE.Vector3(0, 10, 0);
  studio.photoFrame = {}; studio.shotHelper = { update() {} };
  const camera = new THREE.PerspectiveCamera(38, 1.6, .1, 1000);
  studio.viewer = { THREE, camera, captureCamera: new THREE.PerspectiveCamera(30, 1, .1, 1000),
    captureFrame: new THREE.Object3D(), orbit: { target: new THREE.Vector3(), update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } },
    _applySAMProjectionCaptureCamera: () => false, requestRender() {}, updateCaptureCamera: PoseViewerCore.prototype.updateCaptureCamera };
  return studio;
}

test('workbench, capture and bookmarks retain custom lens projection across aspect changes', () => {
  const studio = cameraFixture();
  for (const [width, height] of [[1024, 1024], [1536, 864], [864, 1536]]) {
    Object.assign(studio.doc, { width, height });
    for (const focal of [0, 24, 85]) {
      Object.assign(studio.doc.camera, { focalLength: focal, offsetX: 2, offsetY: -1, offsetZ: 3 });
      studio.updateShot();
      const camera = studio.viewer.captureCamera.clone();
      studio.configureCapture(width, height);
      assert.deepEqual(studio.viewer.captureCamera.projectionMatrix.elements, camera.projectionMatrix.elements);
      assert.deepEqual(studio.viewer.camera.position.toArray(), camera.position.toArray());
      const zoom = studio.doc.camera.zoom; studio.currentViewAsShot();
      close(studio.doc.camera.zoom, zoom / (1.12 * Math.max(1, (width / height) / studio.viewer.camera.aspect)));
      assert.equal(studio.doc.camera.focalLength, focal);
    }
  }
});

test('splat lenses preserve crop alignment and panning at the target depth', () => {
  const source = { camera_token: [0, -1, 0, .5, .8], bounds: [[-.5, -.5, -.5], [.5, .5, .5]],
    reference: { width: 1000, height: 800 }, crop: [100, 30, 740, 670] };
  const settings = { azimuth: 35, elevation: 12, zoom: 1.4, offsetX: 2, offsetY: -1, offsetZ: .5 };
  const baseline = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(baseline, source, settings, 864, 1536);
  const horizontal = new THREE.Vector3(1, 0, 0).applyQuaternion(baseline.quaternion);
  const point = target.clone().addScaledVector(horizontal, 2), expected = point.clone().project(baseline);
  for (const focal of [24, 50, 85]) {
    const camera = new THREE.PerspectiveCamera();
    configureSplatCamera(camera, source, { ...settings, focalLength: focal }, 864, 1536);
    const projected = point.clone().project(camera); close(projected.x, expected.x); close(projected.y, expected.y);
    assert.ok(camera.near > 0 && camera.far > camera.near);
  }
});

test('random poses are reproducible, vary by seed, and only use bundled rig bones', () => {
  const names = new Set(parseMorphPack(packBuffer).bones.map(bone => bone.name));
  for (const category of ['standing', 'action', 'seated', 'mixed']) {
    assert.deepEqual(randomPose(42, category), randomPose(42, category));
    assert.notDeepEqual(randomPose(42, category), randomPose(43, category));
    for (let seed = 0; seed < 500; seed++) {
      const pose = randomPose(seed, category);
      for (const [name, angles] of Object.entries(pose.bones)) {
        assert.ok(names.has(name), name); assert.equal(angles.length, 3);
        assert.ok(angles.every(value => Number.isFinite(value) && Math.abs(value) < 130));
      }
      assert.ok(pose.bones.calf_l[0] >= 0 && pose.bones.calf_r[0] >= 0);
    }
  }
  assert.throws(() => randomPose(-1)); assert.throws(() => randomPose(1.5)); assert.throws(() => randomPose(1, 'other'));
});

const photo = { head: [128, 25], neck: [128, 50], rs: [95, 50], re: [75, 95], rw: [85, 135],
  ls: [161, 50], le: [181, 95], lw: [165, 135], rh: [106, 130], rk: [100, 185], ra: [98, 235],
  lh: [150, 130], lk: [155, 185], la: [160, 235] };
const rest = Object.fromEntries(Object.entries({ ...photo, hipMid: [128, 130], pelvis: [128, 130] })
  .map(([key, [x, y]]) => [key, [(x - 128) / 20, (235 - y) / 20, 0]]));

test('visible pose copy preserves segment lengths and never creates missing legs', () => {
  const upper = Object.fromEntries(Object.entries(photo).filter(([name]) => !['rh', 'rk', 'ra', 'lh', 'lk', 'la'].includes(name)));
  const copied = copyVisiblePose(upper, rest);
  assert.deepEqual(copied.hipMid, rest.pelvis);
  assert.deepEqual(copied.neck, rest.neck);
  for (const name of ['lh', 'lk', 'la', 'rh', 'rk', 'ra']) assert.equal(copied[name], undefined);
  for (const [a, b] of [['ls', 'le'], ['le', 'lw'], ['rs', 're'], ['re', 'rw']]) {
    close(Math.hypot(...copied[a].map((value, i) => value - copied[b][i])), Math.hypot(...rest[a].map((value, i) => value - rest[b][i])));
    assert.ok(copied[b].every(Number.isFinite)); assert.equal(copied[b][2], rest.neck[2]);
  }
  assert.throws(() => copyVisiblePose({ neck: photo.neck }, rest), /左右肩/);
  assert.throws(() => copyVisiblePose({ ...upper, le: upper.ls }, rest), /重合/);
});

test('copying a half-body photo through the native IK keeps unseen leg bone rotations', () => {
  const pack = parseMorphPack(packBuffer), morph = solveMorph(pack, defaultScene().mesh);
  const viewer = Object.create(PoseViewerCore.prototype);
  Object.assign(viewer, { THREE, bones: {}, boneList: [], skinnedMesh: new THREE.Group(),
    shapedBoneRestPositions: {}, modelRotation: { x: 0, y: 0, z: 0 }, camera: new THREE.PerspectiveCamera(),
    orbit: { target: new THREE.Vector3() }, updateIKEffectorPositions() {}, updateMarkers() {}, requestRender() {} });
  pack.bones.forEach((source, i) => {
    const bone = new THREE.Bone(); bone.name = source.name;
    bone.position.fromArray(morph.bonePositions, i * 6);
    bone.userData.parentName = source.parent;
    viewer.bones[bone.name] = bone; viewer.boneList.push(bone);
  });
  for (const bone of viewer.boneList) {
    const parent = viewer.bones[bone.userData.parentName];
    const local = bone.position.clone(); if (parent) local.sub(parent.position);
    viewer.shapedBoneRestPositions[bone.name] = local;
  }
  for (const bone of viewer.boneList) {
    (viewer.bones[bone.userData.parentName] || viewer.skinnedMesh).add(bone);
    bone.position.copy(viewer.shapedBoneRestPositions[bone.name]);
  }
  viewer.skeleton = new THREE.Skeleton(viewer.boneList); viewer.initIK();
  viewer.bones.thigh_l.rotation.x = -.35; viewer.bones.calf_l.rotation.x = .6;
  viewer.skinnedMesh.updateMatrixWorld(true);
  const before = ['thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r'].map(name => [viewer.bones[name].rotation.toArray(), viewer.bones[name].position.toArray()]);
  const studio = Object.create(StudioScene.prototype); studio.viewer = viewer;
  studio.doc = defaultScene(); studio.doc.source.kind = 'human'; studio.doc.conditioning = { model: 'base', guide: 'pose' };
  studio.updateShot = () => {};
  const upper = Object.fromEntries(Object.entries(photo).filter(([name]) => !['rh', 'rk', 'ra', 'lh', 'lk', 'la'].includes(name)));
  studio.applyOpenPose(upper, {}, 'conservative');
  const after = ['thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r'].map(name => [viewer.bones[name].rotation.toArray(), viewer.bones[name].position.toArray()]);
  assert.deepEqual(after, before);
  assert.ok(viewer.boneList.every(bone => [bone.rotation.x, bone.rotation.y, bone.rotation.z].every(Number.isFinite)));
  assert.ok(Math.abs(viewer.bones.upperarm_l.rotation.z) > .01);
});

test('human loading uses the bundled binary and classifies missing, damaged and timed-out files', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      assert.ok(String(url).endsWith('/vendor/assets/pose_studio_makehuman.v2.bin'));
      assert.equal(options.cache, 'no-cache');
      return { ok: true, arrayBuffer: async () => packBuffer };
    };
    assert.ok((await loadHumanPack()).vertexCount > 1000);
    globalThis.fetch = async () => ({ ok: false, status: 404 });
    await assert.rejects(loadHumanPack(), error => error instanceof HumanAssetError && /404/.test(error.message));
    globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(12) });
    await assert.rejects(loadHumanPack(), /损坏/);
    globalThis.fetch = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
    await assert.rejects(loadHumanPack(5), /超时/);
  } finally { globalThis.fetch = originalFetch; }
});

test('an unresponsive skin texture cannot keep the workbench loading indefinitely', async () => {
  const studio = Object.create(StudioScene.prototype); studio.doc = defaultScene(); studio.doc.source.kind = 'human';
  studio.viewer = { waitForCaptureReady: () => new Promise(() => {}) };
  await assert.rejects(studio.waitForCaptureReady(5), error => error.name === 'HumanAssetError' && /贴图加载超时/.test(error.message));
});

test('failed startup stops the spinner and offers resource repair outside the inert workspace', () => {
  const elements = new Map();
  const state = { $: selector => {
    if (!elements.has(selector)) elements.set(selector, { showModal() { this.open = true; } });
    return elements.get(selector);
  } };
  vm.runInNewContext(app.slice(app.indexOf('function showLoadError('), app.indexOf('function error(')), state);
  state.showLoadError(new HumanAssetError('missing'));
  assert.equal(elements.get('#loading').hidden, true);
  assert.equal(elements.get('#repair-human').hidden, false);
  assert.equal(elements.get('#load-error-dialog').open, true);
  state.showLoadError(new Error('GPU unavailable'));
  assert.equal(elements.get('#repair-human').hidden, true);
  const html = readFileSync(new URL('../web/editor/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="load-error-dialog"') > html.indexOf('</main>'));
});

test('one-click photo copying extracts visible joints and retargets to the editable base-model rig', async () => {
  const elements = new Map(), upper = Object.fromEntries(Object.entries(photo).filter(([key]) => !['rh', 'rk', 'ra', 'lh', 'lk', 'la'].includes(key)));
  let copied = 0, fitted = 0, tools = 0;
  const state = { doc: defaultScene(), clone: structuredClone, defaultScene,
    previewVisible: false, begin() {}, changed() {}, toast() {}, run: task => task(),
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    setMode() {}, ensureHumanTools: async () => tools++,
    studio: { restore: async () => {}, fit: () => fitted++,
      applyOpenPose(points, flips, mode) {
        assert.equal(mode, 'conservative'); assert.equal(points.la, undefined);
        copyVisiblePose(points, rest); copied++; return false;
      } },
    fetch: async (url, options) => {
      assert.equal(url, '/anyangle-studio/dwpose'); assert.equal(JSON.parse(options.body).reference, 'photo.png');
      return { ok: true, json: async () => ({ asset: { name: 'pose.png' }, points: upper, fullBody: false, visibleOnly: true }) };
    } };
  state.doc.reference = { name: 'photo.png' };
  vm.runInNewContext(app.slice(app.indexOf('async function applyOpenPoseAsset('), app.indexOf("$('#retarget-pose').onclick")), state);
  vm.runInNewContext(app.slice(app.indexOf('async function extractPhotoPose('), app.indexOf("$('#import-map').onclick")), state);
  await elements.get('#extract-pose').onclick();
  assert.equal(copied, 0); assert.equal(state.doc.source.kind, 'empty'); assert.equal(state.doc.conditioning.map.name, 'pose.png');
  await elements.get('#copy-photo-pose').onclick();
  assert.equal(copied, 1); assert.equal(fitted, 1); assert.equal(tools, 1);
  assert.equal(state.doc.source.kind, 'human'); assert.equal(state.doc.conditioning.model, 'base');
  assert.equal(state.doc.conditioning.guide, 'pose'); assert.equal(state.doc.conditioning.map, null);
  assert.equal(state.doc.openpose.useRig, true); assert.equal(state.previewVisible, false);
  assert.equal(elements.get('#loading').hidden, true);
});

test('random pose UI preserves camera lens and reproduces the entered seed', () => {
  const elements = new Map(), generated = [];
  const state = { doc: defaultScene(), randomPose, previewVisible: true,
    begin() {}, changed() {}, toast() {}, error: assert.fail,
    document: { querySelectorAll: () => [] }, crypto: { getRandomValues: array => { array[0] = 42; return array; } },
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    studio: { setPreset: pose => generated.push(pose), fit() {} } };
  state.doc.source.kind = 'human'; state.doc.camera.focalLength = 85;
  state.$('#pose-category').value = 'action'; state.$('#pose-seed').value = '42';
  vm.runInNewContext(app.slice(app.indexOf('function applyRandomPose('), app.indexOf("$('#load-error-close').onclick")), state);
  elements.get('#random-pose').onclick(); elements.get('#repeat-pose').onclick();
  assert.deepEqual(generated[0], generated[1]); assert.equal(state.doc.poseRandom.seed, 42);
  assert.equal(state.doc.camera.focalLength, 85); assert.equal(state.previewVisible, false);
});
