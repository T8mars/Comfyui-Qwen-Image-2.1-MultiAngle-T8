import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cannyEdges, guidePrompt, guideImageIndex, guideSource, PROMPTS, SINGLE_PROMPTS } from '../web/editor/guides.mjs';
import { detectSkeleton, liftOpenPose, ORDER, LIMBS, COLORS } from '../web/editor/openpose.mjs';

test('guide mode changes the edit instruction without changing image roles', () => {
  assert.equal(guidePrompt({ model: 'anyangle', guide: 'depth' }), PROMPTS.anyangle);
  for (const guide of ['coarse', 'pose', 'depth', 'canny']) {
    const prompt = guidePrompt({ model: 'base', guide });
    assert.match(prompt, /<image1>/);
    assert.match(prompt, /<image2>/);
    assert.notEqual(prompt, PROMPTS.anyangle);
  }
});

test('swapping input roles changes each template image tag exactly once', () => {
  assert.equal(guidePrompt({ model: 'anyangle', imageOrder: 'guide-first' }), 'Change the camera angle from <image1> to <image2>.');
  for (const guide of ['coarse', 'pose', 'depth', 'canny']) {
    const settings = { model: 'base', guide, imageOrder: 'guide-first' };
    assert.ok(guidePrompt(settings).startsWith('Use <image2>'));
    assert.ok(guidePrompt(settings).endsWith('<image1>.'));
    assert.equal(guideImageIndex(settings), 1);
  }
});

test('single-guide templates refer only to image1 and accept a text subject description', () => {
  for (const guide of ['coarse', 'pose', 'depth', 'canny']) {
    const settings = { model: 'base', guide, promptMode: 'single', promptExtra: '  An astronaut in a moon base.  ' };
    assert.equal(guidePrompt(settings), `${SINGLE_PROMPTS[guide]}\nAn astronaut in a moon base.`);
    assert.doesNotMatch(guidePrompt(settings), /<image2>|identity.*reference/);
    assert.equal(guideImageIndex(settings), 1);
  }
});

test('custom prompts, including empty text, survive guide and image-order changes verbatim', () => {
  for (const customPrompt of ['', '  Follow <image3>.\nKeep the text: image1 and image2.  ']) {
    assert.equal(guidePrompt({ model: 'base', guide: 'pose', promptMode: 'custom', customPrompt,
      imageOrder: 'guide-first', promptExtra: 'must not append' }), customPrompt);
  }
});

test('base coarse scene reconstruction preserves foreground and background while AnyAngle keeps its official prompt', () => {
  const source = { kind: 'splat', keep_background: true };
  assert.equal(guidePrompt({ model: 'base', guide: 'coarse' }, source), PROMPTS.scene);
  assert.equal(guidePrompt({ model: 'base', guide: 'coarse' }), PROMPTS.coarse);
  assert.equal(guidePrompt({ model: 'anyangle', guide: 'coarse' }, source), PROMPTS.anyangle);
});

test('photo skeleton and depth use their extracted image even with an unrelated mannequin loaded', () => {
  const map = { name: 'photo-guide.png' }, reference = { name: 'photo.png' };
  for (const guide of ['pose', 'depth']) {
    const scene = { source: { kind: 'human' }, reference, conditioning: { model: 'base', guide, map, mapKind: guide } };
    assert.deepEqual(guideSource(scene), { kind: 'image', asset: map });
    scene.source.kind = 'empty';
    assert.equal(guideSource(scene).kind, 'image');
  }
});

test('Canny defaults to the reference photo and uses 3D only when explicitly selected', () => {
  const reference = { name: 'photo.png' };
  const scene = { source: { kind: 'human' }, reference, conditioning: { model: 'base', guide: 'canny' } };
  assert.deepEqual(guideSource(scene), { kind: 'canny-image', asset: reference });
  scene.conditioning.mapOrigin = 'auto';
  assert.equal(guideSource(scene).kind, 'canny-scene');
  scene.conditioning.map = { name: 'imported-canny.png' }; scene.conditioning.mapKind = 'canny';
  assert.equal(guideSource(scene).kind, 'image');
  scene.conditioning.model = 'anyangle';
  assert.equal(guideSource(scene).kind, 'scene');
});

