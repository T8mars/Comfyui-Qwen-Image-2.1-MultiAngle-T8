// Actual native rotation rings in fresh test-owned editor pages.
import assert from 'node:assert/strict';
export async function fkProbe(browser, origin, {baseline = false} = {}) {
  const results = [];
  const pose = page => page.evaluate(() => structuredClone(window.auditStudio.viewer.getPose()));
  const dragging = page => page.evaluate(() => !!window.auditStudio.viewer.transform.dragging);
  const samePose = (a, b) => Object.keys(a.bones).every(name => a.bones[name].every((v, i) => Math.abs(v - b.bones[name][i]) < 1e-7));
  async function grab(c) {
    await c.click('#edit-mode');
    await c.page.locator('#bone-select').evaluate(el => { el.closest('details').open = true; });
    await c.page.locator('#bone-select').selectOption('upperarm_l');
    const before = await pose(c.page);
    const point = await c.page.evaluate(async () => {
      const s = window.auditStudio, t = s.viewer.transform, { Vector2, Raycaster } = await import('/web/vendor/three.module.mjs');
      s.viewer.scene.updateMatrixWorld(true); t.updateMatrixWorld();
      const rect = s.canvas.getBoundingClientRect(), center = t.worldPosition.clone().project(t.camera), ray = new Raycaster();
      const cx = (center.x + 1) * rect.width / 2, cy = (1 - center.y) * rect.height / 2;
      for (let radius = 40; radius < 140; radius += 3) for (let a = 0; a < Math.PI * 2; a += .08) {
        const x = cx + Math.cos(a) * radius, y = cy + Math.sin(a) * radius;
        if (x < 0 || x >= rect.width || y < 0 || y >= rect.height) continue;
        ray.setFromCamera(new Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), t.camera);
        const hit = ray.intersectObject(t._gizmo.picker.rotate, true).find(hit => hit.object.visible);
        if (hit && hit.object.name === 'Z') return {x: rect.left + x, y: rect.top + y};
      }
      throw new Error('No visible native Z ring');
    });
    c.point = point; await c.page.mouse.move(point.x, point.y); await c.page.mouse.down();
    assert.ok(await dragging(c.page), 'Native FK ring must enter dragging');
    await c.move(30, -25);
    assert.ok(!samePose(before, await pose(c.page)), 'Native FK must change the real bone quaternion');
    return {before, after: await pose(c.page)};
  }
  const cases = [
    ['fk-release-undo-redo', async c => {
      const {before, after} = await grab(c); await c.page.mouse.up(); assert.equal(await dragging(c.page), false);
      await c.click('#undo'); assert.ok(samePose(before, await pose(c.page)));
      await c.click('#redo'); assert.ok(samePose(after, await pose(c.page)));
    }],
    ['fk-held-undo', async c => {
      const {before} = await grab(c); await c.page.keyboard.press('Control+z'); await c.idle();
      assert.ok(samePose(before, await pose(c.page))); assert.equal(await dragging(c.page), false);
      const restored = await pose(c.page); await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), restored);
    }],
    ['fk-held-role-switch', async c => {
      await c.click('#add-actor'); await grab(c); const id = await c.page.evaluate(() => window.auditStudio.doc.activeActorId);
      await c.page.keyboard.press('Alt+ArrowLeft'); await c.idle();
      assert.notEqual(await c.page.evaluate(() => window.auditStudio.doc.activeActorId), id);
      assert.equal(await dragging(c.page), false); const switched = await pose(c.page);
      await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), switched);
    }],
    ['fk-held-number', async c => {
      const {after} = await grab(c); await c.page.locator('#azimuth-number').focus(); await c.page.keyboard.press('ArrowUp');
      assert.equal(await dragging(c.page), false); const edited = await c.page.locator('#azimuth-number').inputValue();
      await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
      assert.equal(await c.page.locator('#azimuth-number').inputValue(), edited);
    }],
    ['fk-held-toggle', async c => {
      const {after} = await grab(c); await c.page.locator('#mouse-pitch').focus(); await c.page.keyboard.press('Space');
      assert.equal(await dragging(c.page), false); assert.equal(await c.page.locator('#mouse-pitch').isChecked(), false);
      await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
    ['fk-held-bone-switch', async c => {
      const {after} = await grab(c); await c.page.locator('#bone-select').selectOption('upperarm_r');
      assert.equal(await dragging(c.page), false); await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
    ['fk-held-mode-switch', async c => {
      const {after} = await grab(c); await c.page.locator('#camera-mode').focus(); await c.page.keyboard.press('Enter'); await c.idle();
      assert.equal(await dragging(c.page), false); await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
    ['fk-held-lock', async c => {
      const {after} = await grab(c);
      await c.page.locator('.actor-card button[title="锁定人物"]').focus(); await c.page.keyboard.press('Enter'); await c.idle();
      assert.equal(await dragging(c.page), false); await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
    ['fk-lost-pointer-capture', async c => {
      await c.page.evaluate(() => document.querySelector('#viewport').addEventListener('pointerdown', e => { window.fkPointerId = e.pointerId; }, {capture: true, once: true}));
      const {after} = await grab(c); await c.page.evaluate(() => document.querySelector('#viewport').releasePointerCapture(window.fkPointerId));
      await c.move(70, -45); assert.equal(await dragging(c.page), false); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
    ['fk-pointercancel', async c => {
      await c.page.evaluate(() => document.querySelector('#viewport').addEventListener('pointerdown', e => { window.fkPointerId = e.pointerId; }, {capture: true, once: true}));
      const {after} = await grab(c);
      await c.page.evaluate(() => document.querySelector('#viewport').dispatchEvent(new PointerEvent('pointercancel', {pointerId: window.fkPointerId, button: 0, pointerType: 'mouse', bubbles: true})));
      assert.equal(await dragging(c.page), false); await c.move(70, -45); await c.page.mouse.up(); assert.deepEqual(await pose(c.page), after);
    }],
  ];
  for (const [name, check] of cases) {
    const page = await browser.newPage({viewport: {width: 1660, height: 1000}}), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, {timeout: 120000});
    const click = async selector => { await page.locator(selector).click(); await idle(); };
    const c = {page, idle, click, point: null, move: (dx, dy) => page.mouse.move(c.point.x + dx, c.point.y + dy, {steps: 3})};
    try {
      await page.goto(`${origin}/tests/gestures.html`); await idle(); await click('#add-actor'); await click('#view-scene');
      await check(c); assert.deepEqual(errors, []); results.push({name, passed: true});
    } catch (e) { results.push({name, passed: false, error: e.message}); if (!baseline) throw e; }
    finally {await page.close();}
    console.log(JSON.stringify(results.at(-1)));
  }
  return results;
}
