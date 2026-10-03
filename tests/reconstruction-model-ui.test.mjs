import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const panelCode = app.slice(app.indexOf('const reconstructionModelLabels ='), app.indexOf('\nasync function reconstructPhoto()'));

class Element {
  constructor(tag = 'div') { this.tag = tag; this.children = []; this.dataset = {}; this.value = ''; }
  append(...children) { this.children.push(...children); }
  replaceChildren() { this.children = []; }
  setAttribute() {}
  querySelectorAll(tag) { return this.children.flatMap(child => [child, ...child.querySelectorAll(tag)]).filter(child => child.tag === tag); }
}

function fixture(selected = {}, rejectStale = false) {
  const elements = new Map(), saved = [];
  const models = { background_removal: 'birefnet.safetensors', clip_vision: 'dino.safetensors',
    diffusion_models: 'organized/triposplat.safetensors', vae_encoder: 'flux.safetensors', vae_decoder: 'decoder.safetensors' };
  const config = { available: true, missing: [], ambiguous: {}, models,
    choices: Object.fromEntries(Object.entries(models).map(([role, name]) => [role, [name, `renamed/${role}.safetensors`]])) };
  const state = {
    ready: true, doc: { reconstruction: { keepBackground: false } },
    $: selector => { if (!elements.has(selector)) elements.set(selector, new Element()); return elements.get(selector); },
    document: { createElement: tag => new Element(tag) },
    selectedReconstructionModels: () => selected,
    reconstructionConfig: async selections => {
      if (rejectStale && Object.values(selections).some(name => name === 'moved.safetensors')) throw new Error('模型不在可用列表中');
      return config;
    },
    saveReconstructionModels: async selections => { saved.push(JSON.parse(JSON.stringify(selections))); return config; },
    run: async action => action(), toast() {},
  };
  vm.runInNewContext(panelCode, state);
  return { state, elements, saved, config };
}

test('model panel offers all five roles, preserves manual choices and saves the selected filenames', async () => {
  const chosen = { diffusion_models: 'renamed/diffusion_models.safetensors' };
  const { state, elements, saved } = fixture(chosen);
  await state.loadReconstructionModels();
  const selects = elements.get('#reconstruction-model-fields').querySelectorAll('select');
  assert.equal(selects.length, 5);
  const diffusion = selects.find(select => select.dataset.role === 'diffusion_models');
  assert.equal(diffusion.value, chosen.diffusion_models);
  assert.ok(diffusion.children.some(option => option.textContent === chosen.diffusion_models));
  const vae = selects.find(select => select.dataset.role === 'vae_encoder');
  vae.value = 'renamed/vae_encoder.safetensors';
  await elements.get('#reconstruction-model-save').onclick();
  assert.deepEqual(saved, [{ ...chosen, vae_encoder: vae.value }]);
});

test('a moved saved model remains visible and the panel still allows correcting the selection', async () => {
  const { state, elements, saved } = fixture({ diffusion_models: 'moved.safetensors' }, true);
  await assert.rejects(state.loadReconstructionModels(), /模型不在可用列表中/);
  const select = elements.get('#reconstruction-model-fields').querySelectorAll('select')
    .find(select => select.dataset.role === 'diffusion_models');
  assert.ok(select.children.some(option => option.disabled && option.value === 'moved.safetensors'));
  assert.equal(elements.get('#reconstruction-model-save').disabled, false);
  select.value = 'renamed/diffusion_models.safetensors';
  await elements.get('#reconstruction-model-save').onclick();
  assert.deepEqual(saved, [{ diffusion_models: select.value }]);
});

test('background mode shows four required models and leaves the unused segmentation role disabled', async () => {
  const { state, elements } = fixture();
  state.doc.reconstruction.keepBackground = true;
  await state.loadReconstructionModels();
  const background = elements.get('#reconstruction-model-fields').querySelectorAll('select')
    .find(select => select.dataset.role === 'background_removal');
  assert.equal(background.disabled, true);
  assert.match(elements.get('#reconstruction-model-state').textContent, /4 个重建模型已就绪/);
});
