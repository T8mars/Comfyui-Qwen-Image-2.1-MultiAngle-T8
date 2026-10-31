import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { SplatScene } from '../web/editor/splat.mjs';

function fixture() {
  const size = { width: 900, height: 600 };
  const studio = new StudioScene({ parentElement: { getBoundingClientRect: () => size } }, {});
  studio.doc = defaultScene();
  studio.doc.width = 1536; studio.doc.height = 864;
  studio.doc.source = {
    kind: 'splat', camera_token: [.8, -.6, .2, .5, .8],
    bounds: [[-.5, 0, -.5], [.5, 1, .5]],
    reference: { width: 1000, height: 800 }, crop: [100, 30, 740, 670],
  };
  studio.splat = new SplatScene(studio.viewer); studio.splat.source = studio.doc.source;
  studio.baseTarget = new THREE.Vector3(); studio.shotHelper = { update() {} };
  studio.photoFrame = new THREE.LineLoop(new THREE.BufferGeometry());
  const rendered = [], frames = [];
  Object.assign(studio.viewer, {
    initialized: true, _viewportBufferLocked: true, scene: new THREE.Scene(),
    camera: new THREE.PerspectiveCamera(38, size.width / size.height, .1, 1000),
    captureCamera: new THREE.PerspectiveCamera(), captureFrame: new THREE.Object3D(),
    orbit: { target: new THREE.Vector3(), enableDamping: false },
    renderer: { render(scene, camera) { rendered.push(camera.projectionMatrix.clone()); } },
  });
  const originalRAF = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = callback => { frames.push(callback); return frames.length; };
  const flush = () => { while (frames.length) frames.shift()(); };
  studio.updateShot(); flush(); rendered.length = 0;
  return { studio, size, rendered, frames, flush, cleanup() {
    if (originalRAF === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRAF;
    studio.photoFrame.geometry.dispose(); studio.photoFrame.material.dispose();
  } };
}

test('resizing a rotated splat draws only the final workbench projection', () => {
  const f = fixture();
  try {
    for (const [width, height] of [[600, 900], [1600, 500], [900, 600]]) {
      f.rendered.length = 0;
      Object.assign(f.size, { width, height });
      f.studio.doc.camera.azimuth += 25;
      f.studio.resize();
      const expected = f.studio.viewer.camera.projectionMatrix.clone();
      f.flush();
      assert.ok(f.rendered.length > 0);
      assert.ok(f.rendered.every(matrix => matrix.equals(expected)),
        'Resize must not draw the unpadded output camera before restoring the workbench frame');
      assert.equal(f.frames.length, 0, 'Resize must not start a continuous render loop');
    }
  } finally { f.cleanup(); }
});

test('resize during asynchronous capture respects the live-render pause', () => {
  const f = fixture();
  try {
    f.studio.capturing = true;
    Object.assign(f.size, { width: 700, height: 800 });
    f.studio.resize(); f.flush();
    assert.equal(f.rendered.length, 0,
      'A live resize must not rebind the splat viewer while its capture camera is sorting');
    f.studio.capturing = false; f.studio.updateShot(); f.flush();
    assert.equal(f.rendered.length, 1, 'Resume with the latest viewport size');
  } finally { f.cleanup(); }
});
