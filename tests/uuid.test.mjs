import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { uuid } from '../web/uuid.mjs';
import { emptyLibrary, addReference, updateReferences } from '../web/editor/reference-library.mjs';
import { createActor } from '../web/editor/actors.mjs';

const pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function cryptoFor(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
  t.after(() => Object.defineProperty(globalThis, 'crypto', original));
}

test('secure contexts keep the native UUID method and its receiver', t => {
  const crypto = { randomUUID() { assert.equal(this, crypto); return 'native-uuid'; } };
  cryptoFor(t, crypto); assert.equal(uuid(), 'native-uuid');
});

test('LAN HTTP without randomUUID produces a v4 UUID from getRandomValues', t => {
  const crypto = Object.freeze({ getRandomValues(bytes) {
    assert.equal(this, crypto); bytes.set(Array.from({ length: 16 }, (_, i) => i)); return bytes;
  } });
  cryptoFor(t, crypto);
  assert.equal(uuid(), '00010203-0405-4607-8809-0a0b0c0d0e0f');
  assert.equal(crypto.randomUUID, undefined);
});

test('non-function randomUUID and repeated HTTP operations use distinct compatible IDs', t => {
  cryptoFor(t, { randomUUID: null, getRandomValues: webcrypto.getRandomValues.bind(webcrypto) });
  const ids = Array.from({ length: 4096 }, uuid);
  assert.ok(ids.every(id => pattern.test(id))); assert.equal(new Set(ids).size, ids.length);
  const scene = { version: 3, referenceLibrary: emptyLibrary() };
  const uploaded = addReference(scene, { name: 'upload.png' });
  updateReferences(scene, [{ inputKey: 'actor_reference_1', asset: { name: 'upstream.png' } }]);
  assert.equal(scene.referenceLibrary.items.length, 2);
  for (const item of scene.referenceLibrary.items) {
    assert.match(item.id.slice(4), pattern);
    assert.match(item.usages[0].id.slice(4), pattern);
  }
  assert.equal(uploaded.asset.name, 'upload.png'); assert.match(createActor().id.slice(6), pattern);
});

test('application modules route UUID creation through the HTTP-compatible helper', () => {
  const directory = new URL('../web/', import.meta.url);
  for (const entry of readdirSync(directory, { recursive: true })) {
    if (!/\.(?:mjs|js)$/.test(entry) || entry === 'uuid.mjs' || entry.startsWith('vendor')) continue;
    assert.doesNotMatch(readFileSync(new URL(entry.replaceAll('\\', '/'), directory), 'utf8'), /\bcrypto(?:\?\.|\.)randomUUID/, entry);
  }
});
