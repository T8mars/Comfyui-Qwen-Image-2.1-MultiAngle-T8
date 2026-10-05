import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { activeActor, bindActor, createActor, saveActor } from '../web/editor/actors.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const selectedSource = { origin: 'json', personId: 'alice-in-photo', points: [[.2, .3]] };
function fixture(count = 2) {
  const doc = defaultScene(); doc.source.kind = 'human';
  doc.actors = [createActor(0, { id: 'alice', poseSource: selectedSource, identity: { description: 'Alice', inputKey: 'actor_reference_4' } }),
    createActor(1, { id: 'bob', locked: true, identity: { description: 'Bob', inputKey: 'actor_reference_9' } })].slice(0, count);
  doc.activeActorId = 'alice'; doc.selectedActorIds = ['alice']; bindActor(doc);
  doc.openpose = { origin: 'dwpose', asset: { name: 'global-group-pose.png' }, people: [{ id: 'alice-in-photo' }, { id: 'bob-in-photo' }] };
  return doc;
}
function ioContext(doc = fixture(), restore = async () => {}) {
  const elements = new Map(), exports = [], calls = { changed: 0, saved: 0, rig: 0, downloads: 0 };
  const state = { doc, ready: true, undo: [{ oldUndo: true }], redo: [{ oldRedo: true }], poseLibrary: [],
    clone: structuredClone, defaultScene, activeActor, saveActor, run: task => task(),
    askName: async () => 'Current actor', crypto: { randomUUID: () => 'saved-alice' }, toast() {},
    saveLibrary: next => { calls.saved++; state.poseLibrary = next; }, error: error => { throw error; }, download: () => calls.downloads++,
    fetch: async (_url, options) => { exports.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ id: 'exported' }) }; },
    changed: () => calls.changed++, $: id => { if (!elements.has(id)) elements.set(id, {}); return elements.get(id); },
    studio: { restoring: false, syncPose() {}, pose: () => structuredClone(state.doc.pose), restore,
      useRigPose: () => { calls.rig++; StudioScene.prototype.useRigPose.call({ doc: state.doc }); } } };
  const beginStart = app.indexOf('function begin()');
  vm.runInNewContext(app.slice(beginStart, app.indexOf('function changed(', beginStart)), state);
  const saveStart = app.indexOf("$('#save-pose').onclick");
  vm.runInNewContext(app.slice(saveStart, app.indexOf('function download(', saveStart)), state);
  const exportStart = app.indexOf("$('#export-pose').onclick");
  vm.runInNewContext(app.slice(exportStart, app.indexOf("$('#download-guide').onclick", exportStart)), state);
  return { state, calls, exports, elements, importPose: async data => {
    const input = { value: 'chosen-file', files: [{ text: async () => JSON.stringify(data) }] };
    await elements.get('#pose-file').onchange({ target: input }); assert.equal(input.value, '');
  } };
}
const incoming = () => ({ version: 1, kind: 'anyangle-pose', mesh: { muscle: .8, breast_size: .7, show_genitals: true },
  pose: { bones: { head: [5, 10, 0], upperarm_l: [20, 30, 40] } }, openpose: { origin: 'json', personId: 'imported-person', points: [[.4, .5]] } });

test('actual save and export handlers use only the selected actor source in a multiplayer scene', async () => {
  const { state, calls, exports, elements } = ioContext();
  await elements.get('#save-pose').onclick(); await elements.get('#export-pose').onclick();
  assert.deepEqual(state.poseLibrary[0].openpose, selectedSource); assert.notEqual(state.poseLibrary[0].openpose, activeActor(state.doc).poseSource);
  assert.deepEqual(exports[0].openpose, selectedSource); assert.equal(exports[0].kind, 'anyangle-pose'); assert.equal(exports[0].version, 1);
  assert.equal(calls.saved, 1); assert.equal(calls.downloads, 1);
});

test('multiplayer actor without a pose source saves and exports null instead of another person or the global group source', async () => {
  const doc = fixture(); doc.actors[0].poseSource = null; const { state, exports, elements } = ioContext(doc);
  await elements.get('#save-pose').onclick(); await elements.get('#export-pose').onclick();
  assert.equal(state.poseLibrary[0].openpose, null); assert.equal(exports[0].openpose, null);
});

test('single-person and legacy documents retain the global pose-source fallback, while preferring a specific actor source', async () => {
  for (const mode of ['specific', 'single-fallback', 'legacy-fallback']) {
    const doc = fixture(1);
    if (mode !== 'specific') doc.actors[0].poseSource = null;
    if (mode === 'legacy-fallback') delete doc.actors;
    const expected = structuredClone(mode === 'specific' ? selectedSource : doc.openpose);
    const { state, exports, elements } = ioContext(doc);
    await elements.get('#save-pose').onclick(); await elements.get('#export-pose').onclick();
    assert.deepEqual(state.poseLibrary[0].openpose, expected, mode); assert.deepEqual(exports[0].openpose, expected, mode);
  }
});

test('multiplayer import replaces only the current actor pose/source and retains the group guide and stable identities', async () => {
  const { state, calls, importPose } = ioContext(), data = incoming();
  const other = structuredClone(state.doc.actors[1]), globalGuide = structuredClone(state.doc.openpose), identity = structuredClone(activeActor(state.doc).identity);
  await importPose(data);
  assert.deepEqual(activeActor(state.doc).pose, data.pose); assert.deepEqual(activeActor(state.doc).poseSource, data.openpose);
  assert.deepEqual(state.doc.actors[1], other); assert.deepEqual(activeActor(state.doc).identity, identity);
  assert.deepEqual(state.doc.openpose, { ...globalGuide, useRig: true });
  assert.equal(activeActor(state.doc).mesh.muscle, .8); assert.equal(activeActor(state.doc).mesh.breast_size, 0); assert.equal(activeActor(state.doc).mesh.show_genitals, false);
  assert.equal(state.redo.length, 0); assert.equal(state.undo.length, 2); assert.deepEqual(calls, { changed: 1, saved: 0, rig: 1, downloads: 0 });
});

test('single-person import retains the legacy global-guide update and writes the same source to the actor', async () => {
  const { state, importPose } = ioContext(fixture(1)), data = incoming(); await importPose(data);
  assert.deepEqual(activeActor(state.doc).poseSource, data.openpose); assert.deepEqual(state.doc.openpose, { ...data.openpose, useRig: true });
});

test('a multiplayer pose file without source clears only the selected actor source', async () => {
  const { state, importPose } = ioContext(), data = incoming(); delete data.openpose;
  const globalGuide = structuredClone(state.doc.openpose); await importPose(data);
  assert.equal(activeActor(state.doc).poseSource, null); assert.deepEqual(state.doc.openpose, { ...globalGuide, useRig: true });
});

test('partially failed import restores the whole scene and history even when loading the rollback scene also fails', async () => {
  const primary = new Error('imported pose asset unavailable'), secondary = new Error('rollback asset unavailable'); let attempts = 0;
  const { state, calls, importPose } = ioContext(fixture(), async doc => {
    if (++attempts === 1) { doc.actors[1].identity.description = 'partial restore'; doc.openpose = null; throw primary; }
    throw secondary;
  });
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(importPose(incoming()), error => error === primary);
  assert.equal(attempts, 2); assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.deepEqual(calls, { changed: 0, saved: 0, rig: 0, downloads: 0 });
});

test('invalid imported bone data is rejected before the scene or history is changed', async () => {
  const { state, importPose } = ioContext(), data = incoming(); data.pose.bones.head = [1, 2];
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(importPose(data), /无效的骨骼旋转/);
  assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
});
