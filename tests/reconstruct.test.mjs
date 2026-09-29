import test from 'node:test';
import assert from 'node:assert/strict';
import { reconstruct } from '../web/editor/reconstruct.mjs';

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
