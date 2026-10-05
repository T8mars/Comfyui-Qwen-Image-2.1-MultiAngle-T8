import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene } from '../web/editor/scene.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
function fixture({ mode = 'camera', restoreFailure = false } = {}) {
  const doc = defaultScene(); doc.source.kind = 'human'; doc.cameraTarget = [3, 4, 5];
  doc.shots = [{ id: 'existing', name: 'Existing', camera: structuredClone(doc.camera) }];
  const failure = new Error('thumbnail encoding failed'), elements = new Map(), calls = { changed: 0, restored: 0 };
  const state = { doc, ready: true, clone: structuredClone, defaultScene, selectedShot: 'existing', previewVisible: false,
    undo: Array.from({ length: 40 }, (_, index) => ({ index })), redo: [{ priorRedo: true }],
    run: task => task(), askName: async () => 'New shot', crypto: { randomUUID: () => 'new-shot' }, toast() {},
    changed: () => calls.changed++, renderShots() {},
    $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    studio: { mode, restoring: false, syncPose() {}, baseTarget: { toArray: () => [3, 4, 5] },
      currentViewAsShot() { state.doc.camera.azimuth = 123; state.doc.cameraTarget = [90, 91, 92]; },
      capture: async () => { throw failure; },
      restore: async incoming => { calls.restored++; state.studio.doc = incoming; if (restoreFailure) throw new Error('rollback failed'); },
    },
    setMode: next => { state.studio.mode = next; },
  };
  const beginStart = app.indexOf('function begin()');
  vm.runInNewContext(app.slice(beginStart, app.indexOf('function changed(', beginStart)), state);
  const saveStart = app.indexOf("$('#save-shot').onclick");
  vm.runInNewContext(app.slice(saveStart, app.indexOf('function saveLibrary(', saveStart)), state);
  return { state, failure, calls, save: () => elements.get('#save-shot').onclick() };
}

for (const mode of ['camera', 'edit']) test(`failed ${mode} bookmark keeps scene, active bookmark and full undo/redo history`, async () => {
  const { state, failure, calls, save } = fixture({ mode });
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(save(), error => error === failure);
  assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.equal(state.studio.mode, mode); assert.equal(state.selectedShot, 'existing');
  assert.equal(calls.changed, 0); assert.equal(calls.restored, 1);
});

test('failed bookmark preserves its primary error when scene recovery also fails', async () => {
  const { state, failure, save } = fixture({ mode: 'edit', restoreFailure: true });
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(save(), error => error === failure);
  assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
});

test('cancelling the bookmark name does not capture, switch mode or alter history', async () => {
  const { state, calls, save } = fixture({ mode: 'edit' }); state.askName = async () => null;
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await save(); assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.equal(state.studio.mode, 'edit'); assert.equal(calls.restored, 0);
});
