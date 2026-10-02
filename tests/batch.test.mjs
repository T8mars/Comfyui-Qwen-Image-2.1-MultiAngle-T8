import test from 'node:test';
import assert from 'node:assert/strict';
import { cameraBatchPlan, runCameraBatch, supportsCameraBatch } from '../web/editor/batch.mjs';
import { promptForSnapshot } from '../web/batch-queue.mjs';
import { defaultScene } from '../web/editor/scene.mjs';

function scene() { const value = defaultScene(); value.source.kind = 'human'; return value; }
const token = index => ({ version: 1, id: String(index).padStart(64, 'a') });

test('a one-degree turn yields 360 distinct cameras and keeps the original framing and pose', () => {
  const original = scene(), saved = structuredClone(original);
  const plan = cameraBatchPlan(original, { mode: 'range', start: 0, end: 360, step: 1 });
  const views = [...plan.views()];
  assert.equal(plan.count, 360); assert.equal(new Set(views.map(view => view.scene.camera.azimuth)).size, 360);
  assert.deepEqual(views[0].scene.camera, { ...original.camera, azimuth: 0 });
  assert.equal(views[180].scene.camera.azimuth, -180);
  assert.deepEqual(original, saved);
  assert.deepEqual(views[17].scene.pose, original.pose);
  assert.equal(views[17].scene.camera.zoom, original.camera.zoom);
});

test('fractional and descending steps and saved views preserve per-view dimensions', () => {
  assert.equal(cameraBatchPlan(scene(), { mode: 'range', start: 10, end: 9, step: -0.25 }).count, 5);
  const original = scene(); original.shots = [{ name: 'portrait', camera: { azimuth: 90 }, width: 864, height: 1536 }];
  const saved = [...cameraBatchPlan(original, { mode: 'saved' }).views()][0];
  assert.equal(saved.scene.width, 864); assert.equal(saved.scene.height, 1536);
  assert.equal(saved.scene.camera.elevation, original.camera.elevation);
  for (const settings of [{ start: 0, end: 10, step: 0 }, { start: 0, end: 10, step: -1 }, { start: NaN, end: 1, step: 1 }])
    assert.throws(() => cameraBatchPlan(original, settings));
  assert.throws(() => cameraBatchPlan(scene(), { mode: 'saved' }), /收藏/);
});

test('photo depth and skeleton maps do not pretend to provide new camera views', () => {
  const value = scene(); value.conditioning = { model: 'base', guide: 'depth', map: { name: 'photo-depth.png' }, mapKind: 'depth' };
  assert.equal(supportsCameraBatch(value), false);
  assert.throws(() => cameraBatchPlan(value, { start: 0, end: 10, step: 1 }), /原图结构图/);
  value.conditioning = { model: 'base', guide: 'pose', map: null };
  assert.equal(supportsCameraBatch(value), true);
  value.conditioning = { model: 'base', guide: 'canny', mapOrigin: 'auto' };
  assert.equal(supportsCameraBatch(value), true);
});

test('each camera is captured and saved before its own prompt is queued, without retaining PNGs', async () => {
  const plan = cameraBatchPlan(scene(), { start: 0, end: 20, step: 10 }), events = [];
  const result = await runCameraBatch(plan, {
    capture: async view => { events.push(`capture:${view.camera.azimuth}`); return `png:${view.camera.azimuth}`; },
    save: async (view, png) => { assert.equal(png, `png:${view.camera.azimuth}`); events.push('save'); return token(view.camera.azimuth); },
    queue: async snapshot => { events.push('queue'); return snapshot.id; },
  });
  assert.deepEqual(events, ['capture:0', 'save', 'queue', 'capture:10', 'save', 'queue', 'capture:20', 'save', 'queue']);
  assert.equal(result.views.length, 3); assert.equal(result.error, null);
  assert.ok(result.views.every(view => view.prompt_id === view.snapshot.id && !('png' in view)));
});

test('a failed queue preserves its saved guide and never submits subsequent angles', async () => {
  let captures = 0;
  const result = await runCameraBatch(cameraBatchPlan(scene(), { start: 0, end: 20, step: 10 }), {
    capture: async () => { captures++; return 'png'; }, save: async () => token(0), queue: async () => { throw new Error('Invalid workflow'); },
  });
  assert.equal(captures, 1); assert.equal(result.views.length, 1); assert.match(result.error.message, /Invalid workflow/);
  assert.equal(result.views[0].prompt_id, undefined);
});

test('stopping during capture avoids saving or queuing the cancelled view', async () => {
  const controller = new AbortController(); let saves = 0;
  const result = await runCameraBatch(cameraBatchPlan(scene(), { start: 0, end: 20, step: 10 }), {
    signal: controller.signal,
    capture: async () => { controller.abort(); return 'png'; }, save: async () => { saves++; return token(0); },
  });
  assert.equal(result.stopped, true); assert.equal(saves, 0); assert.equal(result.views.length, 0);
});

test('queued prompts and PNG workflow metadata receive distinct snapshots without mutating the live graph', () => {
  const original = { output: { '1': { class_type: 'AnyAngleStudioT8', inputs: { snapshot: 'old' } },
    '2': { class_type: 'KSampler', inputs: { seed: 42, steps: 20 } } },
    workflow: { nodes: [{ id: 1, widgets_values: ['old'] }, { id: 2, widgets_values: [42, 20] }] } };
  const first = promptForSnapshot(original, 1, token(0)), second = promptForSnapshot(original, 1, token(10));
  assert.notEqual(first.output['1'].inputs.snapshot, second.output['1'].inputs.snapshot);
  assert.equal(first.output['1'].inputs.snapshot, first.workflow.nodes[0].widgets_values[0]);
  assert.equal(second.output['1'].inputs.snapshot, second.workflow.nodes[0].widgets_values[0]);
  assert.equal(original.output['1'].inputs.snapshot, 'old');
  assert.deepEqual(first.output['2'], original.output['2']);
  assert.throws(() => promptForSnapshot(original, 1, { version: 1, id: '../secret' }));
});
