import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referencePlan, imageViewURL } from '../web/reference.mjs';

test('direct input resolves image and excludes unrelated sampler', () => {
  const graph = {
    '1': { inputs: { reference_image: ['2', 0] } },
    '2': { class_type: 'LoadImage', inputs: { image: '照片.png' } },
    '3': { class_type: 'KSampler', inputs: {} },
  };
  const plan = referencePlan(graph, 1);
  assert.equal(plan.filename, '照片.png');
  assert.deepEqual(Object.keys(plan.upstream), ['2']);
  graph['2'].inputs.image = 'other.png';
  assert.notEqual(referencePlan(graph, 1).signature, plan.signature);
});

test('processed input includes only its dependencies; disconnected input permits uploads', () => {
  const graph = {
    '1': { inputs: { reference_image: ['3', 0] } },
    '2': { class_type: 'LoadImage', inputs: { image: 'input.png' } },
    '3': { class_type: 'ImageScale', inputs: { image: ['2', 0], width: 256 } },
    '4': { class_type: 'SaveImage', inputs: { images: ['3', 0] } },
  };
  const plan = referencePlan(graph, 1);
  assert.equal(plan.filename, null);
  assert.deepEqual(Object.keys(plan.upstream), ['2', '3']);
  delete graph['1'].inputs.reference_image;
  assert.equal(referencePlan(graph, 1), null);
});

test('annotated paths retain the correct ComfyUI directory and unicode filename', () => {
  const url = new URL(imageViewURL('子目录/照片.png [output]'), 'http://localhost');
  assert.equal(url.searchParams.get('filename'), '子目录/照片.png');
  assert.equal(url.searchParams.get('type'), 'output');
});
