import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene } from '../web/editor/scene.mjs';
import { createActor, activeActor, editableActors, ensureActors } from '../web/editor/actors.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const actors = readFileSync(new URL('../web/editor/actors-ui.mjs', import.meta.url), 'utf8');
const cast = readFileSync(new URL('../web/editor/cast-tools.mjs', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function installCastTools', 'function installCastTools');

function fixture(restore = async () => {}) {
  const elements = new Map();
  const node = () => ({ dataset: {}, children: [], before() {}, closest() { return this; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; } });
  const element = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const doc = defaultScene(); doc.source.kind = 'human'; doc.actors = [createActor(0, { id: 'alice' })];
  doc.activeActorId = 'alice'; doc.selectedActorIds = ['alice'];
  const state = { doc, ready: true, undo: Array.from({ length: 40 }, (_, i) => ({ before: i })),
    redo: [{ camera: 'redo camera' }], clone: structuredClone, structuredClone, activeActor, editableActors, ensureActors,
    poseCopyIssue: () => null,
    changedCount: 0, studio: { restoring: false, syncPose() {}, restore }, $: id => element(id),
    document: { getElementById: element, createElement: node, createTextNode: value => value, body: node() } };
  const begin = app.indexOf('function begin()');
  vm.runInNewContext(app.slice(begin, app.indexOf('function changed(', begin)), state);
  state.context = { doc: () => state.doc, replace: value => { state.doc = value; }, studio: () => state.studio,
    run: task => task(), begin: () => state.begin(), changed: () => state.changedCount++ };
  const edit = actors.indexOf('async function editTransaction(');
  vm.runInNewContext(actors.slice(edit, actors.indexOf('export function installActorsUI', edit)), state);
  vm.runInNewContext(cast, state); state.installCastTools(state.context); element('cast-layout');
  return { state, elements };
}

test('failed actor edit restores the complete history, including the entry evicted at its size limit', async () => {
  const { state } = fixture(), before = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  const primary = new Error('identity upload failed');
  await assert.rejects(state.editTransaction(async () => {
    state.doc.actors[0].identity.description = 'partial edit'; throw primary;
  }), error => error === primary);
  assert.deepEqual(state.doc, before); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.equal(state.changedCount, 0);
});

test('invalid handshake selection preserves redo and does not add a no-op undo entry', async () => {
  const { state, elements } = fixture(), before = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  elements.get('cast-layout').value = 'handshake';
  await assert.rejects(elements.get('apply-layout').onclick(), /请选中两位未锁定人物/);
  assert.deepEqual(state.doc, before); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
  assert.equal(state.changedCount, 0);
});

test('a failed prop edit retains its original error and history when restoring the previous scene also fails', async () => {
  const secondary = new Error('old asset unavailable'), { state, elements } = fixture(async () => { throw secondary; });
  const primary = /请选中两位未锁定人物/;
  const undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  elements.get('cast-layout').value = 'dialogue';
  await assert.rejects(elements.get('apply-layout').onclick(), primary);
  assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
});

test('successful actor edits still clear redo and retain the bounded undo history', async () => {
  const { state } = fixture(), before = structuredClone(state.doc);
  await state.editTransaction(async () => { state.doc.actors[0].identity.description = 'new identity'; });
  assert.equal(state.undo.length, 40); assert.deepEqual(state.undo.at(-1), before);
  assert.equal(state.redo.length, 0); assert.equal(state.doc.actors[0].identity.description, 'new identity');
  assert.equal(state.changedCount, 1);
});

test('copying a photo pose into a locked actor preserves the scene, history and primary error', async () => {
  const { state, elements } = fixture(async () => { throw new Error('rollback load error'); });
  state.doc.actors[0].locked = true;
  const before = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  const start = actors.indexOf('export async function chooseDetectedPeople(');
  vm.runInNewContext(actors.slice(start).replace('export async function', 'async function'), state);
  const dialog = state.document.getElementById('people-dialog');
  dialog.showModal = () => { dialog.returnValue = 'current'; };
  dialog.addEventListener = (_type, callback) => queueMicrotask(callback);
  const choices = state.document.getElementById('people-choices');
  choices.querySelectorAll = () => choices.children.flatMap(row => row.children).filter(child => child.checked);
  await assert.rejects(state.chooseDetectedPeople([{ id: 'person', points: { neck: [10, 20] } }], null), /人物已锁定/);
  assert.deepEqual(state.doc, before); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
});

function appOperationFixture() {
  const primary = new Error('new asset unavailable'), secondary = new Error('previous scene load failed');
  let attempts = 0;
  const { state, elements } = fixture(async () => { throw ++attempts === 1 ? primary : secondary; });
  Object.assign(state, { run: task => task(), defaultScene, ensureHumanTools: async () => {},
    upload: async () => ({ name: 'broken.glb' }), clearTimeout() {}, previewRunning: false, previewTimer: null,
    reconstruct: async () => ({ kind: 'splat', name: 'new.ply' }),
    referenceCamera: () => defaultScene().camera, refresh() {}, schedulePreview() {} });
  return { state, elements, primary };
}

function assertRestored(state, before, undo, redo, primary, action) {
  return assert.rejects(action, error => error === primary).then(() => {
    assert.deepEqual(state.doc, before); assert.deepEqual(state.undo, undo); assert.deepEqual(state.redo, redo);
    assert.equal(state.changedCount, 0);
  });
}

for (const kind of ['GLB import', 'human switch', '3D reconstruction', 'single-person pose copy']) {
  test(`failed ${kind} preserves redo, bounded undo and the original error`, async () => {
    const { state, elements, primary } = appOperationFixture(); let action;
    if (kind === 'GLB import') {
      const start = app.indexOf("$('#glb-file').onchange");
      vm.runInNewContext(app.slice(start, app.indexOf("$('#human').onclick", start)), state);
      action = () => elements.get('#glb-file').onchange({ target: { files: [{}], value: 'broken.glb' } });
    } else if (kind === 'human switch') {
      const start = app.indexOf("$('#human').onclick =");
      vm.runInNewContext(app.slice(start, app.indexOf('async function applyRandomPose(', start)), state);
      state.doc.source = { kind: 'glb', name: 'old.glb' };
      action = () => elements.get('#human').onclick();
    } else if (kind === '3D reconstruction') {
      const start = app.indexOf('async function reconstructPhoto(');
      vm.runInNewContext(app.slice(start, app.indexOf("$('#reconstruct').onclick", start)), state);
      state.doc.reference = { name: 'reference.png', width: 1280, height: 720 };
      action = () => state.reconstructPhoto();
    } else {
      const start = app.indexOf('async function retargetPose(');
      vm.runInNewContext(app.slice(start, app.indexOf("$('#retarget-pose').onclick", start)), state);
      state.doc.openpose = { points: { neck: [10, 20] }, rawAsset: { name: 'pose.png' }, origin: 'import' };
      state.studio.applyOpenPose = () => { state.doc.actors[0].pose.bones.head = [0, 40, 0]; throw primary; };
      action = () => state.retargetPose();
    }
    const before = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
    await assertRestored(state, before, undo, redo, primary, action);
  });
}

test('a reconstruction failure before editing leaves both history stacks untouched', async () => {
  const { state, primary } = appOperationFixture(); state.reconstruct = async () => { throw primary; };
  state.doc.reference = { name: 'reference.png', width: 1280, height: 720 };
  const start = app.indexOf('async function reconstructPhoto(');
  vm.runInNewContext(app.slice(start, app.indexOf("$('#reconstruct').onclick", start)), state);
  const before = structuredClone(state.doc), undo = structuredClone(state.undo), redo = structuredClone(state.redo);
  await assertRestored(state, before, undo, redo, primary, () => state.reconstructPhoto());
});
