import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

for (const name of ['AnyAngle-Studio-Qwen21.json', 'AnyAngle-Studio-Qwen21-Advanced.json']) {
  test(`${name} routes the studio model switch to the LoRA loader`, () => {
    const workflow = JSON.parse(readFileSync(new URL(`../workflows/${name}`, import.meta.url)));
    const studio = workflow.nodes.find(node => node.type === 'AnyAngleStudioT8');
    const lora = workflow.nodes.find(node => node.type === 'AnyAngleOptionalLoRAT8');
    assert.equal(studio.outputs[3].name, 'anyangle_lora_strength');
    const link = workflow.links.find(item => item[1] === studio.id && item[2] === 3);
    assert.deepEqual(link.slice(3, 6), [lora.id, lora.inputs.findIndex(input => input.name === 'strength_model'), 'FLOAT']);
    assert.equal(lora.inputs.find(input => input.name === 'strength_model').link, link[0]);
    assert.ok(studio.inputs.some(input => input.name === 'structure_image'));
  });
}

test('API workflow uses the model-strength output', () => {
  const workflow = JSON.parse(readFileSync(new URL('../workflows/AnyAngle-Studio-Qwen21-API.json', import.meta.url)));
  assert.deepEqual(workflow['4'].inputs.strength_model, ['1', 3]);
});
