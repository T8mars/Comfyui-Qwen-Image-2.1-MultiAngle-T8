import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene } from '../web/editor/scene.mjs';
import { addReference, libraryManifest, libraryPrompt, staleGuide, USES } from '../web/editor/reference-library.mjs';

const source = readFileSync(new URL('../web/editor/references-ui.mjs', import.meta.url), 'utf8');
const refresh = source.slice(source.indexOf('export function refreshReferencesUI('), source.indexOf('\nfunction installCropDrag(')).replace('export ', '');

class Element {
  constructor(tag = 'div', text = '', value = '') { this.tag = tag; this.textContent = text; this._value = value; this.options = []; this.children = []; this.dataset = {}; this.classList = { toggle() {} }; }
  get value() { return this.tag === 'select' && !this.options.some(option => option.value === this._value) ? '' : this._value; }
  set value(value) { this._value = String(value); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); if (this.tag === 'select') this.options.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.options = []; this.append(...nodes); }
  remove() { if (!this.parent) return; this.parent.children = this.parent.children.filter(node => node !== this); this.parent.options = this.parent.options.filter(node => node !== this); }
  setAttribute() {}
  closest() { return this; }
}
function fixture(mode = 'guided') {
  const scene = defaultScene(); scene.conditioning.model = 'base'; scene.referenceLibrary.mode = mode;
  addReference(scene, { name: 'a'.repeat(64) + '.png', width: 1536, height: 864 });
  const nodes = new Map(), get = id => { if (!nodes.has(id)) nodes.set(id, new Element()); return nodes.get(id); };
  const Option = function (title, value) { return new Element('option', title, value); };
  for (const [id, values] of [['first-reference-resolution', ['0','768','1024','1536','2048']], ['image-order', ['reference-first','guide-first']], ['prompt-mode', ['default','single','custom']]]) {
    const node = new Element('select'); node.append(...values.map(value => new Option(value, value))); nodes.set(id, node);
  }
  const state = { doc: scene, context: { doc: () => state.doc, sourceConnected: () => false }, tab: 'materials', key: null, previewId: null, lastMapping: '', mappingWarning: '', renderedScene: null, renderedItems: [],
    $, libraryManifest, libraryPrompt, staleGuide, USES, Option,
    el: (tag, text) => new Element(tag, text), card: () => new Element(), button: () => new Element('button'), imageURL: () => '/asset',
    document: { querySelector: get },
  };
  function $(id) { return get(id); }
  vm.runInNewContext(refresh + '\nthis.refresh = refreshReferencesUI;', state);
  return { state, scene, get };
}

test('guided reference refresh preserves capability-owned export, batch and mouse-pitch controls', () => {
  const { state, get } = fixture();
  for (const disabled of [true, false]) {
    get('download-guide').disabled = disabled; get('open-batch').disabled = disabled;
    get('mouse-pitch').hidden = disabled;
    state.refresh();
    assert.equal(get('download-guide').disabled, disabled);
    assert.equal(get('open-batch').disabled, disabled);
    assert.equal(get('mouse-pitch').hidden, disabled);
  }
});

test('reference-only and text modes disable guide exports and camera batching', () => {
  for (const mode of ['references-only', 'text']) {
    const { state, get } = fixture(mode); get('download-guide').disabled = get('open-batch').disabled = false;
    state.refresh(); assert.equal(get('download-guide').disabled, true); assert.equal(get('open-batch').disabled, true);
  }
});

test('imported custom first-reference budgets remain visible and are not changed', () => {
  const { state, scene, get } = fixture('references-only');
  scene.referenceLibrary.firstResolution = 1152; state.refresh();
  const budget = get('first-reference-resolution');
  assert.equal(budget.value, '1152'); assert.equal(scene.referenceLibrary.firstResolution, 1152);
  assert.equal(budget.options.filter(option => option.dataset.custom === 'true').length, 1);
  scene.referenceLibrary.firstResolution = 896; state.refresh();
  assert.equal(budget.value, '896'); assert.equal(budget.options.filter(option => option.dataset.custom === 'true').length, 1);
  scene.referenceLibrary.firstResolution = 1024; state.refresh();
  assert.equal(budget.value, '1024'); assert.equal(budget.options.filter(option => option.dataset.custom === 'true').length, 0);
});

