import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { SplatScene, decodeCameraToken, configureSplatCamera } from '../web/editor/splat.mjs';

const close = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
const vectorClose = (actual, expected) => actual.toArray().forEach((value, i) => close(value, expected[i]));
const controls = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
const source = {
  camera_token: [0.8, -0.6, 0.2, 0.5, 0.8],
  bounds: [[-0.5, 0, -0.5], [0.5, 1, 0.5]],
  reference: { width: 1000, height: 800 },
  crop: [100, 30, 740, 670],
};

test('5D decoding retains inverse-distance units and converts Z-up to Y-up', () => {
  const decoded = decodeCameraToken([2, -2, 1, 0.5, 0.8]);
  vectorClose(decoded.direction, [2 / 3, 1 / 3, 2 / 3]);
  close(decoded.radius, 2);
  close(decoded.fov, THREE.MathUtils.radToDeg(2 * Math.atan(0.4)));
  assert.equal(decoded.orthographic, false);
});

test('native export plus Rx(pi) equals raw [x,z,-y], including reference projection', () => {
  const rawCamera = new THREE.PerspectiveCamera(THREE.MathUtils.radToDeg(2 * Math.atan(0.4)), 1, 0.01, 100);
  rawCamera.position.set(...source.camera_token.slice(0, 3)).normalize().multiplyScalar(2);
  rawCamera.up.set(0, 0, 1);
  rawCamera.lookAt(0, 0, 0);
  rawCamera.updateMatrixWorld(true);
  const camera = new THREE.PerspectiveCamera();
  configureSplatCamera(camera, source, controls, 1000, 800);
  for (const xyz of [[0, 0, 0], [0.1, -0.1, 0.2], [-0.2, 0.3, 0.1]]) {
    const raw = new THREE.Vector3(...xyz);
    const prepared = raw.clone().project(rawCamera);
    const native = new THREE.Vector3(raw.x, -raw.z, raw.y);
    native.applyAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
    vectorClose(native, [raw.x, raw.z, -raw.y]);
    const projected = native.multiplyScalar(20).project(camera);
    const xOriginal = 100 + (prepared.x + 1) * 320;
    const yOriginal = 30 + (1 - prepared.y) * 320;
    close(projected.x, 2 * xOriginal / 1000 - 1);
    close(projected.y, 1 - 2 * yOriginal / 800);
  }
});

test('normalization, root rotation and scale move geometry and camera together', () => {
  const shifted = { ...source, bounds: [[-0.2, -0.4, -0.3], [0.8, 0.6, 0.7]] };
  const matrix = new THREE.Matrix4().compose(new THREE.Vector3(3, -2, 7),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.7), new THREE.Vector3(1.7, 1.7, 1.7));
  const base = new THREE.PerspectiveCamera(), moved = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(base, shifted, controls, 1000, 800);
  vectorClose(target, [-6, 8, -4]);
  const movedTarget = configureSplatCamera(moved, shifted, controls, 1000, 800, matrix);
  vectorClose(movedTarget, target.clone().applyMatrix4(matrix).toArray());
  const point = new THREE.Vector3(1, 10, 2);
  const a = point.clone().project(base), b = point.clone().applyMatrix4(matrix).project(moved);
  close(a.x, b.x); close(a.y, b.y);
});

test('nonmatching output aspect contains the original frame without stretching it', () => {
  const wide = new THREE.PerspectiveCamera(), portrait = new THREE.PerspectiveCamera();
  configureSplatCamera(wide, source, controls, 1000, 800);
  configureSplatCamera(portrait, source, controls, 800, 1000);
  for (const point of [new THREE.Vector3(), new THREE.Vector3(2, 3, 1)]) {
    const a = point.clone().project(wide), b = point.clone().project(portrait);
    close(b.x, a.x);
    close(b.y, a.y * 0.64);
  }
});

