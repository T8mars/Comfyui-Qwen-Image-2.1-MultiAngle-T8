import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { detachTargets } from '../web/editor/reference-library.mjs';

const source = readFileSync(new URL('../web/editor/cast-tools.mjs', import.meta.url), 'utf8')
  .replace(/^import .*\r?\n/gm, '').replace('export function installCastTools', 'function installCastTools');

function fixture() {
  const elements = new Map();
  function node(tag = 'div') {
    return { tag, children: [], append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, before() {}, click() {} };
  }
  const element = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  let doc = { source: { kind: 'human' }, props: [{ id: 'table', label: 'Table', asset: { name: 'table.glb' },
    transform: { x: 0, y: 0, z: -5, scale: 1, yaw: 0 }, visible: true, locked: false }] };
  const updates = [], history = [];
  let refresh;
  const context = {
    doc: () => doc, replace: value => { doc = value; }, run: task => task(),
    begin: () => { history.push(structuredClone(doc)); return () => history.pop(); }, changed: () => refresh(),
    studio: () => ({ updateProp: prop => updates.push(prop), restoreProps: async () => {}, restore: async () => {} }),
  };
  const state = { document: { getElementById: element, createElement: node, createTextNode: text => text, body: node() }, structuredClone, detachTargets };
  vm.runInNewContext(source, state);
  refresh = state.installCastTools(context);
  refresh();
  const card = () => element('prop-list').children[0];
  return { context, refresh, updates, history, card,
    input: index => card().children.filter(child => child.tag === 'label')[index].children[1],
    action: index => card().children.at(-1).children[index] };
}

test('prop controls edit the current scene after undo replaces it with identical prop values', async () => {
  const f = fixture(), old = f.context.doc();
  const restored = structuredClone(old); f.context.replace(restored); f.refresh();
  const input = f.input(0); input.value = '25'; input.onchange();
  assert.equal(restored.props[0].transform.x, 25);
  assert.equal(old.props[0].transform.x, 0);
  assert.equal(f.updates[0], restored.props[0]);
  await f.action(1).onclick();
  assert.equal(restored.props[0].locked, true);
  assert.equal(old.props[0].locked, false);
  assert.equal(f.input(0).disabled, true);
  await f.action(0).onclick();
  assert.equal(restored.props[0].visible, false);
  assert.equal(old.props[0].visible, true);
  await f.action(2).onclick();
  assert.equal(f.context.doc().props.length, 0);
  assert.equal(old.props.length, 1);
});

test('prop controls rebind when same-valued prop objects are replaced within the current scene', () => {
  const f = fixture(), old = f.context.doc().props[0];
  f.context.doc().props = structuredClone(f.context.doc().props); f.refresh();
  const current = f.context.doc().props[0];
  const input = f.input(2); input.value = '12'; input.onchange();
  assert.equal(current.transform.z, 12);
  assert.equal(old.transform.z, -5);
  assert.equal(f.updates[0], current);
});
