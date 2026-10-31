import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import * as THREE from '../web/vendor/three.module.mjs';
import { SplatScene } from '../web/editor/splat.mjs';

// Exercise the bundled sort dispatcher, without starting a browser or WebGL.
const vendor = readFileSync(new URL('../web/vendor/gaussian-splats-3d.mjs', import.meta.url), 'utf8');
const start = vendor.indexOf('    runSplatSort = function() {');
const end = vendor.indexOf('    }();', start) + '    }();'.length;
const dispatcher = vendor.slice(start, end).replace('    runSplatSort = ', '').trim().replace(/;$/, '');

function fixture() {
  let renderRequests = 0;
  const scene = new SplatScene({ requestRender() { renderRequests++; } });
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 100);
  const points = [new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0)];
  const messages = [];
  const viewer = {
    camera, initialized: true, sortRunning: false, gpuAcceleratedSort: false,
    sharedMemoryForWorkers: false, preSortMessages: [],
    splatMesh: { dynamicMode: false, matrixWorld: new THREE.Matrix4(), getSplatCount: () => 2 },
    gatherSceneNodesForSort: () => ({ splatRenderCount: 2, shouldSortAll: false }),
    sortWorker: { postMessage(message) { messages.push(message.sort); } },
    runSplatSort: vm.runInNewContext(`(${dispatcher})`, { THREE }),
  };
  scene.watchSort(viewer);
  function turn(degrees) {
    const angle = THREE.MathUtils.degToRad(degrees);
    camera.position.set(20 * Math.sin(angle), 0, 20 * Math.cos(angle));
    camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true);
  }
  function complete() {
    assert.equal(viewer.sortRunning, true);
    const projection = new THREE.Matrix4().fromArray(messages.at(-1).modelViewProj);
    viewer.order = points.map((point, id) => ({ id, z: point.clone().applyMatrix4(projection).z }))
      .sort((a, b) => b.z - a.z).map(point => point.id);
    viewer.sortRunning = false; viewer.lastSplatSortCount = viewer.splatSortCount;
    viewer.sortPromiseResolver(); viewer.sortPromiseResolver = null;
  }
  return { viewer, scene, messages, turn, complete, renders: () => renderRequests };
}

test('a sub-degree camera turn refreshes overlapping splat depth order', async () => {
  const f = fixture();
  f.turn(-.1); await f.viewer.runSplatSort(true, true); f.complete(); await f.viewer.sortPromise;
  const before = [...f.viewer.order];
  f.turn(.1); await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 2, 'The live viewport must not retain the previous angle until an export forces a sort');
  f.complete(); await f.viewer.sortPromise;
  assert.deepEqual(f.viewer.order, [...before].reverse());
});

test('camera edits during sorting coalesce to the latest angle and stop rendering when idle', async () => {
  const f = fixture();
  f.turn(0); await f.viewer.runSplatSort();
  f.turn(.1); await f.viewer.runSplatSort();
  f.turn(.2); await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 1, 'Do not start competing sorts');
  f.complete(); await f.viewer.sortPromise;
  assert.equal(f.renders(), 1, 'The finished worker must schedule a frame for the latest camera');
  await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 2, 'Flush the latest camera even when it is below the vendor movement threshold');
  f.complete(); await f.viewer.sortPromise;
  const renders = f.renders();
  for (let i = 0; i < 10; i++) await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 2); assert.equal(f.renders(), renders);
});

test('returning from a capture camera refreshes live depth order only when its pose differs', async () => {
  const f = fixture(), live = f.viewer.camera;
  f.turn(-.1); await f.viewer.runSplatSort(true, true); f.complete(); await f.viewer.sortPromise;
  f.turn(.1); f.viewer.camera = live.clone();
  await f.viewer.runSplatSort(true, true); f.complete(); await f.viewer.sortPromise;
  const captured = [...f.viewer.order];
  f.viewer.camera = live; f.turn(-.1);
  await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 3); f.complete(); await f.viewer.sortPromise;
  assert.deepEqual(f.viewer.order, [...captured].reverse());
  f.viewer.camera = live.clone(); await f.viewer.runSplatSort();
  assert.equal(f.messages.length, 3, 'Cloning the same camera must not create an idle sort loop');
});