test('Canny keeps a flat frame black and detects a strong silhouette', () => {
  const width = 40, height = 40;
  const flat = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) flat[i * 4 + 3] = 255;
  assert.equal(cannyEdges(flat, width, height).filter((value, index) => index % 4 === 0 && value).length, 0);
  for (let y = 5; y < 35; y++) for (let x = 10; x < 30; x++) {
    const i = (y * width + x) * 4; flat[i] = flat[i + 1] = flat[i + 2] = 255;
  }
  const edges = cannyEdges(flat, width, height, 30, 90);
  const lit = edges.filter((value, index) => index % 4 === 0 && value).length;
  assert.ok(lit > 20 && lit < 500, `unexpected edge count: ${lit}`);
});

test('default Canny thresholds retain ordinary mid-contrast subject edges', () => {
  const width = 96, height = 96, pixels = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4, value = x >= 24 && x < 72 && y >= 15 && y < 80 ? 175 : 105;
    pixels[i] = pixels[i + 1] = pixels[i + 2] = value; pixels[i + 3] = 255;
  }
  const edges = cannyEdges(pixels, width, height);
  assert.ok(edges.filter((value, index) => index % 4 === 0 && value).length > 100);
});

test('Fisher-compatible colored body skeleton is detected and depth flips are applied', () => {
  const width = 256, height = 256, data = new Uint8ClampedArray(width * height * 4);
  const points = { head: [128, 25], neck: [128, 50], rs: [95, 60], re: [75, 95], rw: [65, 135],
    ls: [161, 60], le: [181, 95], lw: [191, 135], rh: [106, 130], rk: [100, 185], ra: [98, 235],
    lh: [150, 130], lk: [155, 185], la: [160, 235] };
  const paint = (x, y, color) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 4;
    data[i] = parseInt(color.slice(1, 3), 16); data[i + 1] = parseInt(color.slice(3, 5), 16);
    data[i + 2] = parseInt(color.slice(5, 7), 16); data[i + 3] = 255;
  };
  LIMBS.forEach(([a, b], index) => {
    const [x1, y1] = points[ORDER[a]], [x2, y2] = points[ORDER[b]];
    const steps = Math.ceil(Math.hypot(x2 - x1, y2 - y1));
    for (let step = 0; step <= steps; step++) {
      const x = Math.round(x1 + (x2 - x1) * step / steps), y = Math.round(y1 + (y2 - y1) * step / steps);
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) paint(x + dx, y + dy, COLORS[index]);
    }
  });
  ORDER.forEach((name, index) => {
    const [x, y] = points[name];
    for (let dy = -5; dy <= 5; dy++) for (let dx = -5; dx <= 5; dx++) if (dx * dx + dy * dy <= 25) paint(x + dx, y + dy, COLORS[index]);
  });
  const detected = detectSkeleton({ data, width, height });
  assert.equal(detected.length, 1);
  assert.ok(Math.hypot(...detected[0].lw.map((value, i) => value - points.lw[i])) < 8);
  const rest = Object.fromEntries(Object.entries({ ...points, hipMid: [128, 130] }).map(([key, [x, y]]) => [key, [x / 20, -y / 20, 0]]));
  rest.le[2] = .7;
  const first = liftOpenPose(detected[0], rest);
  const flipped = liftOpenPose(detected[0], rest, { lArmUpper: true });
  assert.ok(Math.abs(first.kps.le[2] - first.kps.ls[2]) > .1);
  assert.ok(Math.abs((first.kps.le[2] - first.kps.ls[2]) + (flipped.kps.le[2] - flipped.kps.ls[2])) < 1e-5);
});
