import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct, reconstructionGraph, reconstructionConfig, saveReconstructionModels, selectedReconstructionModels } from '../web/editor/reconstruct.mjs';

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
