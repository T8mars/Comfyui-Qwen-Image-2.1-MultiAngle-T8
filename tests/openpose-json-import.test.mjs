import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const start = app.indexOf("$('#openpose-file').onchange");
const handler = app.slice(start, app.indexOf("$('#map-file').onchange", start));

async function importJSON(reference, keypoints) {
  const input = {}, requests = [], notices = [];
  const state = {
    doc: { width: 1536, height: 864, reference, openpose: {} }, run: task => task(),
    $: () => input, changed() {}, toast: message => notices.push(message),
    applyOpenPoseAsset: async () => {},
    fetch: async (_url, options) => { requests.push(JSON.parse(options.body)); return { ok: true,
      json: async () => ({ asset: { name: 'pose.png' }, people: [{ id: 'json-0' }] }) }; },
  };
  vm.runInNewContext(handler, state);
  const target = { value: 'pose.json', files: [{ name: 'pose.json', text: async () => JSON.stringify(keypoints) }] };
  await input.onchange({ target });
  assert.equal(target.value, ''); assert.equal(state.doc.openpose.origin, 'json');
  return { request: requests[0], notices };
}

test('standard OpenPose JSON without canvas metadata uses source photo pixels and explains the fallback', async () => {
  const pose = { version: 1.3, people: [{ pose_keypoints_2d: [100, 200, .9] }] };
  const { request, notices } = await importJSON({ name: 'source.png', width: 1280, height: 720 }, pose);
  assert.deepEqual(request.keypoints, pose);
  assert.equal(request.canvas_width, 1280); assert.equal(request.canvas_height, 720);
  assert.match(notices[0], /原图 1280 × 720 像素坐标/);
});

test('JSON without a photo uses output dimensions, while explicit frame dimensions and coordinates remain intact', async () => {
  const pose = [{ version: 1.3, people: [{ pose_keypoints_2d: [23, 47, .8] }] }];
  const missing = await importJSON(null, pose);
  assert.equal(missing.request.canvas_width, 1536); assert.equal(missing.request.canvas_height, 864);
  assert.match(missing.notices[0], /当前输出 1536 × 864/);
  const explicit = { ...pose[0], canvas_width: 960, canvas_height: 540 };
  const supplied = await importJSON({ width: 1280, height: 720 }, explicit);
  assert.deepEqual(supplied.request.keypoints, explicit); assert.equal(supplied.notices.length, 0);
  const laterFrame = await importJSON(null, [explicit, pose[0]]);
  assert.equal(laterFrame.notices.length, 0, 'Only the first frame is consumed, so later canvas metadata must not cause a notice');
});
