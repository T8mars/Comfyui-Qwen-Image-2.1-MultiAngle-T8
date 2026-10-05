import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const pose = { id: 'saved', name: 'Relaxed', mesh: {}, pose: { bones: { head: [0, 2, 0] } }, openpose: null };
function fixture(stored) {
  const elements = new Map(), created = [], errors = [], failure = new Error('QuotaExceededError');
  let value = stored, rejectWrites = false;
  const state = { clone: structuredClone, activeActor: () => null, doc: { actors: [], mesh: {} },
    studio: { pose: () => ({ bones: { head: [0, 3, 0] } }) },
    crypto: { randomUUID: () => 'new' }, askName: async () => 'New pose', toast() {}, error: error => errors.push(error),
    localStorage: { getItem: () => value, setItem: (_key, next) => { if (rejectWrites) throw failure; value = next; } },
    iconButton: (_icon, label) => { const button = { title: label }; created.push(button); return button; },
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} }); return elements.get(id); },
    document: { createElement: () => { const element = { append() {} }; created.push(element); return element; } },
  };
  const readStart = app.indexOf('let poseLibrary;');
  vm.runInNewContext(app.slice(readStart, app.indexOf('\n', app.indexOf('poseLibrary = poseLibrary.filter(', readStart))), state);
  const libraryStart = app.indexOf('function saveLibrary(');
  vm.runInNewContext(app.slice(libraryStart, app.indexOf('function download(', libraryStart)), state);
  const library = () => JSON.parse(vm.runInNewContext('JSON.stringify(poseLibrary)', state));
  return { state, created, elements, errors, failure, library, stored: () => value, failWrites: () => { rejectWrites = true; } };
}

test('corrupt library entries do not prevent opening the editor and valid saved poses remain available', () => {
  const { state, library, created } = fixture(JSON.stringify([null, 7, 'bad', { name: null }, pose]));
  assert.doesNotThrow(() => state.renderLibrary()); assert.deepEqual(library(), [pose]);
  assert.ok(created.some(element => element.textContent === 'Relaxed'));
});

test('failed browser storage write does not leave a phantom saved pose in memory', async () => {
  const saved = JSON.stringify([pose]), context = fixture(saved); context.failWrites();
  await context.elements.get('#save-pose').onclick();
  assert.deepEqual(context.library(), [pose]); assert.equal(context.stored(), saved);
  assert.deepEqual(context.errors, [context.failure]);
});

test('failed deletion keeps the pose in memory and reports the storage error', () => {
  const saved = JSON.stringify([pose]), context = fixture(saved); context.state.renderLibrary(); context.failWrites();
  const remove = context.created.find(element => element.title === '删除姿势 Relaxed');
  assert.doesNotThrow(() => remove.onclick()); assert.deepEqual(context.library(), [pose]);
  assert.equal(context.stored(), saved); assert.deepEqual(context.errors, [context.failure]);
});

test('successful save and delete persist exactly the displayed library', async () => {
  const context = fixture(JSON.stringify([pose])); await context.elements.get('#save-pose').onclick();
  assert.equal(context.library().length, 2); assert.deepEqual(JSON.parse(context.stored()), context.library());
  context.created.find(element => element.title === '删除姿势 Relaxed').onclick();
  assert.deepEqual(context.library().map(entry => entry.id), ['new']);
  assert.deepEqual(JSON.parse(context.stored()), context.library()); assert.equal(context.errors.length, 0);
});
