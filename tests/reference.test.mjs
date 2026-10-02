import assert from 'node:assert/strict';
import { test } from 'node:test';
import { referencePlan, imageViewURL, importReference } from '../web/reference.mjs';

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

test('structure input resolves independently from the original image', () => {
  const graph = {
    '1': { inputs: { reference_image: ['2', 0], structure_image: ['3', 0] } },
    '2': { class_type: 'LoadImage', inputs: { image: 'portrait.png' } },
    '3': { class_type: 'DepthAnything3', inputs: { image: ['2', 0] } },
  };
  const structure = referencePlan(graph, 1, 'structure_image');
  assert.equal(structure.filename, null);
  assert.deepEqual(Object.keys(structure.upstream), ['2', '3']);
  assert.equal(referencePlan(graph, 1).filename, 'portrait.png');
});

test('reference import rejects foreign origins and non-image routes before any request', async () => {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  globalThis.location = new URL('http://localhost:8189/');
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return { ok: true, blob: async () => new Blob(['png']), json: async () => ({ name: 'saved.png' }) };
  };
  try {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/', '//example.org/view', '/\\169.254.169.254/view',
      '/\t/example.org/view', 'http://localhost:22/view', 'https://localhost:8189/view',
      '/anyangle-studio/snapshots/private', '/prompt', 'data:image/png;base64,AA==',
      'http://user:password@localhost:8189/view', null, {},
    ]) await assert.rejects(importReference(url));
    assert.equal(requests, 0, 'An invalid reference must not be fetched or uploaded');
  } finally { globalThis.fetch = oldFetch; globalThis.location = oldLocation; }
});

test('valid ComfyUI image URLs preserve filenames and forbid redirects during import', async () => {
  const oldFetch = globalThis.fetch, oldLocation = globalThis.location;
  globalThis.location = new URL('http://localhost:8189/');
  const requests = [], asset = { name: 'saved.png' };
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return url === '/anyangle-studio/assets'
      ? { ok: true, json: async () => asset }
      : { ok: true, blob: async () => new Blob(['png'], { type: 'image/png' }) };
  };
  try {
    const view = imageViewURL('子目录/照片.png', 'output', 'preview');
    for (const url of [view, new URL(view, location.origin).href]) {
      assert.deepEqual(await importReference(url), asset);
      const [fetched, options] = requests.at(-2);
      assert.equal(new URL(fetched).origin, location.origin);
      assert.equal(new URL(fetched).searchParams.get('filename'), '子目录/照片.png');
      assert.equal(options.mode, 'same-origin'); assert.equal(options.redirect, 'error');
      assert.ok(requests.at(-1)[1].body.get('file') instanceof Blob);
    }
    globalThis.fetch = async (_url, options) => {
      assert.equal(options.redirect, 'error'); throw new TypeError('Redirect blocked');
    };
    await assert.rejects(importReference(view), /Redirect blocked/);
  } finally { globalThis.fetch = oldFetch; globalThis.location = oldLocation; }
});
