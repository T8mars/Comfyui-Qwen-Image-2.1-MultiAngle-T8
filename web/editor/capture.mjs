import * as THREE from '../vendor/three.module.mjs';

// Keep the visible drawing buffer untouched: resizing it during asynchronous
// splat sorting exposes the capture framing for a frame in the workbench.
export function capturePNG(renderer, scene, camera, width, height, colorSpace = THREE.SRGBColorSpace) {
  const target = new THREE.WebGLRenderTarget(width, height, {
    format: THREE.RGBAFormat, type: THREE.UnsignedByteType,
    depthBuffer: true, stencilBuffer: false,
  });
  target.texture.colorSpace = colorSpace;
  target.samples = renderer.capabilities.isWebGL2 ? Math.min(4, renderer.capabilities.maxSamples) : 0;
  const previous = renderer.getRenderTarget();
  const viewport = renderer.getViewport(new THREE.Vector4());
  const scissor = renderer.getScissor(new THREE.Vector4());
  const scissorTest = renderer.getScissorTest();
  try {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, width, height);
    renderer.setScissorTest(false);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    // WebGL 1 lacks the WebGL 2 sRGB framebuffer conversion used by this target.
    if (colorSpace === THREE.SRGBColorSpace && !renderer.capabilities.isWebGL2) {
      for (let i = 0; i < pixels.length; i++) if (i % 4 !== 3) {
        const value = pixels[i] / 255;
        pixels[i] = Math.round(255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055));
      }
    }
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    const image = context.createImageData(width, height);
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      image.data.set(pixels.subarray(y * rowBytes, (y + 1) * rowBytes), (height - y - 1) * rowBytes);
    }
    context.putImageData(image, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    renderer.setRenderTarget(previous);
    renderer.setViewport(viewport);
    renderer.setScissor(scissor);
    renderer.setScissorTest(scissorTest);
    target.dispose();
  }
}
