import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { capturePNG } from '../web/editor/capture.mjs';

function rendererAt(pixelRatio, target = null) {
  // Three's setViewport scales CSS units by DPR; setRenderTarget uses the
  // target's own viewport in physical pixels, regardless of display scaling.
  const renderer = {
    capabilities: { isWebGL2: true, maxSamples: 4 }, target,
    viewport: new THREE.Vector4(0, 0, 800, 600),
    scissor: new THREE.Vector4(10, 20, 400, 300), scissorTest: true,
    currentViewport: new THREE.Vector4(), currentScissor: new THREE.Vector4(),
    getRenderTarget() { return this.target; },
    setRenderTarget(value) {
      this.target = value;
      this.currentViewport.copy(value ? value.viewport : this.viewport.clone().multiplyScalar(pixelRatio).floor());
      this.currentScissor.copy(value ? value.scissor : this.scissor.clone().multiplyScalar(pixelRatio).floor());
      this.currentScissorTest = value ? value.scissorTest : this.scissorTest;
    },
    getViewport(out) { return out.copy(this.viewport); },
    setViewport(...args) {
      this.viewport.copy(args.length === 1 ? args[0] : new THREE.Vector4(...args));
      this.currentViewport.copy(this.viewport).multiplyScalar(pixelRatio).floor();
    },
    getScissor(out) { return out.copy(this.scissor); },
    setScissor(value) { this.scissor.copy(value); this.currentScissor.copy(value).multiplyScalar(pixelRatio).floor(); },
    getScissorTest() { return this.scissorTest; },
    setScissorTest(value) { this.scissorTest = this.currentScissorTest = value; },
    setSize() { assert.fail('Capture must not resize the workbench'); },
    setPixelRatio() { assert.fail('Capture must not change the workbench DPR'); },
    render(scene, camera) {
      if (this.fail) throw new Error('render failed');
      const v = this.currentViewport;
      this.positions = scene.children.map(object => {
        const ndc = object.position.clone().project(camera);
        return [
          (v.x + (ndc.x + 1) * v.z / 2) / this.target.width,
          1 - (v.y + (ndc.y + 1) * v.w / 2) / this.target.height,
        ];
      });
    },
    readRenderTargetPixels() {},
  };
  renderer.setRenderTarget(target);
  return renderer;
}

function withCanvas(callback) {
  const oldDocument = globalThis.document;
  globalThis.document = { createElement: () => ({
    getContext: () => ({ createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }), putImageData() {} }),
    toDataURL: () => 'data:image/png;test',
  }) };
  try { callback(); } finally { globalThis.document = oldDocument; }
}

for (const pixelRatio of [1, 1.25, 1.5, 2]) {
  test(`center and frame edges agree between preview and PNG at display DPR ${pixelRatio}`, () => withCanvas(() => {
    const renderer = rendererAt(pixelRatio);
    for (const [width, height] of [[1024, 1024], [864, 1536], [1536, 864]]) {
      const camera = new THREE.PerspectiveCamera(30, width / height, 0.1, 100);
      camera.position.set(0, 0, 10); camera.updateMatrixWorld(true);
      const scene = new THREE.Scene();
      for (const [x, y] of [[0, 0], [-0.8, 0.8], [0.8, -0.8]]) {
        const point = new THREE.Object3D();
        point.position.set(x, y, 0).unproject(camera); scene.add(point);
      }
      const scale = Math.min(1, 500 / Math.max(width, height));
      for (const size of [[Math.round(width * scale), Math.round(height * scale)], [width, height]]) {
        capturePNG(renderer, scene, camera, ...size);
        for (const [i, expected] of [[0, [0.5, 0.5]], [1, [0.1, 0.1]], [2, [0.9, 0.9]]]) {
          renderer.positions[i].forEach((value, axis) => assert.ok(Math.abs(value - expected[axis]) < 1e-9,
            `DPR ${pixelRatio}, ${size}: point ${i} axis ${axis} is ${value}, expected ${expected[axis]}`));
        }
        assert.equal(renderer.target, null);
        assert.deepEqual(renderer.currentViewport.toArray(), [0, 0, Math.floor(800 * pixelRatio), Math.floor(600 * pixelRatio)]);
      }
    }
  }));
}

test('capture restores a previously bound render target after success and failure', () => withCanvas(() => {
  const previous = new THREE.WebGLRenderTarget(320, 240);
  previous.viewport.set(3, 4, 300, 220); previous.scissor.set(5, 6, 290, 210); previous.scissorTest = false;
  const renderer = rendererAt(2, previous);
  try {
    for (const fail of [false, true]) {
      renderer.fail = fail;
      const capture = () => capturePNG(renderer, new THREE.Scene(), new THREE.PerspectiveCamera(), 16, 16);
      if (fail) assert.throws(capture, /render failed/); else capture();
      assert.equal(renderer.target, previous);
      assert.deepEqual(renderer.viewport.toArray(), [0, 0, 800, 600]);
      assert.deepEqual(renderer.currentViewport.toArray(), previous.viewport.toArray());
      assert.deepEqual(renderer.currentScissor.toArray(), previous.scissor.toArray());
      assert.equal(renderer.scissorTest, true); assert.equal(renderer.currentScissorTest, false);
    }
  } finally { previous.dispose(); }
}));
