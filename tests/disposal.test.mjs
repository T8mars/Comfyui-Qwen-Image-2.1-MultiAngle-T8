import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';

function fixture() {
  const viewer = new PoseViewerCore({ width: 64, height: 64 });
  viewer.THREE = THREE; viewer.scene = new THREE.Scene();
  let rendererDisposed = false;
  viewer.renderer = { dispose() { rendererDisposed = true; } };
  const counts = new Map();
  const track = (resource, label) => {
    counts.set(label, 0);
    resource.addEventListener('dispose', () => {
      assert.equal(rendererDisposed, false, `${label} must release while renderer owns its listeners`);
      counts.set(label, counts.get(label) + 1);
    });
    return resource;
  };
  return { viewer, counts, track, rendererDisposed: () => rendererDisposed };
}

test('viewer close releases shared skin only after passive teardown, and deduplicates GLB maps and line resources', () => {
  const { viewer, counts, track, rendererDisposed } = fixture();
  const skin = track(new THREE.Texture(), 'shared skin');
  const map = track(new THREE.Texture(), 'GLB map');
  viewer.cachedSkinTexture = skin;
  const active = new THREE.Mesh(track(new THREE.BoxGeometry(), 'active geometry'), track(new THREE.MeshBasicMaterial({ map: skin }), 'active material'));
  const passive = new THREE.Mesh(track(new THREE.BoxGeometry(), 'passive geometry'), track(new THREE.MeshBasicMaterial({ map: skin }), 'passive material'));
  viewer.scene.add(active, passive); viewer.skinnedMesh = active;
  viewer.passiveCharacters.set('second', { mesh: passive });
  passive.geometry.addEventListener('dispose', () => assert.equal(counts.get('shared skin'), 0));
  const geometry = track(new THREE.BoxGeometry(), 'GLB geometry'), material = track(new THREE.MeshBasicMaterial({ map }), 'GLB material');
  viewer.scene.add(new THREE.Mesh(geometry, material), new THREE.Mesh(geometry, material));
  const lineGeometry = track(new THREE.BufferGeometry(), 'line geometry'), lineMaterial = track(new THREE.LineBasicMaterial(), 'line material');
  viewer.scene.add(new THREE.LineSegments(lineGeometry, lineMaterial), new THREE.LineLoop(lineGeometry, lineMaterial));
  viewer.markerGeoNormal = lineGeometry; viewer.markerMatNormal = lineMaterial;
  viewer.markerMatSelected = track(new THREE.MeshBasicMaterial(), 'unused cached marker material');
  viewer.selectedBone = active; viewer.jointMarkers = [active];
  viewer.dispose(); viewer.dispose();
  for (const [label, count] of counts) assert.equal(count, 1, label);
  assert.equal(rendererDisposed(), true); assert.equal(viewer.scene, null); assert.equal(viewer.cachedSkinTexture, null);
  assert.equal(viewer.markerMatSelected, null); assert.equal(viewer.selectedBone, null); assert.deepEqual(viewer.jointMarkers, []);
});

test('shader uniform and scene environment textures release once, including a skeleton-owned bone texture', () => {
  const { viewer, counts, track } = fixture();
  const environment = track(new THREE.Texture(), 'environment'), uniformMap = track(new THREE.Texture(), 'uniform map');
  const boneMap = track(new THREE.Texture(), 'bone map');
  const skeleton = new THREE.Skeleton([]); skeleton.boneTexture = boneMap; viewer.skeleton = skeleton;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), new THREE.ShaderMaterial({ uniforms: {
    maps: { value: [environment, uniformMap, uniformMap] }, bones: { value: boneMap },
  } }));
  mesh.skeleton = skeleton; viewer.scene.add(mesh); viewer.scene.background = viewer.scene.environment = environment;
  viewer.dispose();
  for (const [label, count] of counts) assert.equal(count, 1, label);
  assert.equal(skeleton.boneTexture, null);
});

test('StudioScene delegates attached GLB props and helpers to one viewer owner, and close is idempotent', () => {
  const { viewer, counts, track } = fixture();
  const studio = Object.create(StudioScene.prototype); studio.viewer = viewer;
  const shared = track(new THREE.Texture(), 'shared imported texture');
  const root = new THREE.Group(); root.add(new THREE.Mesh(track(new THREE.BoxGeometry(), 'prop geometry'), track(new THREE.MeshBasicMaterial({ map: shared }), 'prop material')));
  const glb = new THREE.Group(); glb.add(new THREE.Mesh(track(new THREE.BoxGeometry(), 'main geometry'), track(new THREE.MeshBasicMaterial({ map: shared }), 'main material')));
  viewer.scene.add(root, glb); studio.propRoots = new Map([['prop', root]]); studio.glb = glb;
  studio.actorRoots = new Map(); studio.morphCache = new Map();
  for (const name of ['grid', 'ring', 'photoFrame', 'shotHelper']) {
    const helper = new THREE.LineSegments(track(new THREE.BufferGeometry(), `${name} geometry`), track(new THREE.LineBasicMaterial(), `${name} material`));
    viewer.scene.add(helper); studio[name] = helper;
  }
  studio.dispose(); studio.dispose();
  for (const [label, count] of counts) assert.equal(count, 1, label);
  assert.equal(studio.glb, null); assert.equal(studio.propRoots.size, 0); assert.equal(studio.ring, null);
});

test('switching away from an imported skinned GLB releases its bone texture before detaching the mesh', async () => {
  const studio = Object.create(StudioScene.prototype), scene = new THREE.Scene();
  const skeleton = new THREE.Skeleton([new THREE.Bone()]); skeleton.computeBoneTexture();
  const mesh = new THREE.SkinnedMesh(new THREE.BoxGeometry(), new THREE.MeshBasicMaterial()); mesh.bind(skeleton);
  const root = new THREE.Group(); root.add(mesh); scene.add(root);
  let released = 0; skeleton.boneTexture.addEventListener('dispose', () => released++);
  const cameras = [new THREE.PerspectiveCamera(), new THREE.PerspectiveCamera()];
  studio.viewer = { scene, camera: cameras[0], captureCamera: cameras[1], setMannequinVisible() {}, waitForCaptureReady: async () => {} };
  studio.cameraClips = cameras.map(camera => ({ near: camera.near, far: camera.far }));
  studio.glb = root; studio.glbName = 'skinned.glb'; studio.propRoots = new Map();
  studio.grid = new THREE.Object3D(); studio.ring = new THREE.Object3D();
  studio.setMode = () => {}; studio.updateShot = () => {};
  await studio.restore(defaultScene());
  assert.equal(released, 1); assert.equal(skeleton.boneTexture, null);
  assert.equal(root.parent, null); assert.equal(studio.glb, null);
});
