// Integration with the real local endpoints and renderer; the runner supplies an isolated browser.
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

export async function poseLibraryBrowser(browser, origin, editorURL, out) {
  const page=await browser.newPage({viewport:{width:1600,height:1100}}),errors=[],checks=[];
  page.on('pageerror',error=>errors.push(error.message));
  const idle=()=>page.waitForFunction(()=>document.querySelector('#loading').hidden&&!document.querySelector('#workspace').inert,null,{timeout:90000});
  const click=async selector=>{await page.locator(selector).click();await idle();};
  const field=async(selector,value)=>{await page.locator(selector).fill(String(value));await page.locator(selector).blur();await idle();};
  const save=async name=>{
    const response=page.waitForResponse(response=>response.url()===origin+'/anyangle-studio/snapshots'&&response.request().method()==='POST');
    await click('#apply');const saved=await response,body=saved.request().postDataJSON();assert.equal(saved.status(),200,await saved.text());
    const token=await saved.json();
    if(name){await writeFile(resolve(out,`${name}.json`),JSON.stringify({token,scene:body.scene},null,2));if(body.png)await writeFile(resolve(out,`${name}.png`),Buffer.from(body.png.split(',')[1],'base64'));}
    return {token,scene:body.scene,png:body.png};
  };
  const library=async()=>{await page.locator('#open-pose-library').click();await page.locator('#pose-library-dialog').waitFor({state:'visible'});};
  const choose=async(name,source='arekejoker')=>{
    await page.locator('#pl-source').selectOption(source);await page.locator('#pl-search').fill(name);await page.locator('#pl-grid .pl-card').first().click();
    await page.waitForFunction(()=>document.querySelector('#pl-preview-hint').hidden,null,{timeout:90000});
  };
  try{
    await page.goto(editorURL);await idle();await click('#tab-objects');await click('#human');await click('#model-base');
    for(let i=0;i<3;i++)await click('#add-actor');
    for(let i=0;i<4;i++){await click(`.actor-card:nth-child(${i+1}) .actor-name`);await field('#actor-label',`QA人物${i+1}`);await field('#actor-description',`QA identity ${i+1}, distinct clothing`);}
    await click('.actor-card:nth-child(2) button[title="锁定人物"]');await click('.actor-card:nth-child(3) button[title="隐藏人物"]');await click('.actor-card:first-child .actor-name');
    await page.locator('#body-panel').evaluate(node=>node.open=true);await field('#body-muscle-number',.8);
    await field('#width',640);await field('#height',384);await page.locator('#lens-mode').selectOption('custom');await field('#focal-length-number',85);await click('#fit-frame');
    const before=await save('before');
    await library();const total=await page.locator('#pl-total').innerText();assert.match(total,/206/);
    await choose('拳击');await page.screenshot({path:resolve(out,'library-desktop.png')});await page.locator('#pl-close').click();
    const canceled=await save();assert.deepEqual(canceled.scene,before.scene);checks.push('preview_cancel_no_scene_change');
    await library();await choose('拳击');await page.locator('#pl-scope').selectOption('all');await page.locator('#pl-apply').click();await idle();
    const after=await save('after');
    for(const i of [0,3]){assert.notDeepEqual(after.scene.actors[i].pose.bones,before.scene.actors[i].pose.bones);for(const key of ['identity','mesh','transform'])assert.deepEqual(after.scene.actors[i][key],before.scene.actors[i][key]);}
    for(const i of [1,2])assert.deepEqual(after.scene.actors[i],before.scene.actors[i]);
    assert.deepEqual(after.scene.camera,before.scene.camera);assert.deepEqual(after.scene.cameraTarget,before.scene.cameraTarget);checks.push('four_people_identity_body_camera_and_locks');
    await click('#undo');const undone=await save();assert.deepEqual(undone.scene,before.scene);await click('#redo');const redone=await save();assert.deepEqual(redone.scene,after.scene);checks.push('single_undo_redo');
    for(const guide of ['coarse','pose','depth','canny']){
      await click(`[data-guide="${guide}"]`);await library();await choose('拳击');await page.locator('#pl-scope').selectOption('current');await page.locator('#pl-apply').click();await idle();
      const result=await save(`guide-${guide}`);assert.equal(result.scene.width,640);assert.equal(result.scene.height,384);assert.deepEqual(result.scene.camera,before.scene.camera);
    }
    checks.push('four_real_guide_outputs');
    await library();await choose('拳击');await page.locator('#pl-scope').selectOption('current');await page.locator('#pl-batch').click();
    await choose('跳跃');await page.locator('#pl-batch').click();await page.locator('#pl-close').click();
    const batchBefore=await save();
    await page.locator('#open-batch').click();await page.locator('#batch-pose-mode').selectOption('library');await page.locator('#batch-mode').selectOption('angles');await page.locator('#batch-angles').fill('45,-45,90,-90');
    assert.match(await page.locator('#batch-count').innerText(),/8 个任务/);await page.screenshot({path:resolve(out,'pose-camera-batch.png')});await page.locator('#batch-close').click();checks.push('explicit_pose_times_camera_count');
    const captures=[],record=request=>{if(request.url()===origin+'/anyangle-studio/snapshots'&&request.method()==='POST')captures.push(request.postDataJSON());};
    page.on('request',record);await page.locator('#open-batch').click();await page.locator('#batch-guides').click();
    await page.waitForFunction(()=>document.querySelector('#batch-state').textContent.includes('批量准备完成'),null,{timeout:180000});await idle();page.off('request',record);
    assert.equal(captures.length,8);assert.equal(new Set(captures.map(x=>createHash('sha256').update(x.png).digest('hex'))).size,8);
    for(const capture of captures)assert.deepEqual(capture.scene.actors.map(x=>x.identity),batchBefore.scene.actors.map(x=>x.identity));
    await page.locator('#batch-close').click();assert.deepEqual((await save()).scene,batchBefore.scene);checks.push('eight_real_pose_camera_captures_and_exact_restore');
    await page.locator('#open-batch').click();await page.locator('#batch-angles').fill(Array.from({length:30},(_,i)=>i*5).join(','));
    const firstCapture=page.waitForResponse(response=>response.url()===origin+'/anyangle-studio/snapshots'&&response.request().method()==='POST');
    await page.locator('#batch-guides').click();await firstCapture;await page.locator('#batch-stop').click();await idle();
    assert.match(await page.locator('#batch-state').innerText(),/已停止/);await page.locator('#batch-close').click();assert.deepEqual((await save()).scene,batchBefore.scene);checks.push('pose_camera_cancel_restores_original_scene');
    await library();await page.locator('#pl-search').fill('');await page.locator('#pl-source').selectOption('builtin');
    await page.locator('#pl-grid .pl-card').filter({hasText:'自然站立'}).click();await page.waitForFunction(()=>document.querySelector('#pl-preview-hint').hidden,null,{timeout:90000});
    await page.locator('#pl-favorite').click();await page.waitForFunction(()=>document.querySelector('#pl-favorite').textContent==='取消收藏');
    const second=await browser.newPage({viewport:{width:1280,height:900}});await second.goto(editorURL);await second.waitForFunction(()=>!document.querySelector('#workspace').inert,null,{timeout:90000});await second.locator('#tab-objects').click();await second.locator('#human').click();await second.waitForFunction(()=>!document.querySelector('#workspace').inert,null,{timeout:90000});await second.locator('#open-pose-library').click();await second.locator('#pl-tab').selectOption('favorites');
    assert.match(await second.locator('#pl-grid').innerText(),/自然站立/);await second.close();checks.push('shared_catalog_across_independent_pages');
    await page.locator('#pl-favorite').click();await page.locator('#pl-close').click();
    // Create, rename, export, delete, restore and finally remove this test-owned entry only.
    await library();await page.locator('#pl-save').click();await page.locator('#name-input').fill('QA-20261019-临时动作');await page.locator('#name-dialog button[value="ok"]').click();
    await page.waitForFunction(()=>document.querySelector('#pl-name').textContent==='QA-20261019-临时动作');
    await page.locator('#pl-rename').click();await page.locator('#name-input').fill('QA-20261019-改名');await page.locator('#name-dialog button[value="ok"]').click();await page.waitForFunction(()=>document.querySelector('#pl-name').textContent==='QA-20261019-改名');
    const download=page.waitForEvent('download');await page.locator('#pl-export-one').click();const packed=await download;await packed.saveAs(resolve(out,'exported-test-pose.zip'));
    await page.locator('#pl-delete').click();await page.getByRole('button',{name:'恢复刚移除的姿势',exact:true}).waitFor();await page.getByRole('button',{name:'恢复刚移除的姿势',exact:true}).click();
    await page.locator('#pl-source').selectOption('local');await page.locator('#pl-search').fill('QA-20261019-改名');await page.locator('#pl-grid .pl-card').first().click();await page.locator('#pl-delete').click();checks.push('save_rename_export_delete_restore');
    await page.locator('#pl-close').click();
    const compositionBefore=await save();await library();await choose('双人握手','builtin');await page.locator('#pl-scope').selectOption('all');await page.locator('#pl-ground').check();await page.locator('#pl-apply').click();await idle();
    const compositionAfter=await save('handshake');assert.equal(compositionAfter.scene.actors.length,4);assert.equal(compositionAfter.scene.contacts.length,1);
    for(let i=0;i<4;i++)for(const key of ['identity','mesh'])assert.deepEqual(compositionAfter.scene.actors[i][key],compositionBefore.scene.actors[i][key]);
    assert.deepEqual(compositionAfter.scene.camera,compositionBefore.scene.camera);assert.deepEqual(compositionAfter.scene.actors[1],compositionBefore.scene.actors[1]);assert.deepEqual(compositionAfter.scene.actors[2],compositionBefore.scene.actors[2]);
    checks.push('real_two_person_handshake_grounding_and_identity');
    await library();await page.locator('#pl-scope').selectOption('all');await page.locator('#pl-save-composition').click();await page.locator('#name-input').fill('QA-20261019-双人编排');await page.locator('#name-dialog button[value="ok"]').click();
    await page.waitForFunction(()=>document.querySelector('#pl-status').textContent.includes('多人编排已保存'));await choose('QA-20261019-双人编排','local');
    const compositionDownload=page.waitForEvent('download');await page.locator('#pl-export-one').click();const compositionZip=await compositionDownload;await compositionZip.saveAs(resolve(out,'exported-composition.zip'));
    const zipChooser=page.waitForEvent('filechooser');await page.locator('#pl-files').click();await(await zipChooser).setFiles(resolve(out,'exported-composition.zip'));await page.locator('#pl-import-summary').waitFor({state:'visible'});assert.match(await page.locator('#pl-import-summary').innerText(),/可导入 1 项，未通过 0 项/);await page.locator('#pl-import-cancel').click();await page.locator('#pl-delete').click();await page.locator('#pl-close').click();
    checks.push('save_export_and_inspect_custom_composition');
    const legacy=JSON.stringify([{name:'QA-20261019-旧姿势',pose:{bones:{head:[20,0,0],upperarm_l:[15,0,45]}}}]);
    await page.evaluate(value=>{localStorage.setItem('anyangle-studio.poses.v1',value);localStorage.removeItem('anyangle-studio.poses.migrated.v1');},legacy);
    await library();await page.locator('#pl-migrate').click();await page.locator('#pl-import-summary').waitFor({state:'visible'});await page.locator('#pl-import-commit').click();await page.waitForFunction(()=>document.querySelector('#pl-status').textContent.includes('已保存 1 项'));
    assert.equal(await page.evaluate(()=>localStorage.getItem('anyangle-studio.poses.v1')),legacy);assert.equal(await page.evaluate(()=>localStorage.getItem('anyangle-studio.poses.migrated.v1')),'yes');
    await choose('QA-20261019-旧姿势','local');await page.locator('#pl-delete').click();await page.locator('#pl-close').click();checks.push('legacy_migration_commits_and_preserves_original_backup');
    // Real JSON file picker -> inspection -> cancellation must not add a library item.
    await library();const chooser=page.waitForEvent('filechooser');await page.locator('#pl-files').click();
    await(await chooser).setFiles([{name:'QA-cancel.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({schema_version:3,bones:{head:[5,0,0]}}))},{name:'QA-malformed.json',mimeType:'application/json',buffer:Buffer.from('{invalid json')}]);
    await page.locator('#pl-import-summary').waitFor({state:'visible'});assert.match(await page.locator('#pl-import-summary').innerText(),/可导入 1 项，未通过 1 项/);await page.locator('#pl-import-cancel').click();checks.push('real_file_picker_inspect_bad_and_valid_items_then_cancel');
    await page.locator('#pl-close').click();
    for(const width of [1440,390,320]){
      await page.setViewportSize({width,height:width<500?1000:1000});await library();await page.locator('#pl-search').fill('');await page.locator('#pl-source').selectOption('');
      const overflow=await page.locator('#pose-library-dialog').evaluate(node=>node.scrollWidth>node.clientWidth+1);assert.equal(overflow,false,`horizontal overflow ${width}`);
      await page.screenshot({path:resolve(out,`library-${width}.png`)});await page.locator('#pl-close').click();
    }
    checks.push('responsive_1440_390_320');assert.deepEqual(errors,[]);
  }finally{
    await writeFile(resolve(out,'browser-checks.json'),JSON.stringify({checks,errors},null,2));await page.close();
  }
  return {checks,errors};
}
