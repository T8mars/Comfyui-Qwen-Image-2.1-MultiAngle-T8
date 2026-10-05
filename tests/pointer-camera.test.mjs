import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
function fixture({ azimuth = 90, elevation = 0, mode = 'camera' } = {}) {
  const doc = defaultScene(); doc.source.kind = 'human';
  Object.assign(doc.camera, { azimuth, elevation, offsetX: 0, offsetY: 0, offsetZ: 0 });
  const studio = Object.create(StudioScene.prototype), listeners = new Map(), calls = { change: 0, camera: 0 };
  studio.doc = doc; studio.mode = mode; studio.baseTarget = new THREE.Vector3(0, 10, 0);
  studio.photoFrame = {}; studio.shotHelper = { update() {} };
  const camera = new THREE.PerspectiveCamera(38, 1.6, .1, 1000);
  studio.viewer = { THREE, camera, captureCamera: new THREE.PerspectiveCamera(30, 1, .1, 1000), captureFrame: new THREE.Object3D(),
    orbit: { target: new THREE.Vector3(), update() { camera.lookAt(this.target); camera.updateMatrixWorld(true); } },
    requestRender() {}, _applySAMProjectionCaptureCamera: () => false, updateCaptureCamera: PoseViewerCore.prototype.updateCaptureCamera };
  studio.canvas = { addEventListener: (name, callback) => listeners.set(name, callback), setPointerCapture() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };
  const elements = new Map(), state = { doc, ready: true, studio, clone: structuredClone,
    undo: Array.from({ length: 40 }, (_, index) => ({ index })), redo: [{ redoCamera: true }],
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); } };
  studio.syncPose = () => {};
  const begin = app.indexOf('function begin()'); vm.runInNewContext(app.slice(begin, app.indexOf('function changed(', begin)), state);
  studio.callbacks = { begin: () => state.begin(), change: () => calls.change++, camera: () => calls.camera++ };
  studio.updateShot(true); studio.bindCamera();
  const event = values => ({ clientX: 100, clientY: 100, button: 0, pointerId: 1,
    preventDefault() {}, stopImmediatePropagation() { this.stopped = true; }, ...values });
  const send = (type, values = {}) => { const e = event(values); listeners.get(type)(e); return e; };
  return { doc, studio, state, calls, elements, send };
}

for (const azimuth of [0, 90, 180, -90]) for (const elevation of [0, 40]) {
  test(`middle drag follows the screen horizontal axis at ${azimuth}/${elevation} degrees`, () => {
    const { studio, send } = fixture({ azimuth, elevation });
    const target = studio.baseTarget.clone();
    send('pointerdown', { button: 1 }); send('pointermove', { clientX: 140, button: 1 }); send('pointerup', { button: 1 });
    const position = target.project(studio.viewer.captureCamera);
    assert.ok(position.x > .01, `horizontal movement was ${position.x}`); assert.ok(Math.abs(position.y) < 1e-10);
  });
  test(`middle drag follows the screen vertical axis at ${azimuth}/${elevation} degrees`, () => {
    const { studio, send } = fixture({ azimuth, elevation });
    send('pointerdown', { button: 1 }); send('pointermove', { clientY: 140, button: 1 }); send('pointerup', { button: 1 });
    const position = studio.baseTarget.clone().project(studio.viewer.captureCamera);
    assert.ok(position.y < -.01, `vertical movement was ${position.y}`); assert.ok(Math.abs(position.x) < 1e-10);
  });
}

for (const mode of ['edit', 'position']) {
  test(`${mode} middle-button view navigation reaches OrbitControls without changing the capture camera`, () => {
    const { doc, send, state } = fixture({ mode }), before = structuredClone(doc.camera), redo = structuredClone(state.redo);
    const down = send('pointerdown', { button: 1 }); send('pointermove', { clientX: 140, button: 1 }); send('pointerup', { button: 1 });
    assert.equal(down.stopped, undefined); assert.deepEqual(doc.camera, before); assert.deepEqual(state.redo, redo);
  });
}

test('a viewport click with no movement preserves undo and redo and does not commit an edit', () => {
  const { state, send, calls } = fixture(), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  send('pointerdown'); send('pointerup');
  assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo); assert.equal(calls.change, 0);
});

test('Escape cancellation restores camera and the full undo/redo stacks', () => {
  const { doc, studio, state, send, elements, calls } = fixture(), before = structuredClone(doc.camera), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  state.$('#undo').disabled = false; state.$('#redo').disabled = false;
  send('pointerdown'); send('pointermove', { clientX: 170, clientY: 145 }); assert.notDeepEqual(doc.camera, before);
  assert.equal(studio.cancelDrag(), true); assert.deepEqual(doc.camera, before);
  assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo); assert.equal(studio.cancelDrag(), false);
  assert.equal(elements.get('#undo').disabled, false); assert.equal(elements.get('#redo').disabled, false); assert.equal(calls.change, 0);
});