test('reference card edits bind to the restored scene after undo keeps the same reference values', () => {
  const { state, scene, get } = fixture();
  Object.assign(state, { openId: null, edit: action => action(), copy: value => JSON.parse(JSON.stringify(value)), useControls: () => new Element(),
    field: (text, input) => { const node = new Element('label', text); node.append(input); return node; },
    button: (text, action) => { const node = new Element('button', text); node.onclick = action; return node; } });
  vm.runInNewContext(source.slice(source.indexOf('function card('), source.indexOf('\nfunction moveReference(')), state);
  state.refresh();
  const restored = structuredClone(scene); state.doc = restored; state.refresh();
  const card = get('reference-cards').children[0].children[0], label = card.children.find(node => node.tag === 'label').children[0];
  label.value = 'Changed after undo'; label.onchange();
  assert.equal(restored.referenceLibrary.items[0].label, 'Changed after undo');
  assert.notEqual(scene.referenceLibrary.items[0].label, 'Changed after undo');
});

test('source and crop actions reflect wired source ownership and missing material images', () => {
  const { state, scene, get } = fixture();
  Object.assign(state, { openId: null, edit: action => action(), copy: value => JSON.parse(JSON.stringify(value)), useControls: () => new Element(),
    field: (text, input) => { const node = new Element('label', text); node.append(input); return node; },
    button: (text, action) => { const node = new Element('button', text); node.onclick = action; return node; } });
  vm.runInNewContext(source.slice(source.indexOf('function card('), source.indexOf('\nfunction moveReference(')), state);
  const action = text => get('reference-cards').children[0].children[0].children.at(-1).children.find(node => node.textContent === text);
  state.refresh(); assert.equal(action('作为来源图').disabled, false); assert.equal(action('裁切素材').disabled, false);
  state.context.sourceConnected = () => true; state.refresh();
  assert.equal(action('作为来源图').disabled, true); assert.match(action('作为来源图').title, /连线/); assert.equal(action('裁切素材').disabled, false);
  scene.referenceLibrary.items[0].asset = null; state.context.sourceConnected = () => false; state.refresh();
  assert.equal(action('作为来源图').disabled, true); assert.equal(action('裁切素材').disabled, true);
});

test('material replace and delete actions remain outside collapsed details and respect connected images', () => {
  const { state, scene, get } = fixture();
  Object.assign(state, { openId: null, edit: action => action(), copy: value => JSON.parse(JSON.stringify(value)), useControls: () => new Element(),
    field: (text, input) => { const node = new Element('label', text); node.append(input); return node; },
    button: (text, action) => { const node = new Element('button', text); node.onclick = action; return node; } });
  vm.runInNewContext(source.slice(source.indexOf('function card('), source.indexOf('\nfunction moveReference(')), state);
  state.refresh();
  let entry = get('reference-cards').children[0];
  assert.equal(entry.children[0].open, false);
  assert.deepEqual(Array.from(entry.children[1].children, node => node.textContent), ['替换图片','删除素材']);
  assert.equal(entry.children[1].children[0].disabled, false);
  scene.referenceLibrary.items[0].inputKey = 'actor_reference_1'; state.refresh();
  entry = get('reference-cards').children[0];
  assert.equal(entry.children[1].children[0].disabled, true);
  assert.match(entry.children[1].children[0].title, /上游.*已保存版本/);
  const id = scene.referenceLibrary.items[0].id; scene.referenceLibrary.firstReferenceId = id;
  entry.children[1].children[1].onclick();
  assert.equal(scene.referenceLibrary.items.length,0); assert.equal(scene.referenceLibrary.firstReferenceId,null);
});
