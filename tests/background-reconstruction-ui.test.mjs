import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene } from '../web/editor/scene.mjs';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const code = app.slice(app.indexOf('async function reconstructPhoto()'), app.indexOf("$('#preview-coarse').onclick"));

function fixture(keepBackground, fail = false) {
  const elements = new Map(), calls = [], restores = [];
  const doc = defaultScene(); doc.reference = { name: 'photo.png', width: 1200, height: 800 };
  doc.reconstruction.keepBackground = keepBackground;
  doc.source = { kind: 'splat', name: 'old.ply' }; doc.shots = [{ id: 'old' }];
  const state = {
    doc, previewRunning: false, previewTimer: null, previewGuide: 'pose', previewVisible: true,
    $: selector => { if (!elements.has(selector)) elements.set(selector, { hidden: false }); return elements.get(selector); },
    clone: structuredClone, clearTimeout, referenceCamera: () => ({ azimuth: 0 }),
    reconstruct: async (reference, progress, retry, keep) => {
      calls.push({ reference, retry, keep });
      if (fail) throw new Error('model error');
      return { kind: 'splat', name: 'new.ply', keep_background: keep };
    },
    studio: { async restore(doc) { restores.push(doc.source.name); }, setMode() {} },
    begin() {}, changed() {}, renderShots() {}, refresh() {}, schedulePreview() {},
    run: action => action(), loadReconstructionModels() {},
  };
  vm.runInNewContext(code, state);
  return { state, elements, calls, restores };
}

test('both reconstruction buttons use the background checkbox and return to the interactive 3D view', async () => {
  for (const selector of ['#reconstruct', '#extract-coarse']) {
    const { state, elements, calls } = fixture(false);
    elements.get('#keep-background').checked = true;
    elements.get('#keep-background').onchange();
    assert.equal(state.doc.reconstruction.keepBackground, true);
    await elements.get(selector).onclick();
    assert.equal(calls[0].keep, true);
    assert.equal(state.doc.source.keep_background, true);
    assert.equal(state.doc.conditioning.guide, 'coarse');
    assert.equal(state.previewVisible, false);
    assert.equal(state.doc.shots.length, 0);
    assert.match(elements.get('#loading-detail').textContent, /完整图像/);
  }
});

test('a failed full-frame reconstruction preserves the old 3D source and the requested checkbox setting', async () => {
  const { state, elements, restores } = fixture(true, true);
  await assert.rejects(elements.get('#reconstruct').onclick(), /model error/);
  assert.equal(state.doc.source.name, 'old.ply');
  assert.equal(state.doc.reconstruction.keepBackground, true);
  assert.deepEqual(restores, ['old.ply']);
  assert.equal(elements.get('#loading').hidden, true);
});
