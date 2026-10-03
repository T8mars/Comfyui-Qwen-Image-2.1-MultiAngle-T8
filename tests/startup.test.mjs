import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene } from '../web/editor/scene.mjs';

const source = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const startSource = source.slice(source.indexOf('async function start('), source.indexOf('\nfunction readPendingReference('));

function fixture(response) {
  const elements = new Map();
  const notices = [], errors = [], requests = [];
  const state = {
    doc: defaultScene(), snapshot: null, ready: false, busy: true,
    initCount: 0, reconstructionCount: 0, previewCount: 0,
    defaultScene,
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, textContent: '', dataset: {} });
      return elements.get(selector);
    },
    fetch: async url => { requests.push(url); return response; },
    toast: message => notices.push(message), error: failure => errors.push(failure.message),
    StudioScene: class { async init(doc) { state.initCount++; state.initializedSource = doc.source.kind; } },
    begin() {}, changed() {}, refresh() {}, schedulePreview() {},
    renderShots() {}, renderLibrary() {}, ensureHumanTools: async () => {},
    usesLocalGuide: () => false, applyStructureAsset: async () => {},
    setBusy: value => { state.busy = value; },
    renderPreview: async () => { state.previewCount++; },
    currentGuide: () => state.doc.conditioning.guide,
    run: async action => action(),
    reconstructPhoto: async () => { state.reconstructionCount++; },
  };
  vm.runInNewContext(startSource, state);
  return { state, elements, notices, errors, requests };
}

test('missing migrated snapshot opens an editable scene and reconstructs the connected reference', async () => {
  const { state, elements, notices, errors, requests } = fixture({
    ok: false, status: 404, json: async () => ({ error: 'AnyAngle asset is missing' }),
  });
  const reference = { connected: true, asset: { name: 'photo.png' } };
  await state.start({ version: 1, id: 'old/snapshot' }, reference);
  assert.equal(requests[0], '/anyangle-studio/snapshots/old%2Fsnapshot');
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(elements.get('#loading').hidden, true);
  assert.equal(state.snapshot, null);
  assert.equal(state.initializedSource, 'empty');
  assert.equal(state.doc.reference, reference.asset);
  assert.equal(state.reconstructionCount, 1);
  assert.equal(state.previewCount, 1);
  assert.equal(notices.length, 1);
  assert.deepEqual(errors, []);
});

test('missing snapshot without a connected photo leaves import controls available', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 404, json: async () => { throw new SyntaxError('not JSON'); } });
  await state.start({ version: 1, id: 'missing' });
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(state.reconstructionCount, 0);
  assert.equal(notices.length, 1);
  assert.deepEqual(errors, []);
});

test('existing saved snapshot retains its camera and scene without new reconstruction', async () => {
  const saved = defaultScene();
  saved.source = { kind: 'glb', name: 'model.glb' };
  saved.camera.azimuth = 90;
  const { state, notices, errors } = fixture({ ok: true, status: 200, json: async () => ({ scene: saved }) });
  const token = { version: 1, id: 'existing' };
  await state.start(token);
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(state.snapshot, token);
  assert.equal(state.doc.camera.azimuth, 90);
  assert.equal(state.initializedSource, 'glb');
  assert.equal(state.reconstructionCount, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(errors, []);
});

test('background reconstruction preference restores with its snapshot and old scenes default to subject mode', async () => {
  for (const keepBackground of [true, false]) {
    const saved = defaultScene(); delete saved.reconstruction;
    saved.reference = { name: 'photo.png' };
    saved.source = { kind: 'splat', name: 'scene.ply', reference: saved.reference, keep_background: keepBackground };
    const { state, errors } = fixture({ ok: true, json: async () => ({ scene: saved }) });
    await state.start({ version: 1, id: 'saved-scene' });
    assert.equal(state.doc.reconstruction.keepBackground, keepBackground);
    assert.equal(state.reconstructionCount, 0);
    assert.deepEqual(errors, []);
  }
});

test('authorization errors remain visible instead of being reported as a missing scene', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 403, json: async () => ({ error: 'Authentication required' }) });
  await state.start({ version: 1, id: 'restricted' });
  assert.equal(state.initCount, 0);
  assert.equal(state.ready, false);
  assert.deepEqual(notices, []);
  assert.deepEqual(errors, ['Authentication required']);
});

test('server errors with a non-JSON body retain the HTTP status', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 503, json: async () => { throw new SyntaxError('not JSON'); } });
  await state.start({ version: 1, id: 'unavailable' });
  assert.equal(state.initCount, 0);
  assert.deepEqual(notices, []);
  assert.match(errors[0], /503/);
});