test('zoom remains centered on the subject crop, and pan moves in image axes', () => {
  const base = new THREE.PerspectiveCamera(), zoomed = new THREE.PerspectiveCamera();
  configureSplatCamera(base, source, controls, 1000, 800);
  configureSplatCamera(zoomed, source, { ...controls, zoom: 2 }, 1000, 800);
  const center = new THREE.Vector3().project(base);
  const point = new THREE.Vector3(2, 3, 1);
  const a = point.clone().project(base), b = point.clone().project(zoomed);
  close(b.x - center.x, (a.x - center.x) * 2);
  close(b.y - center.y, (a.y - center.y) * 2);
  const panned = new THREE.PerspectiveCamera();
  configureSplatCamera(panned, source, { ...controls, offsetX: 1, offsetY: 1 }, 1000, 800);
  const after = new THREE.Vector3().project(panned);
  assert.ok(after.x > center.x && after.y > center.y);
});

test('azimuth and elevation are relative to the predicted camera', () => {
  const camera = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(camera, source, { ...controls, azimuth: 45, elevation: 10 }, 1000, 800);
  const direction = camera.position.clone().sub(target).normalize();
  const initial = decodeCameraToken(source.camera_token).direction;
  close(Math.atan2(direction.x, direction.z) - Math.atan2(initial.x, initial.z), Math.PI / 4);
  close(Math.asin(direction.y) - Math.asin(initial.y), Math.PI / 18);
});

test('orthographic token uses the official distant perspective approximation without clipping', () => {
  const ortho = { ...source, camera_token: [0, -1, 0, 0, 0.7] };
  const camera = new THREE.PerspectiveCamera();
  const target = configureSplatCamera(camera, ortho, controls, 1000, 800);
  close(camera.position.distanceTo(target), 20000);
  close(camera.fov, THREE.MathUtils.radToDeg(2 * Math.atan(0.7 / 1000)));
  for (const point of [new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10)]) {
    const depth = point.project(camera).z;
    assert.ok(depth > -1 && depth < 1);
  }
});

test('invalid camera and crop metadata fail instead of claiming calibration', () => {
  for (const token of [[0, 0, 0, 1, 1], [1, 0, 0, 1, -1], [NaN, 0, 0, 1, 1], [1, 2]]) {
    assert.throws(() => decodeCameraToken(token));
  }
  assert.throws(() => configureSplatCamera(new THREE.PerspectiveCamera(), { ...source, crop: [1, 2, 1, 4] }, controls, 100, 100));
});

test('capture waits for old and newly dispatched sort completion, including partial queues', async () => {
  const scene = new SplatScene({});
  const events = [];
  let releaseOld;
  const viewer = {
    splatRenderReady: true, splatRenderCount: 100, lastSplatSortCount: 0,
    sortPromise: new Promise(resolve => { releaseOld = resolve; }),
    updateForDropInMode() { events.push('bind'); },
    async runSplatSort(force, all) {
      assert.equal(force, true); assert.equal(all, true);
      events.push('dispatch');
      this.sortPromise = new Promise(resolve => setImmediate(() => {
        this.lastSplatSortCount += 50; events.push('done'); resolve();
      }));
    },
    updateSplatMesh() { events.push('uniforms'); },
  };
  scene.dropIn = { viewer };
  const preparing = scene.prepareCapture({}, new THREE.PerspectiveCamera());
  await Promise.resolve();
  assert.deepEqual(events, []);
  releaseOld();
  await preparing;
  assert.deepEqual(events, ['bind', 'dispatch', 'done', 'dispatch', 'done', 'uniforms']);
});

test('bounds and original-origin target follow the scene root transform', () => {
  const scene = new SplatScene({});
  scene._bounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
  scene._target.set(2, 6, 0);
  scene.root.position.set(5, 0, 0); scene.root.scale.setScalar(2);
  vectorClose(scene.bounds.min, [-15, 0, -20]);
  vectorClose(scene.target, [9, 12, 0]);
});
