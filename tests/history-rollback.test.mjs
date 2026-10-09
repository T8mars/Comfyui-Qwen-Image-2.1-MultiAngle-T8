import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { activeActor, bindActor, createActor, saveActor } from '../web/editor/actors.mjs';
import { sourceChanged } from '../web/editor/reference-library.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
function fixture() {
  const doc = defaultScene(); doc.source.kind = 'human';
  doc.actors = [createActor(0, { id: 'alice', identity: { asset: { name: 'alice.png' }, inputKey: 'actor_reference_1', description: 'Alice' } }),
    createActor(1, { id: 'bob', locked: true, identity: { asset: { name: 'bob.png' }, inputKey: 'actor_reference_7', description: 'Bob' } })];
  doc.activeActorId = 'alice'; doc.selectedActorIds = ['alice']; bindActor(doc);
  doc.cameraTarget = [4, 5, 6]; doc.props = [{ id: 'table', asset: { name: 'table.glb' } }];
  doc.openpose = { origin: 'dwpose', asset: { name: 'group-pose.png' }, people: [{ id: 'source-alice' }, { id: 'source-bob' }] };
  return doc;
}
function historyContext(doc, restore) {
  const calls = { changed: 0, shots: 0, refresh: 0 };
  const state = { doc, clone: structuredClone, linkedReference: { connected: false }, sourceChanged,
    studio: { syncPose() {}, restore }, changed: () => calls.changed++, renderShots: () => calls.shots++, refresh: () => calls.refresh++ };
  const start = app.indexOf('async function undoRedo(');
  vm.runInNewContext(app.slice(start, app.indexOf("$('#undo').onclick", start)), state);
  return { state, calls };
}

test('undo restores the live scene and both history stacks after a partially mutating asynchronous load fails', async () => {
  const doc = fixture(), snapshot = structuredClone(doc); snapshot.actors[0].pose = { bones: { head: [0, 40, 0] } };
  const source = [snapshot], target = [{ existingRedo: true }], expectedSource = structuredClone(source), expectedTarget = structuredClone(target);
  const primary = new Error('missing human asset'), seen = [];
  const { state, calls } = historyContext(doc, async incoming => {
    seen.push(incoming);
    if (seen.length === 1) { incoming.actors[0].identity.description = 'partial restore mutation'; incoming.actors.push(createActor(2)); throw primary; }
  });
  await assert.rejects(state.undoRedo(source, target), error => error === primary);
  assert.equal(state.doc, doc); assert.equal(seen[1], doc);
  assert.deepEqual(source, expectedSource); assert.deepEqual(target, expectedTarget);
  assert.equal(source[0], snapshot); assert.notEqual(seen[0], snapshot);
  assert.deepEqual(doc, fixture()); assert.deepEqual(calls, { changed: 0, shots: 0, refresh: 0 });
});

test('redo preserves the original load error if restoring the previous scene also fails', async () => {
  const doc = fixture(), source = [structuredClone(doc)], target = [], primary = new Error('primary failure'), secondary = new Error('rollback failure');
  const expectedSource = structuredClone(source); let attempts = 0;
  const { state } = historyContext(doc, async () => { throw ++attempts === 1 ? primary : secondary; });
  await assert.rejects(state.undoRedo(source, target), error => error === primary);
  assert.equal(attempts, 2); assert.equal(state.doc, doc); assert.deepEqual(source, expectedSource); assert.deepEqual(target, []);
});

test('successful undo still applies the connected reference and invalidates a stale splat source', async () => {
  const doc = fixture(), snapshot = structuredClone(doc); snapshot.source = { kind: 'splat', reference: { name: 'old.png' } };
  doc.version = snapshot.version = 2; delete doc.referenceLibrary; delete snapshot.referenceLibrary;
  const source = [snapshot], target = [], restored = [];
  const { state, calls } = historyContext(doc, async incoming => restored.push(incoming));
  state.linkedReference = { connected: true, asset: { name: 'new.png' } };
  await state.undoRedo(source, target);
  assert.equal(source.length, 0); assert.deepEqual(target, [doc]); assert.equal(restored.length, 1);
  assert.equal(state.doc.reference.name, 'new.png'); assert.equal(state.doc.source.kind, 'empty');
  assert.equal(snapshot.source.kind, 'splat'); assert.deepEqual(calls, { changed: 1, shots: 1, refresh: 1 });
});

