// Real editor controls and PNG captures with test-owned local API responses.
import assert from 'node:assert/strict';

export async function guideEditor(browser, origin, { baseline = false } = {}) {
  const results = [];
  const pose = page => page.evaluate(() => structuredClone(window.auditStudio.viewer.getPose()));
  const cases = [
    ['collapsed-materials-replace-delete-undo-and-reopen', async c => {
      await c.reference('flat'); await c.click('#tab-materials'); await c.click('#source-to-library');
      await c.page.locator('.reference-card>summary').click();
      await c.page.locator('.reference-use label').filter({hasText:'用途'}).first().locator('select').selectOption('accessory'); await c.idle();
      await c.page.locator('.reference-card>summary').click();
      assert.equal(await c.page.locator('.reference-card').getAttribute('open'), null);
      assert.equal(await c.page.getByRole('button',{name:'替换图片',exact:true}).isVisible(), true);
      assert.equal(await c.page.getByRole('button',{name:'删除素材',exact:true}).isVisible(), true);
      const original = await c.save(), old = original.scene.referenceLibrary.items[0];
      await c.uploadLibrary('.reference-card-tools button:first-child', 'step');
      const replaced = await c.save(), next = replaced.scene.referenceLibrary.items[0];
      assert.equal(next.asset.name, 'step.png'); assert.equal(next.reviewSource, true);
      for (const key of ['id','label','usages','enabled']) assert.deepEqual(next[key],old[key],key);
      assert.equal(replaced.scene.referenceLibrary.firstReferenceId, original.scene.referenceLibrary.firstReferenceId);
      assert.deepEqual(replaced.scene.reference, original.scene.reference);
      assert.deepEqual(replaced.scene.camera, original.scene.camera); assert.deepEqual(replaced.scene.actors, original.scene.actors);
      await c.click('.reference-card-tools button:last-child'); assert.equal((await c.save()).scene.referenceLibrary.items.length,0);
      await c.click('#undo'); assert.deepEqual((await c.save()).scene.referenceLibrary.items, replaced.scene.referenceLibrary.items);
      await c.click('#undo'); assert.deepEqual((await c.save()).scene.referenceLibrary.items, original.scene.referenceLibrary.items);
      await c.click('#redo'); const saved = await c.save();
      await c.page.goto(`${origin}/tests/gestures.html?snapshot=${c.token().id}`); await c.idle(); await c.click('#tab-materials');
      assert.deepEqual((await c.save()).scene.referenceLibrary.items,saved.scene.referenceLibrary.items);
      for (const width of [320,390,1440]) {
        await c.page.setViewportSize({width,height:900});
        const tools = await c.page.locator('.reference-card-tools').boundingBox(), button = await c.page.locator('.reference-card-tools button:last-child').boundingBox();
        assert.ok(button.x+button.width <= tools.x+tools.width,`${width}px delete button clipped`);
        assert.ok(await c.page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth),`${width}px material overflow`);
      }
    }],
    ['static-pose-custom-prompt-disables-scene-only-controls', async c => {
      await c.importPose(); await c.page.locator('#prompt-mode').selectOption('custom'); await c.idle();
      assert.equal(await c.page.locator('#pose-scene-options').isVisible(),false);
      for(const selector of ['#pose-hands','#pose-occlusion','#export-keypoints','#open-batch']) assert.equal(await c.page.locator(selector).isEnabled(),false,selector);
      assert.equal(await c.page.locator('#pose-static-options-hint').isVisible(),true);
      assert.equal(await c.page.locator('#download-guide').isEnabled(),true);
      assert.equal(await c.page.locator('#mouse-pitch').isVisible(),false);
      await c.page.locator('#retarget-pose').click(); await c.page.locator('#people-dialog').waitFor({state:'visible'});
      await c.page.locator('#people-dialog button[value="current"]').click(); await c.idle();
      for(const selector of ['#pose-hands','#pose-occlusion','#export-keypoints','#open-batch']) assert.equal(await c.page.locator(selector).isEnabled(),true,selector);
    }],
    ['zero-canny-flat-photo', async c => {
      await c.reference('flat'); await c.click('[data-guide="canny"]');
      await c.field('#canny-low', 0); await c.field('#canny-high', 0);
      const capture = await c.save(); const stats = await c.pixels(capture.png);
      assert.equal(stats.white, 0, 'Flat source with zero thresholds must remain an empty guide');
      assert.equal(capture.scene.conditioning.cannyLow, 0); assert.equal(capture.scene.conditioning.cannyHigh, 0);
    }],
    ['zero-canny-step-photo', async c => {
      await c.reference('step'); await c.click('[data-guide="canny"]');
      await c.field('#canny-low', 0); await c.field('#canny-high', 0);
      const capture = await c.save(), stats = await c.pixels(capture.png);
      assert.ok(stats.white > 0 && stats.white < stats.total / 10, 'Edges must not fill constant sides');
    }],
    ['imported-depth-ignores-rig-edits-then-restores', async c => {
      await c.click('[data-guide="depth"]'); await c.importMap('gradient');
      const original = await c.save(); assert.equal(original.scene.conditioning.mapOrigin, 'import');
      await c.field('#actor-x', 13); await c.field('#actor-yaw', 24);
      const moved = await c.save(); assert.equal(moved.png, original.png, 'A static depth map must not move with the rig camera');
      await c.click('#undo'); await c.click('#undo'); assert.equal((await c.save()).png, original.png);
    }],
    ['scene-depth-inversion-keeps-pose-and-camera', async c => {
      await c.click('[data-guide="depth"]'); await c.click('#generate-scene-depth');
      const original = await c.save(), bones = await pose(c.page);
      await c.page.locator('#depth-invert').check(); const inverted = await c.save();
      assert.notEqual(inverted.png, original.png); assert.deepEqual(inverted.scene.camera, original.scene.camera);
      assert.deepEqual(await pose(c.page), bones); await c.click('#undo'); assert.equal((await c.save()).png, original.png);
    }],
    ['scene-guides-share-camera-and-keep-actors', async c => {
      await c.click('#add-actor'); const original = await c.save();
      for (const guide of ['pose', 'depth', 'canny', 'coarse', 'pose']) {
        await c.click(`[data-guide="${guide}"]`);
        if (guide === 'depth') await c.click('#generate-scene-depth');
        if (guide === 'canny') await c.click('#generate-scene-canny');
        const capture = await c.save(); assert.deepEqual(capture.scene.camera, original.scene.camera);
        assert.deepEqual(capture.scene.actors, original.scene.actors); assert.equal(capture.scene.conditioning.guide, guide);
        assert.ok(capture.png.startsWith('data:image/png;base64,'));
      }
    }],
    ['pose-picker-cancel-preserves-cast-and-redo', async c => {
      await c.importPose(); const original = await c.save();
      await c.field('#width', 960); await c.click('#undo');
      assert.ok(await c.page.locator('#redo').isEnabled());
      await c.page.locator('#retarget-pose').click(); await c.page.locator('#people-dialog').waitFor({state:'visible'});
      await c.page.locator('#people-dialog button[value="cancel"]').click(); await c.idle();
      assert.ok(await c.page.locator('#redo').isEnabled());
      assert.deepEqual((await c.save()).scene.actors, original.scene.actors);
    }],
    ['pose-copy-current-preserves-other-person-and-identity', async c => {
      await c.click('#add-actor'); await c.importPose(); const original = await c.save();
      await c.page.locator('#retarget-pose').click(); await c.page.locator('#people-dialog').waitFor({state:'visible'});
      await c.page.locator('#people-match-layout').uncheck(); await c.page.locator('#people-dialog button[value="current"]').click(); await c.idle();
      const copied = await c.save(), active = copied.scene.activeActorId;
      for (const actor of original.scene.actors) {
        const now = copied.scene.actors.find(a => a.id === actor.id);
        assert.deepEqual(now.identity, actor.identity);
        if (actor.id !== active) assert.deepEqual(now, actor);
      }
      assert.equal(copied.scene.conditioning.mapOrigin, 'rig'); assert.deepEqual(copied.scene.camera, original.scene.camera);
      await c.click('#undo'); assert.deepEqual((await c.save()).scene.actors, original.scene.actors);
    }],
    ['custom-prompt-survives-guide-order-and-reopen', async c => {
      await c.page.locator('#prompt-mode').selectOption('custom');
      const custom = '  原文 <image3> / <image1>\nKeep spacing.  ';
      await c.field('#custom-prompt', custom); await c.page.locator('#image-order').selectOption('guide-first');
      await c.click('[data-guide="pose"]'); const saved = await c.save();
      assert.equal(saved.scene.conditioning.customPrompt, custom);
      await c.page.goto(`${origin}/tests/gestures.html?snapshot=${c.token().id}`); await c.idle();
      assert.equal(await c.page.locator('#custom-prompt').inputValue(), custom);
      assert.equal((await c.save()).scene.conditioning.customPrompt, custom);
    }],
    ['fk-click-without-motion-keeps-redo', async c => {
      await c.field('#azimuth-number', 62); await c.click('#undo'); assert.ok(await c.page.locator('#redo').isEnabled());
      await c.click('#view-scene'); await c.click('#edit-mode');
      await c.page.locator('#bone-select').evaluate(el => { el.closest('details').open = true; });
      await c.page.locator('#bone-select').selectOption('upperarm_l'); const before = await pose(c.page);
      const point = await c.page.evaluate(async () => {
        const s = window.auditStudio, t = s.viewer.transform, {Vector2, Raycaster} = await import('/web/vendor/three.module.mjs');
        s.viewer.scene.updateMatrixWorld(true); t.updateMatrixWorld();
        const rect = s.canvas.getBoundingClientRect(), center = t.worldPosition.clone().project(t.camera), ray = new Raycaster();
        const cx = (center.x + 1) * rect.width / 2, cy = (1 - center.y) * rect.height / 2;
        for (let r = 40; r < 140; r += 3) for (let a = 0; a < Math.PI * 2; a += .08) {
          const x = cx + Math.cos(a) * r, y = cy + Math.sin(a) * r;
          if (x < 0 || x >= rect.width || y < 0 || y >= rect.height) continue;
          ray.setFromCamera(new Vector2(x / rect.width * 2 - 1, 1 - y / rect.height * 2), t.camera);
          const hit = ray.intersectObject(t._gizmo.picker.rotate, true).find(hit => hit.object.visible);
          if (hit?.object.name === 'Z') return {x: rect.left + x, y: rect.top + y};
        }
        throw new Error('No native rotation ring');
      });
      await c.page.mouse.move(point.x, point.y); await c.page.mouse.down();
      assert.ok(await c.page.evaluate(() => window.auditStudio.viewer.transform.dragging));
      await c.page.mouse.up(); assert.deepEqual(await pose(c.page), before);
      assert.ok(await c.page.locator('#redo').isEnabled(), 'Selecting a rotation ring without moving must not erase redo');
      await c.click('#redo'); assert.equal(Number(await c.page.locator('#azimuth-number').inputValue()), 62);
    }],
    ['ik-click-without-motion-keeps-redo', async c => {
      await c.field('#azimuth-number', 62); await c.click('#undo'); assert.ok(await c.page.locator('#redo').isEnabled());
      await c.click('#view-scene'); await c.click('#edit-mode'); const before = await pose(c.page);
      const point = await c.page.evaluate(async () => {
        const s = window.auditStudio, {Vector3} = await import('/web/vendor/three.module.mjs'), rect = s.canvas.getBoundingClientRect();
        const hand = s.viewer.bones.hand_l.getWorldPosition(new Vector3()).project(s.viewer.camera);
        return {x: rect.left + (hand.x + 1) * rect.width / 2, y: rect.top + (1 - hand.y) * rect.height / 2};
      });
      await c.page.mouse.move(point.x, point.y); await c.page.mouse.down();
      assert.ok(await c.page.evaluate(() => window.auditStudio.viewer.directDrag.active));
      await c.page.mouse.up(); assert.deepEqual(await pose(c.page), before);
      assert.ok(await c.page.locator('#redo').isEnabled(), 'Selecting an IK hand without moving must not erase redo');
      await c.click('#redo'); assert.equal(Number(await c.page.locator('#azimuth-number').inputValue()), 62);
    }],
  ];
  for (const [name, check] of cases) {
    const page = await browser.newPage({viewport: {width:1660, height:1000}}), errors = [], assets = new Map(), snapshots = new Map();
    let latest, sequence = 0, latestToken, uploadKind = 'flat';
    page.on('pageerror', e => errors.push(e.message));
    const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, {timeout:120000});
    const click = async selector => {await page.locator(selector).click(); await idle();};
    const field = async (selector, value) => {await page.locator(selector).fill(String(value)); await page.locator(selector).blur(); await idle();};
    await page.route('**/anyangle-studio/snapshots', async route => {
      latest = route.request().postDataJSON(); const id = String(++sequence).padStart(64, '0');
      snapshots.set(id, structuredClone(latest)); latestToken = {version:1, id}; await route.fulfill({json: latestToken});
    });
    await page.route('**/anyangle-studio/snapshots/*', route => route.fulfill({json:snapshots.get(new URL(route.request().url()).pathname.split('/').pop())}));
    await page.route(/\/anyangle-studio\/assets(?:\?.*)?$/, route => route.fulfill({json:{name:`${uploadKind}.png`, label:uploadKind, width:64, height:64}}));
    await page.route('**/anyangle-studio/assets/*', route => {
      const buffer = assets.get(new URL(route.request().url()).pathname.split('/').pop());
      return buffer ? route.fulfill({body:buffer, contentType:'image/png'}) : route.continue();
    });
    const paint = async kind => {
      const png = await page.evaluate(kind => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const ctx = canvas.getContext('2d'), image = ctx.createImageData(64,64);
        for(let y=0;y<64;y++)for(let x=0;x<64;x++) {const i=(y*64+x)*4, v=kind==='step'?(x<32?97:220):kind==='gradient'?Math.round(x*255/63):97;
          image.data[i]=image.data[i+1]=image.data[i+2]=v; image.data[i+3]=255;}
        ctx.putImageData(image,0,0); return canvas.toDataURL('image/png');
      }, kind);
      const buffer = Buffer.from(png.split(',')[1],'base64'); assets.set(`${kind}.png`,buffer); return buffer;
    };
    const c = {page, idle, click, field, token:()=>latestToken,
      uploadLibrary: async (selector, kind) => {uploadKind=kind; const buffer=await paint(kind), picker=page.waitForEvent('filechooser');
        await page.locator(selector).click(); await (await picker).setFiles({name:`${kind}.png`,mimeType:'image/png',buffer}); await idle();},
      save: async () => {await click('#apply'); await page.waitForFunction(() => document.querySelector('#status').dataset.state==='saved'); return structuredClone(latest);},
      reference: async kind => {uploadKind=kind; const buffer=await paint(kind); await page.locator('#reference-file').setInputFiles({name:`${kind}.png`,mimeType:'image/png',buffer}); await idle();},
      importMap: async kind => {uploadKind=kind; const buffer=await paint(kind); await page.locator('#map-file').setInputFiles({name:`${kind}.png`,mimeType:'image/png',buffer}); await idle();},
      pixels: png => page.evaluate(async png => {const image=new Image(); image.src=png; await image.decode(); const canvas=document.createElement('canvas'); canvas.width=image.width;canvas.height=image.height;
        const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const pixels=ctx.getImageData(0,0,canvas.width,canvas.height).data;
        let white=0;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>0)white++;return {white,total:canvas.width*canvas.height};},png),
      importPose: async () => {
        const points={head:[32,6],neck:[32,13],rs:[22,15],re:[14,22],rw:[10,12],ls:[42,15],le:[50,22],lw:[54,30],rh:[26,32],rk:[25,45],ra:[24,60],lh:[38,32],lk:[39,45],la:[40,60]};
        await paint('pose'); const asset={name:'pose.png',width:64,height:64};
        await page.route('**/anyangle-studio/pose-people', route=>route.fulfill({json:{asset,points,fullBody:true,visibleOnly:false,people:[{id:'fixture-person',points,fullBody:true,canEstimate3D:true,bbox:[10,6,54,60],canvasWidth:64,canvasHeight:64}]}}));
        await page.locator('#openpose-file').setInputFiles({name:'pose.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({people:[]}))});await idle();
      },
    };
    try {
      await page.goto(`${origin}/tests/gestures.html`); await idle(); await click('#tab-objects'); await click('#add-actor'); await click('#model-base');
      await check(c); assert.deepEqual(errors, []); results.push({name,passed:true});
    } catch(error) {results.push({name,passed:false,error:error.message}); if(!baseline)throw error;}
    finally {await page.close();}
    console.log(JSON.stringify(results.at(-1)));
  }
  return results;
}
