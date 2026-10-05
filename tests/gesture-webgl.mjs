// Native, overlapping gestures against a fresh editor in a test-owned browser.
import assert from 'node:assert/strict';

export async function gestureEditor(browser, origin, { baseline = false } = {}) {
  const results = [];
  const pose = c => c.page.evaluate(() => structuredClone(window.auditStudio.viewer.getPose()));
  const rigActive = c => c.page.evaluate(() => !!window.auditStudio.viewer.directDrag?.active);
  const samePose = (a, b) => Object.keys(a.bones).every(name => a.bones[name].every((value, i) => Math.abs(value - b.bones[name][i]) < 1e-7));
  async function grabHand(c) {
    await c.click('#edit-mode'); const before = await pose(c);
    const point = await c.page.evaluate(async () => {
      const s = window.auditStudio, { Vector3 } = await import('/web/vendor/three.module.mjs');
      const hand = s.viewer.bones.hand_l.getWorldPosition(new Vector3()).project(s.viewer.camera), rect = s.canvas.getBoundingClientRect();
      return { x: rect.left + (hand.x + 1) * rect.width / 2, y: rect.top + (1 - hand.y) * rect.height / 2 };
    });
    await c.down('left', point); assert.ok(await rigActive(c), 'The real hand marker enters native IK dragging');
    await c.move(35, -20); assert.ok(!samePose(await pose(c), before), 'IK must actually change the pose');
    return { before, after: await pose(c) };
  }
  const cases = [
    ['rotate-wheel-move', async c => {
      await c.down(); await c.move(25, 10); await c.page.mouse.wheel(0, -180);
      const zoom = await c.zoom(); await c.move(50, 20); await c.up();
      assert.equal(await c.zoom(), zoom, 'Continuing rotation must preserve wheel zoom');
      await c.click('#undo'); assert.equal(await c.zoom(), c.initial.zoom);
      assert.equal(await c.angle(), c.initial.azimuth);
    }],
    ['pan-wheel-move', async c => {
      await c.down('middle'); await c.move(20, 10); await c.page.mouse.wheel(0, -180);
      const zoom = await c.zoom(); await c.move(40, 20); await c.up('middle');
      assert.equal(await c.zoom(), zoom, 'Continuing pan must preserve wheel zoom');
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
    }],
    ['wheel-first-escape', async c => {
      await c.field('#azimuth-number', 20); await c.click('#undo');
      assert.ok(await c.page.locator('#redo').isEnabled());
      const before = await c.camera(); await c.down(); await c.page.mouse.wheel(0, -180);
      await c.page.keyboard.press('Escape'); await c.up();
      assert.deepEqual(await c.camera(), before, 'Escape must roll back a wheel-started gesture');
      assert.ok(await c.page.locator('#redo').isEnabled(), 'Cancellation must preserve redo');
    }],
    ['undo-during-rotation', async c => {
      await c.down(); await c.move(40, 0); const moved = await c.camera();
      await c.page.keyboard.press('Control+z'); await c.idle();
      assert.deepEqual(await c.camera(), c.initial);
      await c.move(80, 0); await c.up();
      assert.deepEqual(await c.camera(), c.initial, 'A completed undo must not revive the old gesture');
      await c.click('#redo'); assert.deepEqual(await c.camera(), moved);
    }],
    ['role-switch-during-position', async c => {
      await c.click('#add-actor'); await c.click('#position-mode');
      const actor = await c.actorPoint(); await c.down('left', actor); await c.move(25, 0);
      const moved = await c.page.evaluate(id => structuredClone(window.auditStudio.doc.actors.find(a => a.id === id).transform), actor.id);
      await c.page.keyboard.press('Alt+ArrowLeft'); await c.idle(); await c.move(70, 0); await c.up();
      const after = await c.page.evaluate(id => structuredClone(window.auditStudio.doc.actors.find(a => a.id === id).transform), actor.id);
      assert.deepEqual(after, moved, 'Switching roles must finish the previous role gesture');
    }],
    ['delete-during-rotation', async c => {
      await c.click('#add-actor'); await c.down(); await c.move(30, 0);
      await c.page.keyboard.press('Delete'); await c.idle();
      assert.equal(await c.page.locator('.actor-card').count(), 1);
      await c.page.keyboard.press('Escape'); await c.up();
      await c.click('#undo'); assert.equal(await c.page.locator('.actor-card').count(), 2, 'Cancelled stale drag must not erase deletion history');
    }],
    ['toggle-during-rotation', async c => {
      await c.down(); await c.move(40, 0); const moved = await c.camera();
      await c.page.locator('#mouse-pitch').focus(); await c.page.keyboard.press('Space');
      await c.page.locator('#camera-mode').focus(); await c.page.keyboard.press('Escape'); await c.up();
      assert.deepEqual(await c.camera(), moved, 'A toggle finishes rather than cancels the existing gesture');
      assert.equal(await c.page.locator('#mouse-pitch').isChecked(), false);
      await c.click('#undo'); assert.deepEqual(await c.camera(), moved); assert.equal(await c.page.locator('#mouse-pitch').isChecked(), true);
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
    }],
    ['number-during-rotation', async c => {
      await c.down(); await c.move(40, 0); const moved = await c.camera();
      await c.page.locator('#azimuth-number').focus(); await c.page.keyboard.press('ArrowUp');
      await c.page.locator('#camera-mode').focus(); await c.page.keyboard.press('Escape'); await c.up();
      assert.ok((await c.camera()).azimuth > moved.azimuth, 'The numeric edit must survive completion of the previous gesture');
      await c.click('#undo'); assert.deepEqual(await c.camera(), moved);
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
    }],
    ['wheel-then-rotation-undo-redo', async c => {
      await c.down(); await c.page.mouse.wheel(0, -180); await c.move(40, 10); await c.up();
      const after = await c.camera(); assert.ok(after.zoom > c.initial.zoom);
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
      await c.click('#redo'); assert.deepEqual(await c.camera(), after);
    }],
    ['standalone-wheel-undo-redo', async c => {
      await c.page.mouse.move(c.point.x, c.point.y); await c.page.mouse.wheel(0, -180);
      const after = await c.camera(); assert.ok(after.zoom > c.initial.zoom);
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
      await c.click('#redo'); assert.deepEqual(await c.camera(), after);
    }],
    ['position-view-wheel-preserves-shot', async c => {
      await c.click('#position-mode'); const camera = await c.camera();
      const before = await c.page.evaluate(() => window.auditStudio.viewer.camera.position.toArray());
      await c.page.mouse.move(c.point.x, c.point.y); await c.page.mouse.wheel(0, -180);
      assert.deepEqual(await c.camera(), camera);
      assert.notDeepEqual(await c.page.evaluate(() => window.auditStudio.viewer.camera.position.toArray()), before);
    }],
    ['captured-gesture-release-outside', async c => {
      await c.down(); await c.move(30, 0); await c.page.mouse.move(10, 10); await c.up();
      const after = await c.camera(); assert.notDeepEqual(after, c.initial);
      await c.click('#undo'); assert.deepEqual(await c.camera(), c.initial);
      await c.click('#redo'); assert.deepEqual(await c.camera(), after);
    }],
    ['native-ik-release-and-undo', async c => {
      const { before } = await grabHand(c); await c.up(); assert.equal(await rigActive(c), false);
      await c.click('#undo'); assert.ok(samePose(await pose(c), before));
    }],
    ['native-ik-undo-while-held', async c => {
      await grabHand(c); await c.page.keyboard.press('Control+z'); await c.idle();
      const restored = await pose(c); assert.equal(await rigActive(c), false);
      await c.move(70, -40); await c.up(); assert.deepEqual(await pose(c), restored);
    }],
    ['native-ik-role-switch-while-held', async c => {
      await c.click('#add-actor'); await grabHand(c);
      const id = await c.page.evaluate(() => window.auditStudio.doc.activeActorId);
      await c.page.keyboard.press('Alt+ArrowLeft'); await c.idle();
      assert.notEqual(await c.page.evaluate(() => window.auditStudio.doc.activeActorId), id);
      const switched = await pose(c); assert.equal(await rigActive(c), false);
      await c.move(70, -40); await c.up(); assert.deepEqual(await pose(c), switched);
    }],
    ['native-ik-toggle-while-held', async c => {
      const { before, after } = await grabHand(c);
      await c.page.locator('#mouse-pitch').focus(); await c.page.keyboard.press('Space');
      assert.equal(await rigActive(c), false); assert.equal(await c.page.locator('#mouse-pitch').isChecked(), false);
      await c.move(70, -40); await c.up(); assert.deepEqual(await pose(c), after);
      await c.click('#undo'); assert.ok(samePose(await pose(c), after)); assert.equal(await c.page.locator('#mouse-pitch').isChecked(), true);
      await c.click('#undo'); assert.ok(samePose(await pose(c), before));
    }],
    ['native-ik-mode-switch-while-held', async c => {
      const { after } = await grabHand(c);
      await c.page.locator('#camera-mode').focus(); await c.page.keyboard.press('Enter'); await c.idle();
      assert.equal(await rigActive(c), false); await c.move(70, -40); await c.up(); assert.deepEqual(await pose(c), after);
    }],
    ['native-ik-lost-capture', async c => {
      await c.page.evaluate(() => document.querySelector('#viewport').addEventListener('pointerdown', event => { window.auditPointerId = event.pointerId; }, { capture: true, once: true }));
      const { after } = await grabHand(c);
      await c.page.evaluate(() => document.querySelector('#viewport').releasePointerCapture(window.auditPointerId));
      await c.move(70, -40); await c.up(); assert.equal(await rigActive(c), false); assert.deepEqual(await pose(c), after);
    }],
  ];
  for (const [name, check] of cases) {
    const page = await browser.newPage({ viewport: { width: 1660, height: 1000 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, { timeout: 120000 });
    const click = async selector => { await page.locator(selector).click(); await idle(); };
    const field = async (selector, value) => { await page.locator(selector).fill(String(value)); await page.locator(selector).blur(); await idle(); };
    const camera = () => page.evaluate(() => structuredClone(window.auditStudio.doc.camera));
    let point;
    try {
      await page.goto(`${origin}/tests/gestures.html`); await idle(); await click('#add-actor'); await click('#view-scene');
      const rect = await page.locator('#viewport').boundingBox(); point = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
      const initial = await camera();
      const context = { page, idle, click, field, point, initial, camera,
        angle: async () => (await camera()).azimuth, zoom: async () => (await camera()).zoom,
        down: async (button = 'left', at = point) => { point = at; await page.mouse.move(at.x, at.y); await page.mouse.down({ button }); },
        move: (dx, dy) => page.mouse.move(point.x + dx, point.y + dy, { steps: 3 }), up: (button = 'left') => page.mouse.up({ button }),
        actorPoint: () => page.evaluate(async () => {
          const s = window.auditStudio, actor = s.doc.actors.find(a => a.id === s.doc.activeActorId);
          const { Vector3 } = await import('/web/vendor/three.module.mjs'), bones = s.actorBones(actor.id);
          const center = bones.pelvis.getWorldPosition(new Vector3()).lerp(bones.head.getWorldPosition(new Vector3()), .5).project(s.viewer.camera), rect = s.canvas.getBoundingClientRect();
          return { id: actor.id, x: rect.left + (center.x + 1) * rect.width / 2, y: rect.top + (1 - center.y) * rect.height / 2 };
        }) };
      await check(context); assert.deepEqual(errors, []); results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: error.message });
      if (!baseline) throw error;
    } finally { await page.close(); }
    console.log(JSON.stringify(results.at(-1)));
  }
  return results;
}