function libraryContext(restore) {
  const doc = fixture(), created = [], calls = { changed: 0, useRig: 0 }, elements = new Map();
  const preset = { id: 'preset', name: 'Saved relaxed pose', mesh: { ...structuredClone(doc.mesh), muscle: .7 },
    pose: { bones: { upperarm_l: [0, 0, 18], head: [3, 2, 1] } }, openpose: { origin: 'json', points: [[.1, .2]] } };
  const state = { doc, undo: [{ priorUndo: true }], redo: [{ priorRedo: true }], poseLibrary: [preset],
    clone: structuredClone, activeActor, saveActor, run: task => task(), ready: true,
    studio: { restoring: false, syncPose() {}, restore, useRigPose: () => {
      calls.useRig++; StudioScene.prototype.useRigPose.call({ doc: state.doc });
    } }, changed: () => calls.changed++,
    iconButton: () => ({ onclick: null }),
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} }); return elements.get(id); },
    document: { createElement: () => { const element = { append() {} }; created.push(element); return element; } } };
  const beginStart = app.indexOf('function begin()');
  vm.runInNewContext(app.slice(beginStart, app.indexOf('function changed(', beginStart)), state);
  const libraryStart = app.indexOf('function saveLibrary(');
  vm.runInNewContext(app.slice(libraryStart, app.indexOf("$('#save-pose').onclick", libraryStart)), state);
  state.renderLibrary();
  return { state, preset, calls, button: created.find(element => element.textContent === preset.name) };
}

test('saved single-person pose loading rolls back a partial restore and preserves redo history, global guide and other identities', async () => {
  const primary = new Error('preset morph asset failed'); let attempts = 0;
  const { state, calls, button } = libraryContext(async incoming => {
    if (++attempts === 1) { incoming.actors[1].label = 'partially changed'; incoming.cameraTarget = [99, 99, 99]; throw primary; }
  });
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(button.onclick(), error => error === primary);
  assert.equal(attempts, 2); assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.deepEqual(calls, { changed: 0, useRig: 0 });
});

test('saved single-person pose affects only the active actor and keeps the group pose guide and identity bindings', async () => {
  const { state, preset, calls, button } = libraryContext(async () => {});
  const other = structuredClone(state.doc.actors[1]), globalGuide = structuredClone(state.doc.openpose), identities = state.doc.actors.map(actor => structuredClone(actor.identity));
  await button.onclick();
  assert.deepEqual(activeActor(state.doc).mesh, preset.mesh); assert.deepEqual(activeActor(state.doc).pose, preset.pose);
  assert.deepEqual(activeActor(state.doc).poseSource, preset.openpose); assert.deepEqual(state.doc.actors[1], other);
  assert.deepEqual(state.doc.openpose, { ...globalGuide, useRig: true }); assert.deepEqual(state.doc.actors.map(actor => actor.identity), identities);
  assert.equal(state.redo.length, 0); assert.equal(state.undo.length, 2); assert.deepEqual(calls, { changed: 1, useRig: 1 });
});

test('saved pose loading preserves its original error even if the rollback restore also fails', async () => {
  const primary = new Error('preset asset missing'), secondary = new Error('previous scene also failed'); let attempts = 0;
  const { state, button } = libraryContext(async () => { throw ++attempts === 1 ? primary : secondary; });
  const previous = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assert.rejects(button.onclick(), error => error === primary);
  assert.equal(attempts, 2); assert.deepEqual(state.doc, previous); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
});
