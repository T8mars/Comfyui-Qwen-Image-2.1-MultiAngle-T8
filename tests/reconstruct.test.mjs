import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct, reconstructionGraph, reconstructionConfig, saveReconstructionModels, selectedReconstructionModels } from '../web/editor/reconstruct.mjs';

test('RGB reconstruction exports bind to the original RGBA image from the executed graph', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const reference = { name: 'original-rgba.png', width: 1536, height: 864, label: '原图' };
  const exported = { kind: 'splat', name: 'people.ply', reference: { name: 'exported-rgb.png', width: 1536, height: 864 } };
  const item = { prompt: [0, 'job', reconstructionGraph(reference, {})], outputs: { '12': { anyangle_reconstruction: [{ source: exported }] } } };
  const storage = new Map(), requests = [];
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.fetch = async url => {
    requests.push(url);
    if (url === '/anyangle-studio/reconstruction-config') return { ok: true, json: async () => ({ available: true, models: {} }) };
    if (url === '/prompt') return { ok: true, json: async () => ({ prompt_id: 'job' }) };
    if (url === '/history/job') return { ok: true, json: async () => ({ job: item }) };
    assert.equal(url, '/anyangle-studio/assets/people.ply'); return { ok: true };
  };
  try {
    const source = await reconstruct(reference, () => {});
    assert.deepEqual(source, { ...exported, reference });
    assert.equal(exported.reference.name, 'exported-rgb.png');
    assert.deepEqual(await reconstruct(reference, () => {}), source);
    assert.equal(requests.filter(url => url === '/prompt').length, 1);
    assert.deepEqual(JSON.parse(storage.get('anyangle-reconstruction:original-rgba.png')), { source });
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('old RGB-only completed caches recover from real job provenance without queuing models', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const reference = { name: 'original.png', width: 1536, height: 864 };
  const source = { name: 'people.ply', reference: { name: 'rgb.png', width: 1536, height: 864 } };
  const output = { '12': { anyangle_reconstruction: [{ source }] } };
  const graph = reconstructionGraph(reference, {});
  const storage = new Map([['anyangle-reconstruction:original.png', JSON.stringify({ source })]]), requests = [];
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  globalThis.fetch = async (url, options) => {
    requests.push(url);
    if (url === '/history?max_items=200') return { ok: true, json: async () => ({
      other: { prompt: [0, 'other', reconstructionGraph({ name: 'different.png' }, {})], outputs: output },
      matching: { prompt: [0, 'matching', graph], outputs: output },
    }) };
    assert.equal(url, '/anyangle-studio/assets/people.ply'); assert.equal(options.method, 'HEAD'); return { ok: true };
  };
  try {
    assert.deepEqual(await reconstruct(reference, () => {}), { ...source, reference });
    assert.deepEqual(requests, ['/history?max_items=200', '/anyangle-studio/assets/people.ply']);
    assert.deepEqual(JSON.parse(storage.get('anyangle-reconstruction:original.png')).source.reference, reference);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('a renamed export without matching image provenance cannot be rebound or cached', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const reference = { name: 'original.png', width: 1536, height: 864 };
  const source = { name: 'people.ply', reference: { name: 'rgb.png', width: 1536, height: 864 } };
  const storage = new Map();
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  try {
    for (const change of ['different-image', 'different-output-input', 'missing-receipt', 'different-dimensions']) {
      const graph = reconstructionGraph(reference, {}), result = structuredClone(source);
      if (change === 'different-image') graph['1'].inputs.image = 'anyangle_studio/other.png';
      if (change === 'different-output-input') graph['12'].inputs.reference = ['4', 0];
      if (change === 'different-dimensions') result.reference.width = 512;
      globalThis.fetch = async url => ({ ok: true, json: async () =>
        url === '/anyangle-studio/reconstruction-config' ? { available: true, models: {} }
          : url === '/prompt' ? { prompt_id: 'job' }
            : { job: { ...(change === 'missing-receipt' ? {} : { prompt: [0, 'job', graph] }), outputs: { '12': { anyangle_reconstruction: [{ source: result }] } } } },
      });
      await assert.rejects(reconstruct(reference, () => {}), /无法确认重建所用来源图/, change);
      assert.equal(storage.has('anyangle-reconstruction:original.png'), false);
    }
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('preserving backgrounds replaces segmentation with an opaque mask and keeps the native camera preprocessing', () => {
  const photo = { name: 'room.png' }, models = { background_removal: 'birefnet.safetensors' };
  const subject = reconstructionGraph(photo, models), scene = reconstructionGraph(photo, models, 46, true);
  assert.equal(subject['2'].class_type, 'LoadBackgroundRemovalModel');
  assert.equal(subject['3'].class_type, 'RemoveBackground');
  assert.equal(subject['12'].inputs.keep_background, false);
  assert.equal(scene['2'], undefined);
  assert.equal(scene['3'].class_type, 'SolidMask');
  assert.deepEqual(scene['3'].inputs, { value: 1, width: 1, height: 1 });
  assert.deepEqual(scene['4'], subject['4']);
  assert.deepEqual(scene['12'].inputs.mask, ['3', 0]);
  assert.equal(scene['12'].inputs.keep_background, true);
});

test('subject and full-frame results stay in separate caches and toggling back reuses only the matching mode', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const subject = { name: 'subject.ply', reference: { name: 'room.png' } };
  const scene = { name: 'scene.ply', keep_background: true, reference: { name: 'room.png' } };
  const storage = new Map([['anyangle-reconstruction:room.png', JSON.stringify({ source: subject })]]);
  const queued = [];
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  };
  globalThis.fetch = async (url, options) => {
    if (url.startsWith('/anyangle-studio/reconstruction-config')) {
      assert.equal(new URL(url, 'http://localhost').searchParams.get('keep_background'), '1');
      return { ok: true, json: async () => ({ available: true, models: {} }) };
    }
    if (url === '/prompt') {
      queued.push(JSON.parse(options.body).prompt);
      return { ok: true, json: async () => ({ prompt_id: 'scene-job' }) };
    }
    if (url === '/history/scene-job') return { ok: true, json: async () => ({ 'scene-job': { outputs: { '12': { anyangle_reconstruction: [{ source: scene }] } } } }) };
    assert.match(url, /^\/anyangle-studio\/assets\/(scene|subject)\.ply$/);
    return { ok: true };
  };
  try {
    assert.deepEqual(await reconstruct({ name: 'room.png' }, () => {}, true, true), scene);
    assert.deepEqual(await reconstruct({ name: 'room.png' }, () => {}, true, true), scene);
    assert.deepEqual(await reconstruct({ name: 'room.png' }, () => {}), subject);
    assert.equal(queued.length, 1);
    assert.equal(queued[0]['3'].class_type, 'SolidMask');
    assert.equal(JSON.parse(storage.get('anyangle-reconstruction:room.png')).source.name, 'subject.ply');
    assert.equal(JSON.parse(storage.get('anyangle-reconstruction:room.png:keep-background')).source.name, 'scene.ply');
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('a reconstruction job lost after a server restart is queued once more', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new Map([['anyangle-reconstruction:photo.png', JSON.stringify({ job: 'stale-job' })]]);
  const requests = [];
  const source = { kind: 'splat', name: 'recovered.ply', reference: { name: 'photo.png' } };
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  globalThis.fetch = async (url, options) => {
    requests.push([url, options?.method || 'GET']);
    let value;
    if (url === '/anyangle-studio/reconstruction-config') value = { available: true, models: {} };
    else if (url === '/history/stale-job') value = {};
    else if (url === '/queue') value = { queue_running: [], queue_pending: [] };
    else if (url === '/prompt') value = { prompt_id: 'new-job' };
    else if (url === '/history/new-job') value = { 'new-job': { outputs: { '12': { anyangle_reconstruction: [{ source }] } } } };
    else throw new Error(`Unexpected request ${url}`);
    return { ok: true, json: async () => value };
  };
  try {
    assert.deepEqual(await reconstruct({ name: 'photo.png' }, () => {}), source);
    assert.equal(requests.filter(([url]) => url === '/prompt').length, 1);
    assert.deepEqual(JSON.parse(storage.get('anyangle-reconstruction:photo.png')), { source });
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});

test('failed reconstruction without execution details reports the model error', async () => {
  const originalFetch = globalThis.fetch;
  const originalStorage = globalThis.localStorage;
  const storage = new Map();
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key),
  };
  globalThis.fetch = async url => ({
    ok: true,
    json: async () => url === '/anyangle-studio/reconstruction-config' ? { available: true, models: {} }
      : url === '/prompt' ? { prompt_id: 'failed-job' }
        : { 'failed-job': { status: { status_str: 'error' } } },
  });
  try {
    await assert.rejects(reconstruct({ name: 'photo.png' }, () => {}), /TripoSplat 重建失败/);
    assert.equal(storage.has('anyangle-reconstruction:photo.png'), false);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.localStorage = originalStorage;
  }
});

test('renamed model selections reach native loaders and do not reuse the default-model reconstruction', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  const storage = new Map([['anyangle-reconstruction:photo.png', JSON.stringify({ source: {
    name: 'old.ply', reference: { name: 'photo.png' },
  } })]]);
  globalThis.localStorage = {
    getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key),
  };
  const selections = { background_removal: '背景/my-birefnet.safetensors', clip_vision: 'vision/my-dino.safetensors',
    diffusion_models: '3d/my-triposplat.safetensors', vae_encoder: 'vae/my-flux.safetensors', vae_decoder: 'vae/my-decoder.safetensors' };
  const source = { name: 'new.ply', reference: { name: 'photo.png' } };
  let prompt, configRequests = 0;
  globalThis.fetch = async (url, options) => {
    const parsed = new URL(url, 'http://localhost');
    if (parsed.pathname === '/anyangle-studio/reconstruction-config') {
      configRequests++; assert.deepEqual(Object.fromEntries(parsed.searchParams), selections);
      return { ok: true, json: async () => ({ available: true, models: selections }) };
    }
    if (url === '/prompt') {
      prompt = JSON.parse(options.body).prompt;
      return { ok: true, json: async () => ({ prompt_id: 'new-job' }) };
    }
    assert.equal(url, '/history/new-job');
    return { ok: true, json: async () => ({ 'new-job': { outputs: { '12': { anyangle_reconstruction: [{ source }] } } } }) };
  };
  try {
    await saveReconstructionModels(selections);
    assert.deepEqual(selectedReconstructionModels(), selections);
    assert.deepEqual(await reconstruct({ name: 'photo.png' }, () => {}), source);
    assert.equal(configRequests, 2);
    for (const [id, input, role] of [['2', 'bg_removal_name', 'background_removal'], ['5', 'clip_name', 'clip_vision'],
      ['6', 'vae_name', 'vae_encoder'], ['8', 'unet_name', 'diffusion_models'], ['10', 'vae_name', 'vae_decoder']])
      assert.equal(prompt[id].inputs[input], selections[role]);
    assert.equal(JSON.parse(storage.get('anyangle-reconstruction:photo.png')).source.name, 'old.ply');
    assert.ok([...storage.values()].some(value => JSON.parse(value)?.source?.name === 'new.ply'));
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('invalid model choices are reported without overwriting saved preferences', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  let writes = 0;
  globalThis.localStorage = { getItem: () => '{}', setItem: () => { writes++; } };
  globalThis.fetch = async () => ({ ok: false, json: async () => ({ error: '模型不在可用列表中' }) });
  try {
    await assert.rejects(saveReconstructionModels({ vae_encoder: '../private.safetensors' }), /模型不在可用列表中/);
    assert.equal(writes, 0);
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});

test('ambiguous model discovery fails before queuing GPU work', async () => {
  const originalFetch = globalThis.fetch, originalStorage = globalThis.localStorage;
  globalThis.localStorage = { getItem: () => null };
  const requests = [];
  globalThis.fetch = async url => {
    requests.push(url);
    return { ok: true, json: async () => ({ available: false, missing: ['triposplat_fp16.safetensors'],
      ambiguous: { diffusion_models: ['first/triposplat_fp16.safetensors', 'second/triposplat_fp16.safetensors'] } }) };
  };
  try {
    await assert.rejects(reconstruct({ name: 'photo.png' }, () => {}), /多个同名文件.*手动选择/);
    assert.deepEqual(requests, ['/anyangle-studio/reconstruction-config']);
    globalThis.localStorage.getItem = () => '{broken';
    assert.deepEqual(selectedReconstructionModels(), {});
    await reconstructionConfig();
  } finally { globalThis.fetch = originalFetch; globalThis.localStorage = originalStorage; }
});
