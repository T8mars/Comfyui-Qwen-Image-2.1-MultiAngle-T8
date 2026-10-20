import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function poseStabilityBrowser(browser,origin,editorURL,out){
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[],requests=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.url().includes('/pose-library/'))requests.push({url:r.url(),method:r.method()});});
 await page.addInitScript(()=>{window.qaRaf=0;const original=requestAnimationFrame;window.requestAnimationFrame=callback=>original(time=>{window.qaRaf++;callback(time);});});
 const idle=()=>page.waitForFunction(()=>document.querySelector('#loading').hidden&&!document.querySelector('#workspace').inert,null,{timeout:90000});
 const libraryIdle=()=>page.waitForFunction(()=>document.querySelector('#pose-library-dialog').getAttribute('aria-busy')!=='true');
 const click=async selector=>{await page.locator(selector).click();await idle();};
 const open=async()=>{await page.locator('#open-pose-library').click();await page.locator('#pose-library-dialog').waitFor({state:'visible'});await libraryIdle();};
 const choose=async(name,source='builtin')=>{await page.locator('#pl-source').selectOption(source);await page.locator('#pl-search').fill(name);await page.locator('#pl-grid .pl-card').first().click();await page.waitForFunction(()=>document.querySelector('#pl-preview-hint').hidden,null,{timeout:90000});};
 const snapshot=async()=>{const wait=page.waitForResponse(r=>r.url()===origin+'/anyangle-studio/snapshots'&&r.request().method()==='POST');await click('#apply');const r=await wait;assert.equal(r.status(),200);return r.request().postDataJSON().scene;};
 let ownedId=null;
 try{
  await page.goto(editorURL);await idle();await click('#tab-objects');await click('#human');await click('#model-base');
  await page.locator('#width').fill('640');await page.locator('#width').blur();await idle();await page.locator('#height').fill('384');await page.locator('#height').blur();await idle();await click('#fit-frame');
  const initialCatalog=await(await page.request.get(origin+'/anyangle-studio/pose-library')).json(),initialCount=initialCatalog.items.filter(x=>!x.hidden).length;
  await open();await page.locator('#pl-save').click();await page.locator('#name-input').fill('QA-STABILITY-20261020');await page.locator('#name-dialog button[value="ok"]').click();await libraryIdle();
  await page.waitForFunction(()=>document.querySelector('#pl-name').textContent==='QA-STABILITY-20261020');assert.equal(await page.locator('#pl-total').innerText(),`${initialCount+1} 项`);
  const catalog=await(await page.request.get(origin+'/anyangle-studio/pose-library')).json();ownedId=catalog.items.find(x=>x.name==='QA-STABILITY-20261020').id;
  const writes=requests.filter(r=>r.method==='PATCH').length;
  await page.locator('#pl-favorite').evaluate(button=>{button.click();button.click();});await libraryIdle();assert.equal(requests.filter(r=>r.method==='PATCH').length-writes,1);assert.equal(await page.locator('#pl-favorite').innerText(),'取消收藏');checks.push('rapid_duplicate_write_is_single_and_count_updates');

  let arm=true,release,seen;
  const seenPromise=new Promise(resolve=>seen=resolve),releasePromise=new Promise(resolve=>release=resolve);
  await page.route(origin+'/anyangle-studio/pose-library',async route=>{if(!arm||route.request().method()!=='GET')return route.continue();arm=false;const response=await route.fetch();const body=await response.text();seen();await releasePromise;await route.fulfill({response,body});});
  await page.locator('#pl-reload').click();await seenPromise;await page.locator('#pl-favorite').click();await libraryIdle();release();await page.waitForFunction(()=>document.querySelector('#pl-status').textContent.includes('已读取本地最新'));
  assert.equal(await page.locator('#pl-favorite').innerText(),'收藏');await page.unroute(origin+'/anyangle-studio/pose-library');checks.push('late_catalog_read_does_not_overwrite_newer_write');

  await page.route(origin+'/anyangle-studio/pose-library/items/'+ownedId,route=>route.fulfill({status:503,contentType:'text/html',body:'<h1>Unavailable</h1>'}));
  await page.locator('#pl-favorite').click();await libraryIdle();assert.match(await page.locator('#pl-status').innerText(),/HTTP 503/);assert.equal(await page.locator('#pl-favorite').innerText(),'收藏');await page.unroute(origin+'/anyangle-studio/pose-library/items/'+ownedId);checks.push('non_json_server_error_recovers_controls_without_writing');

  await page.locator('#pl-close').click();
  await page.evaluate(()=>{window.qaStorage=Storage.prototype.getItem;Storage.prototype.getItem=function(key){if(key.startsWith('anyangle-studio.poses'))throw new DOMException('Blocked','SecurityError');return window.qaStorage.call(this,key);};});
  await open();assert.ok(await page.locator('#pl-grid .pl-card').count());await page.evaluate(()=>Storage.prototype.getItem=window.qaStorage);await page.locator('#pl-close').click();checks.push('server_library_works_with_browser_storage_blocked');

  const sceneURL=new URL('./scene.mjs?v=20261020stable1',editorURL).href;
  await page.evaluate(async url=>{const{StudioScene}=await import(url);window.qaRestore=StudioScene.prototype.restore;StudioScene.prototype.restore=async function(...args){if(this.canvas.id==='pl-preview')await new Promise(resolve=>setTimeout(resolve,350));else window.qaMainStudio=this;return window.qaRestore.apply(this,args);};},sceneURL);
  await open();await page.locator('#pl-source').selectOption('builtin');await page.locator('#pl-search').fill('坐姿');await page.locator('#pl-grid .pl-card').first().click();await page.locator('#pl-close').click();await page.waitForTimeout(500);await open();await page.waitForFunction(()=>document.querySelector('#pl-preview-hint').hidden,null,{timeout:90000});checks.push('canceled_preview_reopens_without_stuck_loading');
  await page.locator('#pl-close').click();
  const before=await snapshot();await open();await choose('Seated on Floor','arekejoker');await page.locator('#pl-ground').check();await page.locator('#pl-apply').click();await idle();await libraryIdle();
  const seated=await snapshot();const delta=seated.actors[0].transform.y-before.actors[0].transform.y;assert.ok(Math.abs(delta)>.1,`grounding should move seated actor: ${delta}`);assert.deepEqual(seated.camera,before.camera);
  await click('#undo');assert.deepEqual(await snapshot(),before);checks.push('real_pose_grounding_uses_original_world_floor_and_undo');
  await open();await choose('Seated on Floor','arekejoker');await page.locator('#pl-batch').click();await choose('Standing','arekejoker');await page.locator('#pl-batch').click();await page.locator('#pl-ground').check();await page.locator('#pl-close').click();
  const captures=[],record=request=>{if(request.url()===origin+'/anyangle-studio/snapshots'&&request.method()==='POST')captures.push(request.postDataJSON().scene);};
  await page.locator('#open-batch').click();await page.locator('#batch-pose-mode').selectOption('library');await page.locator('#batch-angles').fill('0,45');page.on('request',record);await page.locator('#batch-guides').click();await page.waitForFunction(()=>document.querySelector('#batch-state').textContent.includes('批量准备完成'),null,{timeout:180000});await idle();page.off('request',record);assert.equal(captures.length,4);assert.ok(Math.abs(captures[0].actors[0].transform.y-seated.actors[0].transform.y)<1e-5);
  await page.locator('#batch-close').click();assert.deepEqual(await snapshot(),before);checks.push('real_pose_camera_batch_honors_grounding_and_restores_draft');

  const memory=()=>page.evaluate(()=>({...window.qaMainStudio.viewer.renderer.info.memory}));
  const memoryBefore=await memory();
  for(let i=0;i<20;i++){await open();await choose(i%2?'自然站立':'坐姿');await page.locator('#pl-ground').uncheck();await page.locator('#pl-apply').click();await idle();await libraryIdle();await click('#undo');}
  const memoryAfter=await memory();assert.ok(memoryAfter.geometries<=memoryBefore.geometries+1);assert.ok(memoryAfter.textures<=memoryBefore.textures+1);
  await page.waitForTimeout(1000);const raf=await page.evaluate(()=>window.qaRaf);await page.waitForTimeout(2000);const idleRaf=(await page.evaluate(()=>window.qaRaf))-raf;assert.ok(idleRaf<10);
  checks.push('twenty_apply_undo_cycles_no_renderer_resource_growth_or_idle_render_loop');
  await open();await choose('双人合影');await page.locator('#pl-batch').click();await page.locator('#pl-close').click();await page.locator('#open-batch').click();assert.equal(await page.locator('#batch-guides').isEnabled(),false);assert.match(await page.locator('#batch-count').innerText(),/2/);await page.locator('#batch-close').click();checks.push('mixed_batch_role_mismatch_is_blocked_before_submission');
  await open();await choose('QA-STABILITY-20261020','local');await page.locator('#pl-delete').click();await libraryIdle();ownedId=null;assert.equal(await page.locator('#pl-total').innerText(),`${initialCount} 项`);await page.locator('#pl-source').selectOption('');await page.locator('#pl-search').fill('');await page.screenshot({path:resolve(out,'stability-final.png')});
  assert.deepEqual(errors,[]);return {checks,errors,memoryBefore,memoryAfter,idleRaf,groundingDelta:delta};
 }catch(error){await page.screenshot({path:resolve(out,'stability-failure.png')});throw error;}finally{
  if(ownedId){const response=await page.request.get(origin+'/anyangle-studio/pose-library');const current=await response.json();await page.request.post(origin+'/anyangle-studio/pose-library/delete',{data:{revision:current.revision,ids:[ownedId]}});}
  await writeFile(resolve(out,'stability-ui-checks.json'),JSON.stringify({checks,errors},null,2));await page.close();
 }
}
