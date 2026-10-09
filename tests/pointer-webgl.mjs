// Native pointer events against a fresh, test-owned browser and static server.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function pointerWebGL(browser, origin, out, glb) {
  const page = await browser.newPage({ viewport: { width: 1200, height: 840 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  const drag = async (button, dx, dy) => {
    const rect = await page.locator('canvas').boundingBox(), x = rect.x + rect.width / 2, y = rect.y + rect.height / 2;
    await page.mouse.move(x, y); await page.mouse.down({ button });
    await page.mouse.move(x + dx, y + dy, { steps: 4 }); await page.mouse.up({ button });
  };
  try {
    await page.route('**/anyangle-studio/assets/pointer.glb', route => route.fulfill({ body: glb, contentType: 'model/gltf-binary' }));
    await page.goto(`${origin}/tests/webgl.html`); await page.waitForFunction(() => window.ready, { timeout: 120000 });
    const pans = [], guides = [];
    for (const source of ['human', 'glb']) {
      await page.evaluate(async source => {
        window.doc.source = { kind: source, ...(source === 'glb' ? { name: 'pointer.glb' } : {}) };
        await window.studio.restore(window.doc); window.studio.setMode('camera');
      }, source);
      for (const azimuth of [0, 90, 180, -90]) for (const elevation of [0, 40]) for (const axis of ['x', 'y']) {
        const before = await page.evaluate(({ azimuth, elevation, axis }) => {
          const s = window.studio, d = window.doc;
          [d.width, d.height] = axis === 'x' ? [432, 768] : [1365, 768];
          Object.assign(d.camera, { azimuth, elevation, focalLength: elevation ? 85 : 24 }); s.fit();
          Object.assign(d.camera, { offsetX: 0, offsetY: 0, offsetZ: 0 }); s.updateShot(true);
          return s.baseTarget.clone().project(s.viewer.captureCamera).toArray();
        }, { azimuth, elevation, axis });
        await drag('middle', axis === 'x' ? 40 : 0, axis === 'y' ? 40 : 0);
        const after = await page.evaluate(() => window.studio.baseTarget.clone().project(window.studio.viewer.captureCamera).toArray());
        const dx = after[0] - before[0], dy = after[1] - before[1];
        assert.ok(axis === 'x' ? dx > .01 && Math.abs(dy) < 1e-10 : dy < -.01 && Math.abs(dx) < 1e-10,
          JSON.stringify({ source, azimuth, elevation, axis, dx, dy }));
        pans.push({ source, azimuth, elevation, axis, dx, dy });
      }
      const record = await page.evaluate(async source => {
        const s = window.studio, d = window.doc;
        const serialize = () => JSON.stringify({ camera: d.camera, viewport: [s.canvas.width, s.canvas.height],
          position: s.viewer.camera.position.toArray(), projection: s.viewer.camera.projectionMatrix.toArray() });
        const before = serialize(), results = [];
        for (const mode of source === 'human' ? ['coarse', 'pose', 'depth', 'canny'] : ['coarse', 'depth', 'canny']) {
          const png = mode === 'pose' ? s.captureOpenPose() : await s.capture(undefined, undefined, { depth: mode === 'depth', canny: mode === 'canny' });
          const image = new Image(); image.src = png; await image.decode();
          results.push({ mode, decoded: [image.width, image.height], unchanged: before === serialize() });
        }
        return { source, dimensions: [d.width, d.height], results };
      }, source);
      for (const result of record.results) { assert.deepEqual(result.decoded, record.dimensions); assert.ok(result.unchanged); }
      guides.push(record);
    }
    // Moving the edit view and then switching to position must not jump to the shot.
    await page.evaluate(async () => { window.doc.source = { kind: 'human' }; await window.studio.restore(window.doc); window.studio.setMode('edit'); });
    await drag('right', 75, 30);
    const viewBefore = await page.evaluate(() => ({ position: window.studio.viewer.camera.position.toArray(), quaternion: window.studio.viewer.camera.quaternion.toArray() }));
    await page.evaluate(() => window.studio.setMode('position'));
    const positionBefore = await page.evaluate(async () => ({ position: window.studio.viewer.camera.position.toArray(),
      quaternion: window.studio.viewer.camera.quaternion.toArray(), camera: structuredClone(window.doc.camera), png: await window.studio.capture() }));
    assert.deepEqual(positionBefore.position, viewBefore.position); assert.deepEqual(positionBefore.quaternion, viewBefore.quaternion);
    await drag('middle', 50, 15);
    const positionAfter = await page.evaluate(async () => ({ position: window.studio.viewer.camera.position.toArray(),
      quaternion: window.studio.viewer.camera.quaternion.toArray(), camera: structuredClone(window.doc.camera), png: await window.studio.capture() }));
    assert.notDeepEqual(positionAfter.position, positionBefore.position);
    assert.ok(positionAfter.quaternion.every((v, i) => Math.abs(v - positionBefore.quaternion[i]) < 1e-10));
    assert.deepEqual(positionAfter.camera, positionBefore.camera); assert.equal(positionAfter.png, positionBefore.png);
    await page.evaluate(() => window.studio.setMode('edit'));
    const editBefore = await page.evaluate(() => window.studio.viewer.camera.position.toArray()); await drag('middle', 40, 20);
    const editAfter = await page.evaluate(async () => ({ position: window.studio.viewer.camera.position.toArray(), camera: structuredClone(window.doc.camera), png: await window.studio.capture() }));
    assert.notDeepEqual(editAfter.position, editBefore); assert.deepEqual(editAfter.camera, positionBefore.camera); assert.equal(editAfter.png, positionBefore.png);
    const actorStart = await page.evaluate(async () => {
      const s = window.studio, d = window.doc, { Vector3 } = await import('/web/vendor/three.module.mjs');
      Object.assign(d.camera, { azimuth: 0, elevation: 0 }); s.setMode('camera'); s.fit(); s.setMode('position');
      const actor = d.actors.find(actor => actor.id === d.activeActorId), bones = s.actorBones(actor.id);
      const center = bones.pelvis.getWorldPosition(new Vector3()).lerp(bones.head.getWorldPosition(new Vector3()), .5).project(s.viewer.camera);
      const rect = s.canvas.getBoundingClientRect(); window.pointerAudit = { begins: 0, commits: 0, cancellations: 0 };
      s.callbacks.begin = () => { window.pointerAudit.begins++; return () => window.pointerAudit.cancellations++; };
      s.callbacks.change = () => window.pointerAudit.commits++;
      return { x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2,
        transform: structuredClone(actor.transform), camera: structuredClone(d.camera) };
    });
    await page.mouse.click(actorStart.x, actorStart.y);
    assert.deepEqual(await page.evaluate(() => window.pointerAudit), { begins: 0, commits: 0, cancellations: 0 });
    await page.mouse.move(actorStart.x, actorStart.y); await page.mouse.down(); await page.mouse.move(actorStart.x + 30, actorStart.y, { steps: 3 });
    const actorMoved = await page.evaluate(() => structuredClone(window.doc.actors.find(a => a.id === window.doc.activeActorId).transform));
    assert.notDeepEqual(actorMoved, actorStart.transform); await page.evaluate(() => window.studio.cancelDrag()); await page.mouse.up();
    const actorCancelled = await page.evaluate(() => ({ transform: structuredClone(window.doc.actors.find(a => a.id === window.doc.activeActorId).transform),
      camera: structuredClone(window.doc.camera), history: window.pointerAudit }));
    assert.deepEqual(actorCancelled.transform, actorStart.transform); assert.deepEqual(actorCancelled.camera, actorStart.camera);
    assert.deepEqual(actorCancelled.history, { begins: 1, commits: 0, cancellations: 1 });
    await page.mouse.move(actorStart.x, actorStart.y); await page.mouse.down(); await page.mouse.move(actorStart.x + 30, actorStart.y, { steps: 3 }); await page.mouse.up();
    const actorCommitted = await page.evaluate(() => ({ transform: structuredClone(window.doc.actors.find(a => a.id === window.doc.activeActorId).transform),
      camera: structuredClone(window.doc.camera), history: window.pointerAudit }));
    assert.notDeepEqual(actorCommitted.transform, actorStart.transform); assert.deepEqual(actorCommitted.camera, actorStart.camera);
    assert.deepEqual(actorCommitted.history, { begins: 2, commits: 1, cancellations: 1 });
    assert.deepEqual(errors, []);
    return { nativePanCases: pans.length, pans, guides, freeViewTransitionStable: true, positionMiddlePreservesExactGuide: true, editMiddlePreservesExactGuide: true,
      actorClickKeepsHistory: true, actorDragCancelRestoresPosition: true, actorDragCreatesOneUndo: true, actorDragPreservesCamera: true };
  } finally { await page.close(); }
}

export async function pointerEditor(browser, origin, out) {
  const page = await browser.newPage({ viewport: { width: 1660, height: 1000 } });
  const errors = [], saved = []; let latest;
  page.on('pageerror', error => errors.push(error.message));
  const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, { timeout: 120000 });
  const click = async selector => { await page.locator(selector).click(); await idle(); };
  const field = async (selector, value) => { await page.locator(selector).fill(String(value)); await page.locator(selector).blur(); await idle(); };
  const apply = async () => { await click('#apply'); await page.waitForFunction(() => document.querySelector('#status').dataset.state === 'saved'); return structuredClone(latest); };
  const center = async () => { const r = await page.locator('#viewport').boundingBox(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
  try {
    await page.route('**/anyangle-studio/snapshots', async route => {
      latest = route.request().postDataJSON(); saved.push(structuredClone(latest));
      await route.fulfill({ json: { id: String(saved.length).padStart(64, '0'), version: 1 } });
    });
    await page.goto(`${origin}/tests/editor.html`); await idle(); await click('#tab-objects'); await click('#add-actor'); await click('#view-scene');
    await page.locator('#mouse-pitch').uncheck(); await field('#azimuth-number', .1); await field('#azimuth-number', 20); await click('#undo');
    assert.equal(await page.locator('#redo').isEnabled(), true);
    const point = await center(); await page.mouse.click(point.x, point.y);
    assert.equal(await page.locator('#redo').isEnabled(), true, 'No-op click keeps redo available');
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x, point.y + 35, { steps: 3 }); await page.mouse.up();
    assert.equal(Number(await page.locator('#azimuth-number').inputValue()), .1); assert.equal(await page.locator('#redo').isEnabled(), true);
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 50, point.y, { steps: 4 });
    assert.notEqual(Number(await page.locator('#azimuth-number').inputValue()), .1);
    await page.keyboard.press('Escape'); await page.mouse.up();
    assert.equal(Number(await page.locator('#azimuth-number').inputValue()), .1); assert.equal(await page.locator('#redo').isEnabled(), true);
    // Explicit DOM capture release emits a native lostpointercapture event.
    await page.evaluate(() => document.addEventListener('pointerdown', event => { window.testPointerId = event.pointerId; }, { capture: true, once: true }));
    await page.mouse.move(point.x, point.y); await page.mouse.down(); await page.mouse.move(point.x + 30, point.y, { steps: 3 });
    await page.evaluate(() => document.querySelector('#viewport').releasePointerCapture(window.testPointerId));
    await page.mouse.move(point.x + 70, point.y, { steps: 3 }); await page.mouse.up();
    assert.equal(Number(await page.locator('#azimuth-number').inputValue()), .1, 'Lost pointer capture rolls back without subsequent stray movement');
    assert.equal(await page.locator('#redo').isEnabled(), true);
    await click('#redo'); assert.equal(Number(await page.locator('#azimuth-number').inputValue()), 20);
    await field('#azimuth-number', 90); await field('#elevation-number', 40);
    await page.mouse.move(point.x, point.y); await page.mouse.down({ button: 'middle' }); await page.mouse.move(point.x + 40, point.y + 20, { steps: 4 }); await page.mouse.up({ button: 'middle' });
    const panned = await apply(); assert.ok(Math.abs(panned.scene.camera.offsetZ) > .01, 'Side-view pan has a world Z component');
    await click('#save-shot'); await page.locator('#name-input').fill('Screen pan bookmark'); await page.locator('#name-dialog button[value="ok"]').click(); await idle();
    const bookmarked = await apply(); await field('#azimuth-number', -90); await click('.shot-thumb'); const replayed = await apply();
    assert.deepEqual(replayed.scene.camera, bookmarked.scene.camera); assert.equal(replayed.png, bookmarked.png, 'Bookmark replays the exact panned guide');
    await click('#open-batch'); await page.locator('#batch-start').fill('0'); await page.locator('#batch-end').fill('90'); await page.locator('#batch-step').fill('90');
    const countBefore = saved.length; await click('#batch-guides'); assert.equal(saved.length - countBefore, 2);
    const event = page.waitForEvent('download'); await page.locator('#batch-manifest').click(); const download = await event;
    const path = resolve(out, 'pointer-batch-manifest.json'); await download.saveAs(path); const manifest = JSON.parse(await readFile(path, 'utf8'));
    assert.equal(manifest.views.length, 2); assert.deepEqual(manifest.views.map(view => view.camera.azimuth), [0, 90]);
    for (const view of manifest.views) for (const key of ['elevation', 'offsetX', 'offsetY', 'offsetZ']) assert.equal(view.camera[key], replayed.scene.camera[key]);
    await click('#batch-close'); const afterBatch = await apply(); assert.deepEqual(afterBatch.scene.camera, replayed.scene.camera); assert.equal(afterBatch.png, replayed.png);
    await page.screenshot({ path: resolve(out, 'studio-pointer-v154.png') }); assert.deepEqual(errors, []);
    return { clickKeepsRedo: true, fractionalAngleKeepsRedo: true, escapeRestoresRedo: true, nativeLostCaptureRestoresRedo: true, redoWorksAfterCancel: true,
      bookmarkExactPannedGuide: true, batchViews: 2, batchKeepsAllOffsets: true, batchRestoresExactGuide: true };
  } finally { await page.close(); }
}