test('fractional-angle stationary movement does not round the angle or clear redo', () => {
  const { doc, state, send } = fixture({ azimuth: .1 }), before = structuredClone(doc.camera), redo = structuredClone(state.redo);
  send('pointerdown'); send('pointermove'); send('pointerup');
  assert.deepEqual(doc.camera, before); assert.deepEqual(state.redo, redo);
});

test('vertical-only movement with mouse pitch disabled preserves a fractional angle and history', () => {
  const { doc, state, send } = fixture({ azimuth: .1 }), before = structuredClone(doc.camera), redo = structuredClone(state.redo);
  doc.interaction.mousePitch = false;
  send('pointerdown'); send('pointermove', { clientY: 140 }); send('pointerup');
  assert.deepEqual(doc.camera, before); assert.deepEqual(state.redo, redo);
});

test('a completed drag creates one undo state and clears redo only after movement', () => {
  const { doc, state, send, calls } = fixture(), before = structuredClone(doc), redo = structuredClone(state.redo);
  send('pointerdown'); assert.deepEqual(state.redo, redo);
  for (let x = 110; x < 170; x += 10) send('pointermove', { clientX: x });
  send('pointerup'); assert.equal(state.undo.length, 40); assert.deepEqual(structuredClone(state.undo.at(-1)), before);
  assert.equal(state.redo.length, 0); assert.equal(calls.change, 1);
});

test('browser pointer cancellation rolls back the edit and preserves redo', () => {
  const { doc, state, send, calls } = fixture(), before = structuredClone(doc.camera), redo = structuredClone(state.redo);
  send('pointerdown', { button: 1 }); send('pointermove', { button: 1, clientX: 170 }); send('pointercancel'); send('pointerup');
  assert.deepEqual(doc.camera, before); assert.deepEqual(state.redo, redo); assert.equal(calls.change, 0);
});

test('wheel movement at the zoom limit keeps redo and does not commit a no-op', () => {
  const { doc, state, send, calls } = fixture(), redo = structuredClone(state.redo);
  doc.camera.zoom = 8; send('wheel', { deltaY: -100 });
  assert.equal(doc.camera.zoom, 8); assert.deepEqual(state.redo, redo); assert.equal(calls.change, 0);
});

test('splat panning retains its existing camera-local coordinate convention', () => {
  const { doc, studio, send } = fixture({ azimuth: 90, elevation: 40 });
  doc.source.kind = 'splat'; studio.updateShot = () => {};
  send('pointerdown', { button: 1 }); send('pointermove', { button: 1, clientX: 140, clientY: 120 }); send('pointerup', { button: 1 });
  assert.deepEqual([doc.camera.offsetX, doc.camera.offsetY, doc.camera.offsetZ], [1, -.5, 0]);
});

test('movement from a different pointer cannot alter the active drag', () => {
  const { doc, send } = fixture(); send('pointerdown'); send('pointermove', { clientX: 130 });
  const before = structuredClone(doc.camera); send('pointermove', { pointerId: 2, clientX: 190, clientY: 220 });
  assert.deepEqual(doc.camera, before);
});

test('release from a different pointer cannot finish the active drag', () => {
  const { doc, send, calls } = fixture(); send('pointerdown'); send('pointermove', { clientX: 130 });
  const before = structuredClone(doc.camera); send('pointerup', { pointerId: 2 }); assert.equal(calls.change, 0);
  send('pointermove', { clientX: 150 }); assert.notDeepEqual(doc.camera, before); send('pointerup'); assert.equal(calls.change, 1);
});

test('a second pointer cannot replace the original drag or its rollback state', () => {
  const { doc, studio, state, send } = fixture(), camera = structuredClone(doc.camera), redo = structuredClone(state.redo);
  send('pointerdown'); send('pointermove', { clientX: 130 }); send('pointerdown', { pointerId: 2, clientX: 180 });
  studio.cancelDrag(); assert.deepEqual(doc.camera, camera); assert.deepEqual(state.redo, redo);
});

test('cancellation from a different pointer leaves the active drag running', () => {
  const { doc, send, calls } = fixture(); send('pointerdown'); send('pointermove', { clientX: 130 });
  const before = structuredClone(doc.camera); send('pointercancel', { pointerId: 2 });
  assert.deepEqual(doc.camera, before); send('pointermove', { clientX: 150 }); assert.notDeepEqual(doc.camera, before);
  send('pointerup'); assert.equal(calls.change, 1);
});

test('lost capture restores history and prevents subsequent hover from moving the camera', () => {
  const { doc, state, send, calls } = fixture(), camera = structuredClone(doc.camera), redo = structuredClone(state.redo);
  send('pointerdown'); send('pointermove', { clientX: 130 }); send('lostpointercapture');
  send('pointermove', { clientX: 170, buttons: 0 }); send('pointerup');
  assert.deepEqual(doc.camera, camera); assert.deepEqual(state.redo, redo); assert.equal(calls.change, 0);
});
