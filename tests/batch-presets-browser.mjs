// Real editor, file pickers, downloads, rendering and iframe requests; local API fixtures only.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function batchPresets(browser, origin, out) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } }), errors = [], snapshots = new Map(), renders = [];
  const key = 'anyangle-studio.camera-batch.v1'; let sequence = 0;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/anyangle-studio/snapshots', route => {
    const body = route.request().postDataJSON(), id = String(++sequence).padStart(64, '0'); snapshots.set(id, body); renders.push(body);
    return route.fulfill({ json: { version: 1, id } });
  });
  await page.route('**/anyangle-studio/snapshots/*', route => route.fulfill({ json: snapshots.get(new URL(route.request().url()).pathname.split('/').pop()) }));
  await page.route('**/anyangle-studio/batches', route => route.fulfill({ json: { id: 'b'.repeat(64) } }));
  const idle = () => page.waitForFunction(() => document.querySelector('#loading').hidden && !document.querySelector('#workspace').inert, { timeout: 120000 });
  const named = async name => {
    await page.locator('#batch-preset-save').click(); await page.locator('#name-input').fill(name);
    await page.locator('#name-dialog button[value="ok"]').click();
    await page.waitForFunction(name => [...document.querySelector('#batch-preset').options].some(option => option.textContent.startsWith(name)), name);
  };
  const stored = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), key);
  const importFile = async (name, data) => {
    const chooser=page.waitForEvent('filechooser'); await page.locator('#batch-preset-import').click();
    await (await chooser).setFiles({name,mimeType:'application/json',buffer:Buffer.from(JSON.stringify(data))});
  };
  const open = async () => { await page.locator('#open-batch').click(); await page.locator('#batch-dialog').waitFor({state:'visible'}); };
  try {
    await page.goto(`${origin}/tests/gestures.html`); await idle(); await page.locator('#tab-objects').click();
    await page.locator('#add-actor').click(); await idle(); await page.locator('#model-base').click(); await idle();
    await page.locator('#azimuth-number').fill('13'); await page.locator('#azimuth-number').blur(); await idle();
    await page.locator('#elevation-number').fill('15'); await page.locator('#elevation-number').blur(); await idle();
    await page.locator('#lens-mode').selectOption('custom'); await page.locator('[data-focal="85"]').click(); await idle();
    const before = await page.evaluate(() => structuredClone(window.auditStudio.doc));
    await open(); assert.equal(await page.locator('#batch-mode').inputValue(), 'angles');
    assert.equal(await page.locator('#batch-angles').inputValue(), '45, -45, 90, -90');
    await named('高斯四向'); assert.deepEqual((await stored()).presets[0].angles, [45,-45,90,-90]);
    await page.locator('#batch-angles').fill('10, -10, 25.5'); await named('细调');
    const exported = page.waitForEvent('download'); await page.locator('#batch-preset-export').click();
    const file = await exported, data = JSON.parse(await readFile(await file.path(), 'utf8'));
    assert.equal(data.kind, 'anyangle-camera-presets'); assert.equal(data.presets.length, 2);
    await page.locator('#batch-preset-delete').click(); assert.equal((await stored()).presets.length, 1);
    await importFile('presets.json',data);
    await page.waitForFunction(() => document.querySelector('#batch-preset').options.length === 4);
    assert.equal((await stored()).presets.length, 3); assert.equal(await page.locator('#batch-angles').inputValue(), '45, -45, 90, -90');
    assert.deepEqual((await stored()).presets.map(preset=>preset.name),['高斯四向','高斯四向 (2)','细调']);
    const prior = await stored();
    await importFile('broken.json',{...data,presets:[data.presets[0],{name:'损坏',angles:[null]}]});
    await page.waitForFunction(() => document.querySelector('#toast').textContent.startsWith('导入失败')); assert.deepEqual(await stored(), prior);
    await page.locator('#batch-angles').fill('45, invalid'); assert.equal(await page.locator('#batch-guides').isEnabled(), false);
    await page.locator('#batch-preset').selectOption('0'); assert.equal(await page.locator('#batch-guides').isEnabled(), true);
    await page.evaluate(() => { window.originalSetItem = Storage.prototype.setItem; Storage.prototype.setItem = () => {throw new DOMException('Storage full', 'QuotaExceededError');}; });
    await page.locator('#batch-preset-delete').click(); assert.deepEqual(await stored(), prior); assert.equal(await page.locator('#batch-preset').inputValue(), '0');
    await page.locator('#batch-preset-save').click();await page.locator('#name-input').fill('无法保存');await page.locator('#name-dialog button[value="ok"]').click();
    await page.waitForFunction(()=>document.querySelector('#toast').textContent.startsWith('未保存预设'));assert.deepEqual(await stored(),prior);
    await page.evaluate(() => { Storage.prototype.setItem = window.originalSetItem; delete window.originalSetItem; });
    const start = renders.length; await page.locator('#batch-guides').click();
    await page.waitForFunction(() => document.querySelector('#batch-state').textContent.includes('粗图 4 张'), null, {timeout:60000}); await idle();
    const rendered = renders.slice(start); assert.deepEqual(rendered.map(item=>item.scene.camera.azimuth),[45,-45,90,-90]);
    assert.equal(new Set(rendered.map(item=>item.png)).size,4,'Four real guides differ');
    for (const item of rendered) {
      assert.deepEqual(item.scene.camera,{...before.camera,azimuth:item.scene.camera.azimuth});
      assert.deepEqual(item.scene.actors,before.actors); assert.equal(item.scene.width,before.width); assert.equal(item.scene.height,before.height);
    }
    assert.deepEqual(await page.evaluate(()=>window.auditStudio.doc.camera), before.camera);
    for (const width of [1440,390,320]) {
      await page.setViewportSize({width,height:1000});
      assert.ok(await page.locator('#batch-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth),`${width}px dialog overflows`);
      for (const id of ['batch-preset-save','batch-preset-delete','batch-preset-import','batch-preset-export']) assert.ok(await page.locator(`#${id}`).isVisible());
      await page.screenshot({path:resolve(out,`batch-presets-${width}.png`)});
    }
    await page.locator('#batch-close').click();
    await page.reload(); await idle(); await page.setViewportSize({width:1440,height:1000});
    await page.locator('#tab-objects').click(); await page.locator('#add-actor').click(); await idle(); await open();
    assert.equal(await page.locator('#batch-angles').inputValue(),'45, -45, 90, -90'); assert.equal(await page.locator('#batch-preset').locator('option').count(),4);
    await page.locator('#batch-mode').selectOption('range'); assert.equal(await page.locator('#batch-range').isVisible(),true); assert.equal(await page.locator('#batch-fixed').isVisible(),false);
    await page.locator('#batch-start').fill('-90'); await page.locator('#batch-end').fill('90'); await page.locator('#batch-step').fill('45');
    await page.locator('#batch-close').click(); await page.reload(); await idle();
    await page.locator('#tab-objects').click(); await page.locator('#add-actor').click(); await idle(); await open();
    assert.equal(await page.locator('#batch-mode').inputValue(),'range'); assert.equal(await page.locator('#batch-start').inputValue(),'-90'); assert.match(await page.locator('#batch-count').textContent(),/^5 个机位/);
    await page.route('**/tests/batch-parent.html',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><head><meta charset="utf-8"></head><body><script>
      window.requests=[];const session='camera-batch-test';
      window.addEventListener('message',event=>{if(event.origin!==location.origin||event.data?.session!==session)return;const message=event.data,reply=payload=>event.source.postMessage({session,...payload},location.origin);
        if(message.type==='anyangle-ready')reply({type:'anyangle-load',snapshot:null,reference:{connected:false},structure:{connected:false},actorReferences:[],initialSettings:{model:'base'}});
        if(message.type==='anyangle-batch-request'){window.requests.push(message);reply({type:'anyangle-batch-reply',requestId:message.requestId,result:message.action==='queue'?{prompt_id:'fixture-'+window.requests.length}:{}});}});
      </script><iframe style="width:100%;height:940px;border:0" src="/tests/gestures.html?session=camera-batch-test"></iframe></body></html>`}));
    await page.goto(`${origin}/tests/batch-parent.html`);await page.locator('iframe').waitFor();
    const child=await (await page.locator('iframe').elementHandle()).contentFrame();
    await child.waitForFunction(()=>document.querySelector('#loading').hidden&&!document.querySelector('#workspace').inert,null,{timeout:120000});
    await child.locator('#tab-objects').click();await child.locator('#add-actor').click();
    await child.waitForFunction(()=>!document.querySelector('#workspace').inert);await child.locator('#open-batch').click();
    await child.locator('#batch-mode').selectOption('angles');await child.locator('#batch-angles').fill('45, -45, 90, -90');
    assert.equal(await child.locator('#batch-final').isEnabled(),true);await child.locator('#batch-final').click();
    await child.waitForFunction(()=>document.querySelector('#batch-state').textContent.includes('已入队 4 个生成任务'),null,{timeout:60000});
    const requests=await page.evaluate(()=>window.requests);
    assert.deepEqual(requests.map(request=>request.action),['prepare','queue','queue','queue','queue']);
    assert.deepEqual(requests.slice(1).map(request=>snapshots.get(request.snapshot.id).scene.camera.azimuth),[45,-45,90,-90]);
    assert.equal(new Set(requests.map(request=>request.requestId)).size,5);assert.deepEqual(errors,[]);
    return {passed:true,angles:[45,-45,90,-90],distinctRenderedGuides:4,queuedViews:4,presetSaveImportExportDelete:true,invalidImportAtomic:true,storageFailureAtomic:true,reopenAndReload:true,rangePreserved:true,widths:[1440,390,320]};
  } finally { await page.close(); }
}
