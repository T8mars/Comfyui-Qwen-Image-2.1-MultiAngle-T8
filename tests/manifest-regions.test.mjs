import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildManifest, actorPrompt } from '../web/editor/manifest.mjs';

function sharedScene() { return JSON.parse(readFileSync(new URL('./fixtures/multiperson-contract.json', import.meta.url))); }

test('selected people sharing one photo retain distinct descriptions and pixel/normalized regions in the shared contract', () => {
  const scene = sharedScene(), manifest = buildManifest(scene), prompt = actorPrompt(scene);
  assert.deepEqual(manifest, scene.manifest); assert.equal(prompt, scene.resolvedPrompt);
  assert.deepEqual(manifest.references[0].actorIds, ['actor-0', 'actor-1']);
  assert.equal(manifest.actors[0].referenceIndex, manifest.actors[1].referenceIndex);
  assert.ok(prompt.includes('person 1 in the source photo; selected source pixel region [80, 40, 280, 400] in a 640 x 480 image (normalized region [0.125, 0.083333, 0.4375, 0.833333])'));
  assert.ok(prompt.includes('person 2 in the source photo; selected source pixel region [320, 40, 520, 400]'));
});

test('old region bindings without source dimensions keep pixel coordinates alongside the description', () => {
  const scene = sharedScene(); scene.actors[0].identity.sourcePerson = { description: 'left person', bbox: [1, 2, 3.25, 4.5] };
  const prompt = actorPrompt(scene);
  assert.ok(prompt.includes('left person; selected source pixel region [1, 2, 3.25, 4.5] from <image2>'));
  scene.actors[0].identity.sourcePerson = 'person in the red coat';
  assert.ok(actorPrompt(scene).includes('the character person in the red coat from <image2>'));
});

test('region rounding is deterministic and custom prompt remains unchanged', () => {
  const scene = sharedScene(); scene.actors[0].identity.sourcePerson = { bbox: [-.5, -1, 5, 7], canvasWidth: 3, canvasHeight: 7 };
  assert.ok(actorPrompt(scene).includes('normalized region [-0.166667, -0.142857, 1.666667, 1]'));
  scene.conditioning.promptMode = 'custom'; scene.conditioning.customPrompt = '  keep <image7>\n';
  assert.equal(actorPrompt(scene), scene.conditioning.customPrompt);
});
