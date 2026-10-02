import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { cameraBatchPlan, runCameraBatch } from '../web/editor/batch.mjs';
import { defaultScene } from '../web/editor/scene.mjs';

const source = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('function batchSettings()'), source.indexOf("$('#cancel').onclick"));

function fixture(failAt = null) {
  const elements = new Map(), angles = [], archives = [], errors = [];
  const original = defaultScene(); original.source.kind = 'human';
  let queueCount = 0;
  const state = {
    doc: original, embedded: true, batchRunning: false, batchController: null, batchViews: [], batchId: null,
    studio: { doc: original, syncPose() {}, updateShot() {} },
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { value: '', addEventListener() {}, showModal() {}, close() {} });
      return elements.get(selector);
    },
    cameraBatchPlan, runCameraBatch, AbortController, clearTimeout, previewTimer: undefined,
    captureGuide: async () => { angles.push(state.doc.camera.azimuth); return 'png'; },
    batchRequest: async action => {
      if (action === 'prepare') return {};
      queueCount++;
      if (queueCount === failAt) throw new Error('Queue failed');
      return { prompt_id: `job-${queueCount}` };
    },
    fetch: async (url, options) => {
      const body = JSON.parse(options.body);
      if (url === '/anyangle-studio/batches') { archives.push(body.views); return { ok: true, json: async () => ({ id: 'c'.repeat(64) }) }; }
      assert.equal(url, '/anyangle-studio/snapshots');
      assert.equal(body.png, 'png');
      return { ok: true, json: async () => ({ version: 1, id: String(angles.length).padStart(64, 'a') }) };
    },
    run: async action => action(), refresh() {}, error: e => errors.push(e.message), download() {},
  };
  vm.runInNewContext(code, state);
  state.$('#batch-mode').value = 'range'; state.$('#batch-start').value = '0';
  state.$('#batch-end').value = '20'; state.$('#batch-step').value = '10';
  return { state, elements, original, angles, archives, errors };
}

test('batch dialog queues distinct views and restores the original draft and controls', async () => {
  const { state, elements, original, angles, archives } = fixture();
  await state.startCameraBatch(true);
  assert.deepEqual(angles, [0, 10, 20]); assert.equal(state.doc, original); assert.equal(state.studio.doc, original);
  assert.equal(state.batchViews.length, 3); assert.equal(archives[0].length, 3);
  assert.equal(state.batchViews[2].prompt_id, 'job-3');
  assert.equal(elements.get('#batch-options').inert, false); assert.equal(elements.get('#batch-stop').disabled, true);
  assert.equal(elements.get('#batch-zip').disabled, false);
  assert.match(elements.get('#batch-state').textContent, /已入队 3/);
});

test('queue failure keeps the partial ZIP available and restores the camera without retrying', async () => {
  const { state, elements, original, angles, archives, errors } = fixture(2);
  await state.startCameraBatch(true);
  assert.deepEqual(angles, [0, 10]); assert.deepEqual(errors, ['Queue failed']);
  assert.equal(archives[0].length, 2); assert.equal(archives[0][1].prompt_id, undefined);
  assert.equal(state.doc, original); assert.equal(elements.get('#batch-manifest').disabled, false);
  assert.match(elements.get('#batch-state').textContent, /已入队 1/);
});

test('stop during rendering saves no partial frame and restores the original camera', async () => {
  const { state, original, archives } = fixture();
  state.captureGuide = async () => { state.batchController.abort(); return 'png'; };
  await state.startCameraBatch(false);
  assert.equal(state.batchViews.length, 0); assert.equal(archives.length, 0);
  assert.equal(state.doc, original); assert.equal(state.batchRunning, false);
});
