export const GUIDE_LABELS = {
  coarse: '三维粗渲染', pose: 'OpenPose 姿势', depth: 'Depth Anything 深度', canny: 'Canny 轮廓',
};

export const PROMPTS = {
  anyangle: 'Change the camera angle from <image2> to <image1>.',
  coarse: 'Use <image1> as the identity, clothing and style reference. Recreate the same subject at the camera angle and composition shown by <image2>.',
  pose: 'Use <image1> as the identity, clothing and style reference. Recreate the same subject in the body pose and framing shown by <image2>.',
  depth: 'Use <image1> as the identity, clothing and style reference. Follow the spatial depth, layout and occlusion relationships shown by <image2>.',
  canny: 'Use <image1> as the identity, clothing and style reference. Follow the silhouette, contours and major edge layout shown by <image2>.',
};

export function guidePrompt(conditioning) {
  return conditioning?.model === 'base' ? PROMPTS[conditioning.guide] || PROMPTS.coarse : PROMPTS.anyangle;
}

export function guideSource(scene) {
  const settings = scene.conditioning || {};
  const guide = settings.model === 'anyangle' ? 'coarse' : settings.guide || 'coarse';
  if (guide === 'coarse') return { kind: 'scene' };
  if (settings.map && (settings.mapKind || guide) === guide) return { kind: 'image', asset: settings.map };
  if (guide === 'pose') return { kind: 'pose' };
  if (guide === 'depth') return { kind: 'missing' };
  if (scene.reference && (settings.mapOrigin !== 'auto' || scene.source.kind === 'empty'))
    return { kind: 'canny-image', asset: scene.reference };
  return scene.source.kind === 'empty' ? { kind: 'missing' } : { kind: 'canny-scene' };
}

export function cannyEdges(rgba, width, height, low = 50, high = 150) {
  const size = width * height, gray = new Float32Array(size), horizontal = new Float32Array(size), blurred = new Float32Array(size);
  const kernel = [1, 4, 6, 4, 1];
  for (let i = 0; i < size; i++) gray[i] = .299 * rgba[i * 4] + .587 * rgba[i * 4 + 1] + .114 * rgba[i * 4 + 2];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += gray[y * width + Math.max(0, Math.min(width - 1, x + k))] * kernel[k + 2];
    horizontal[y * width + x] = sum / 16;
  }
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let k = -2; k <= 2; k++) sum += horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x] * kernel[k + 2];
    blurred[y * width + x] = sum / 16;
  }
  const magnitude = new Float32Array(size), direction = new Uint8Array(size);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x;
    const gx = blurred[i - width + 1] + 2 * blurred[i + 1] + blurred[i + width + 1]
      - blurred[i - width - 1] - 2 * blurred[i - 1] - blurred[i + width - 1];
    const gy = blurred[i + width - 1] + 2 * blurred[i + width] + blurred[i + width + 1]
      - blurred[i - width - 1] - 2 * blurred[i - width] - blurred[i - width + 1];
    magnitude[i] = Math.min(255, Math.hypot(gx, gy));
    const angle = (Math.atan2(gy, gx) * 180 / Math.PI + 180) % 180;
    direction[i] = angle < 22.5 || angle >= 157.5 ? 0 : angle < 67.5 ? 1 : angle < 112.5 ? 2 : 3;
  }
  const weak = new Uint8Array(size), output = new Uint8ClampedArray(size * 4), stack = [];
  const offsets = [1, width + 1, width, width - 1];
  high = Math.max(low, high);
  for (let y = 1; y < height - 1; y++) for (let x = 1; x < width - 1; x++) {
    const i = y * width + x, delta = offsets[direction[i]], value = magnitude[i];
    if (value < low || value < magnitude[i - delta] || value < magnitude[i + delta]) continue;
    weak[i] = 1;
    if (value >= high) { weak[i] = 2; stack.push(i); }
  }
  while (stack.length) {
    const i = stack.pop();
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const j = i + dy * width + dx;
      if (weak[j] === 1) { weak[j] = 2; stack.push(j); }
    }
  }
  for (let i = 0; i < size; i++) {
    const value = weak[i] === 2 ? 255 : 0;
    output[i * 4] = output[i * 4 + 1] = output[i * 4 + 2] = value;
    output[i * 4 + 3] = 255;
  }
  return output;
}
