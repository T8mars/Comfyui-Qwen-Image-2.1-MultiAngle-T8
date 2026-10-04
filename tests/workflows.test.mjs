import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

for (const name of ['AnyAngle-Studio-Qwen21.json', 'AnyAngle-Studio-Qwen21-Advanced.json', 'AnyAngle-Studio-Qwen21-SingleGuide.json']) {
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

test('single-guide workflow needs no original photo and routes the guide to image1', () => {
  const workflow = JSON.parse(readFileSync(new URL('../workflows/AnyAngle-Studio-Qwen21-SingleGuide.json', import.meta.url)));
  assert.ok(!workflow.nodes.some(node => node.type === 'LoadImage'));
  const studio = workflow.nodes.find(node => node.type === 'AnyAngleStudioT8');
  const encoder = workflow.nodes.find(node => node.type === 'TextEncodeQwenImage21');
  assert.equal(studio.inputs.find(input => input.name === 'reference_image').link, null);
  const guide = workflow.links.find(link => link[1] === studio.id && link[2] === 0 && link[3] === encoder.id);
  assert.equal(encoder.inputs[guide[4]].name, 'images.image_1');
  assert.equal(encoder.inputs.find(input => input.name === 'images.image_2').link, null);
  for (const link of workflow.links) {
    assert.equal(workflow.nodes.find(node => node.id === link[3]).inputs[link[4]].link, link[0]);
    assert.ok(workflow.nodes.find(node => node.id === link[1]).outputs[link[2]].links.includes(link[0]));
  }
});

test('API workflow uses the model-strength output', () => {
  const workflow = JSON.parse(readFileSync(new URL('../workflows/AnyAngle-Studio-Qwen21-API.json', import.meta.url)));
  assert.deepEqual(workflow['4'].inputs.strength_model, ['1', 3]);
});
