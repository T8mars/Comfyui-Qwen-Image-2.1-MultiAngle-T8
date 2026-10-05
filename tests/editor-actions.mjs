// Actual editor DOM with test-owned HTTP fixtures only. No ComfyUI instance is used.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export async function editorActions(page, origin, out, glb) {
  let latest, sequence=0;
  const assets=new Map(),snapshots=new Map();let poseFixture=null;
  await page.route('**/anyangle-studio/snapshots', async route=>{
    latest=route.request().postDataJSON(); sequence++;const id=String(sequence).padStart(64,'0');snapshots.set(id,structuredClone(latest));
    await route.fulfill({json:{id,version:1}});
  });
  await page.route('**/anyangle-studio/snapshots/*',route=>{const id=new URL(route.request().url()).pathname.split('/').pop();return route.fulfill({json:snapshots.get(id)||{},status:snapshots.has(id)?200:404});});
  await page.route('**/anyangle-studio/assets', async route=>{
    const isGLB=route.request().postDataBuffer().includes(Buffer.from('fixture.glb'));
    const isPose=route.request().postDataBuffer().includes(Buffer.from('cast-pose.png'));
    const isBroken=route.request().postDataBuffer().includes(Buffer.from('broken.glb'));
    await route.fulfill({json:isPose?poseFixture:{name:isBroken?'broken.glb':isGLB?'fixture.glb':'fixture-photo.png',width:1024,height:1024,label:'Fixture'}});
  });
  await page.route('**/anyangle-studio/assets/*', async route=>{
    const name=new URL(route.request().url()).pathname.split('/').pop();
    if(name==='broken.glb') return route.fulfill({body:Buffer.from('Invalid GLB body'),contentType:'model/gltf-binary'});
    if(name==='fixture.glb') return route.fulfill({body:glb,contentType:'model/gltf-binary'});
    if(assets.has(name)) return route.fulfill({body:assets.get(name),contentType:'image/png'});
    return route.continue();
  });
  const idle=()=>page.waitForFunction(()=>!document.querySelector('#workspace').inert,{timeout:120000});
  const click=async selector=>{await page.locator(selector).click();await idle();};
  const save=async()=>{const before=sequence;await click('#apply');await page.waitForFunction(()=>document.querySelector('#status').dataset.state==='saved');assert.equal(sequence,before+1);return structuredClone(latest.scene);};
  const field=async(selector,value)=>{await page.locator(selector).fill(String(value));await page.locator(selector).blur();await idle();};
  const openDetails=selector=>page.locator(selector).evaluate(el=>{el.closest('details').open=true;});
  await page.goto(`${origin}/tests/editor.html`);await idle();
  for(let i=0;i<3;i++) await click('#add-actor');
  for(let i=0;i<3;i++){
    await click(`.actor-card:nth-child(${i+1}) .actor-name`);
    await field('#actor-label',`Person ${i+1}`);await field('#actor-description',`identity ${i+1}`);
  }
  await click('.actor-card:first-child .actor-name');
  await openDetails('#cast-layout');
  await field('#actor-x',18); await click('#undo');
  assert.equal(await page.locator('#redo').isEnabled(),true);
  await page.locator('#cast-layout').selectOption('handshake'); await click('#apply-layout');
  assert.equal(await page.locator('#redo').isEnabled(),true,'Failed layouts must preserve redo');
  assert.match(await page.locator('#toast').innerText(),/请选中两位未锁定人物/);
  await page.locator('#glb-file').setInputFiles({name:'broken.glb',mimeType:'model/gltf-binary',buffer:Buffer.from('Invalid GLB body')});await idle();
  assert.equal(await page.locator('#redo').isEnabled(),true,'A GLB loader failure must preserve redo');
  assert.equal(await page.locator('#actor-list .actor-card').count(),3,'Failed import restores the cast');
  await click('#redo');
  assert.equal(Number(await page.locator('#actor-x').inputValue()),18);
  const chooser=page.waitForEvent('filechooser');await page.locator('#add-prop').click();await(await chooser).setFiles({name:'fixture.glb',mimeType:'model/gltf-binary',buffer:glb});await idle();
  const beforeTemplate=await save();assert.equal(beforeTemplate.props.length,1);
  await openDetails('#save-composition');await page.locator('#save-composition').click();await page.locator('#name-input').fill('Complete composition');await page.locator('#name-dialog button[value="ok"]').click();
  await field('#actor-x',31);await field('.prop-card label:first-of-type input',15);
  await click('.actor-card:first-child button[title="图层向后"]');
  const templateId=await page.locator('#composition-list option').last().getAttribute('value');await page.locator('#composition-list').selectOption(templateId);await click('#apply-composition');
  const restored=await save();assert.deepEqual(restored.props,beforeTemplate.props);
  for(const actor of beforeTemplate.actors){const now=restored.actors.find(a=>a.id===actor.id);assert.deepEqual(now.pose,actor.pose);assert.deepEqual(now.transform,actor.transform);assert.equal(now.identity.description,actor.identity.description);}
  assert.deepEqual(restored.cameraTarget,beforeTemplate.cameraTarget);
  // A bookmark must restore framing after a full template changes the target.
  const bookmarkedPNG=latest.png;
  await page.locator('#save-shot').click();await page.locator('#name-input').fill('Original framing');await page.locator('#name-dialog button[value="ok"]').click();await idle();
  const bookmark=await save();assert.deepEqual(bookmark.shots[0].cameraTarget,bookmark.cameraTarget);
  // Test-owned import response supplies a template from a scene with a different origin.
  const importedScene=structuredClone(bookmark),differentTemplate='foreign-target-template',differentTarget=[70,-9,8];
  importedScene.compositionTemplates.push({...structuredClone(importedScene.compositionTemplates[0]),id:differentTemplate,name:'Different center',cameraTarget:differentTarget,camera:{...bookmark.camera,azimuth:70}});
  await page.route('**/anyangle-studio/import-scene',route=>route.fulfill({json:{scene:importedScene}}));
  await page.locator('#scene-file').setInputFiles({name:'fixture-scene.zip',mimeType:'application/zip',buffer:Buffer.from('isolated import response fixture')});await idle();
  await page.locator('#composition-list').selectOption(templateId);await click('#apply-composition');
  await page.locator('#composition-list').selectOption(differentTemplate);await click('#apply-composition');
  const beforeBookmarkReplay=await save();assert.deepEqual(beforeBookmarkReplay.cameraTarget,differentTarget);
  await click('.shot-thumb');const replayed=await save();
  assert.deepEqual(replayed.cameraTarget,bookmark.cameraTarget);assert.deepEqual(replayed.camera,bookmark.camera);
  assert.deepEqual(replayed.actors,beforeBookmarkReplay.actors);assert.equal(latest.png,bookmarkedPNG,'Bookmark restores the exact original guide after a template changes target');
  // Undo replaces the doc without changing card labels; controls must edit new roles.
  await click('#undo');const beforeLock=await save();
  // Same-valued props after history replacement must also rebind their controls.
  await field('.prop-card label:first-of-type input',7);
  const movedProp=await save();assert.equal(movedProp.props[0].transform.x,7);
  await click('.prop-card button:has-text("锁定")');const lockedProp=await save();assert.equal(lockedProp.props[0].locked,true);
  await click('.prop-card button:has-text("解锁")');
  await click('.prop-card button:has-text("隐藏")');const hiddenProp=await save();assert.equal(hiddenProp.props[0].visible,false);
  await click('.prop-card button:has-text("显示")');
  // A locked active role must not prevent randomizing the other roles.
  await click('.actor-card:first-child button[title="锁定人物"]');
  assert.equal(await page.locator('#actor-scale').isEnabled(),false);
  assert.equal(await page.locator('#scale-number').isEnabled(),false);
  assert.equal(await page.locator('#scale').isEnabled(),false);
  assert.equal(await page.locator('#zoom-number').isEnabled(),true,'A role lock must preserve camera editing');
  await page.locator('#random-scope').selectOption('all');await page.locator('#pose-category').selectOption('standing');await field('#pose-seed',123);
  assert.equal(await page.locator('#repeat-pose').isEnabled(),true);await click('#repeat-pose');
  const randomized=await save();assert.deepEqual(randomized.actors[0].pose,beforeLock.actors[0].pose);assert.equal(randomized.actors[0].locked,true,'Lock after undo applies to the current role object');
  assert.ok(randomized.actors.slice(1).every(a=>a.poseRandom.seed===123));assert.equal(await page.locator('#pose-seed').inputValue(),'123');assert.equal(await page.locator('#pose-category').inputValue(),'standing');
  await click('.actor-card:first-child button[title="解锁人物"]');await click('.actor-card:first-child .actor-name');
  await page.locator('.actor-card:nth-child(2) .actor-name').click({modifiers:['Control']});await idle();
  await page.locator('#cast-layout').selectOption('handshake');await click('#apply-layout');
  const handshake=await save();assert.equal(handshake.contacts.length,1);assert.equal(handshake.contacts[0].actors.length,2);assert.ok(handshake.contacts[0].anchor.every(Number.isFinite));
  await click('[data-guide="pose"]');
  const exported=page.waitForEvent('download');await page.locator('#export-keypoints').click();await(await exported).saveAs(resolve(out,'handshake-pose.json'));
  const handshakePose=JSON.parse(await readFile(resolve(out,'handshake-pose.json'),'utf8'));
  const wrists=handshake.contacts[0].actors.map(id=>handshakePose.people.find(p=>p.actor_id===id).pose_keypoints_2d.slice(12,14));
  const handDistance=Math.hypot(wrists[0][0]-wrists[1][0],wrists[0][1]-wrists[1][1]);assert.ok(handDistance<24,`handshake wrist separation ${handDistance}px`);
  // Use an isolated synthetic photo/pose response, including an uncopyable detection.
  assets.set('fixture-photo.png',Buffer.from(latest.png.split(',')[1],'base64'));
  const points={head:[200,90],neck:[200,180],ls:[150,180],le:[110,280],lw:[80,380],rs:[250,180],re:[290,280],rw:[320,380],lh:[170,450],lk:[165,650],la:[160,850],rh:[230,450],rk:[235,650],ra:[240,850]};
  const people=[0,400].map((dx,i)=>({id:`detection-${i}`,points:Object.fromEntries(Object.entries(points).map(([key,[x,y]])=>[key,[x+dx,y]])),bbox:[70+dx,80,330+dx,860],canvasWidth:1024,canvasHeight:1024,fullBody:true,canEstimate3D:true}));
  people.push({id:'occluded',points:{head:[850,90],rs:[900,180],re:[970,300]},bbox:[800,70,1000,350],fullBody:false});
  const posePNG=await page.evaluate(async people=>{
    const {ORDER,LIMBS,COLORS}=await import('/web/editor/openpose.mjs');const canvas=document.createElement('canvas');canvas.width=canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#000';ctx.fillRect(0,0,1024,1024);ctx.lineWidth=8;
    for(const person of people) for(const [i,[a,b]] of LIMBS.entries()){const from=person.points[ORDER[a]],to=person.points[ORDER[b]];if(!from||!to)continue;ctx.strokeStyle=COLORS[i];ctx.beginPath();ctx.moveTo(...from);ctx.lineTo(...to);ctx.stroke();}
    return canvas.toDataURL('image/png');
  },people);assets.set('fixture-pose.png',Buffer.from(posePNG.split(',')[1],'base64'));
  await page.route('**/anyangle-studio/dwpose',route=>route.fulfill({json:{asset:{name:'fixture-pose.png',width:1024,height:1024},points,fullBody:true,people}}));
  await page.locator('#reference-file').setInputFiles({name:'photo.png',mimeType:'image/png',buffer:assets.get('fixture-photo.png')});await idle();
  const beforeCopy=await save();
  await page.locator('#copy-photo-pose').click();await page.locator('#people-dialog').waitFor({state:'visible'});
  assert.equal(await page.locator('#people-choices input:checked').count(),2);assert.equal(await page.locator('#people-choices input:disabled').count(),1);
  await page.locator('#people-dialog button[value="cancel"]').click();await idle();const canceled=await save();assert.deepEqual(canceled.actors,beforeCopy.actors);
  await page.locator('#copy-photo-pose').click();await page.locator('#people-dialog').waitFor({state:'visible'});await page.locator('#people-choices input').nth(1).uncheck();await page.locator('#people-dialog button[value="current"]').click();await idle();
  const single=await save();assert.equal(single.actors.length,3);assert.deepEqual(single.camera,beforeCopy.camera);assert.deepEqual(single.cameraTarget,beforeCopy.cameraTarget);assert.equal(single.actors.find(a=>a.id===single.activeActorId).poseSource.detectionId,'detection-0');
  await page.locator('#copy-photo-pose').click();await page.locator('#people-dialog').waitFor({state:'visible'});await page.locator('#people-bind-photo').check();await page.locator('#people-dialog button[value="all"]').click();await idle();
  const multi=await save();assert.equal(multi.actors.length,5);assert.equal(multi.conditioning.identityMode,'actors');assert.ok(multi.actors.slice(3).every(a=>a.identity.asset.name==='fixture-photo.png'));assert.ok(multi.actors[3].transform.x<multi.actors[4].transform.x);
  await field('#actor-source-person','selected person on the left');const describedRegion=await save();
  assert.deepEqual(describedRegion.actors[3].identity.sourcePerson.bbox,multi.actors[3].identity.sourcePerson.bbox);
  assert.equal(describedRegion.actors[3].identity.sourcePerson.description,'selected person on the left');
  await page.screenshot({path:resolve(out,'studio-photo-copy.png')});
  await click('[data-guide="depth"]');await click('#generate-scene-depth');const depth=await save();assert.equal(depth.conditioning.mapOrigin,'scene');
  await click('[data-guide="canny"]');await click('#generate-scene-canny');const canny=await save();assert.equal(canny.conditioning.mapOrigin,'auto');
  const stats=await page.evaluate(async png=>{const image=new Image();image.src=png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const c=canvas.getContext('2d');c.drawImage(image,0,0);const pixels=c.getImageData(0,0,canvas.width,canvas.height).data;let white=0,black=0;for(let i=0;i<pixels.length;i+=4){if(pixels[i]===255)white++;if(pixels[i]===0)black++;}return{white,black};},latest.png);assert.ok(stats.white>100&&stats.black>1000);
  const savedPNG=latest.png;await page.reload();await idle();const reopened=await save();
  for(const key of ['actors','props','contacts','compositionTemplates','camera','cameraTarget','reference','randomMaster']) assert.deepEqual(reopened[key],canny[key],`reopened ${key}`);
  assert.equal(latest.png,savedPNG,'Reopening keeps the exact saved Canny guide projection');
  await writeFile(resolve(out,'editor-actions-scene.json'),JSON.stringify(multi,null,2));
  await page.goto(`${origin}/tests/editor.html`);await idle();
  const raster=await page.evaluate(async()=>{
    const {multiSkeleton}=await import('/tests/fixtures/fisher-skeleton.mjs');const {image}=multiSkeleton(9);const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').putImageData(new ImageData(image.data,image.width,image.height),0,0);return{png:canvas.toDataURL('image/png'),width:image.width,height:image.height};
  });poseFixture={name:'fixture-cast.png',width:raster.width,height:raster.height,label:'Nine-person Fisher fixture'};assets.set(poseFixture.name,Buffer.from(raster.png.split(',')[1],'base64'));
  await page.locator('#openpose-file').setInputFiles({name:'cast-pose.png',mimeType:'image/png',buffer:assets.get(poseFixture.name)});await idle();
  await page.locator('#retarget-pose').click();await page.locator('#people-dialog').waitFor({state:'visible'});
  await writeFile(resolve(out,'fisher-picker-diagnostics.json'),JSON.stringify({rows:await page.locator('#people-choices').innerText(),checked:await page.locator('#people-choices input:checked').count()},null,2));
  assert.equal(await page.locator('#people-choices input:checked').count(),9);assert.equal(await page.locator('#people-photo').isVisible(),true);assert.equal(await page.locator('#people-bind-photo').isVisible(),false);
  await page.locator('#people-dialog button[value="all"]').click();await idle();const fisher=await save();assert.equal(fisher.actors.length,9);assert.ok(fisher.actors.every(actor=>actor.poseSource.origin==='import'));
  await page.screenshot({path:resolve(out,'studio-fisher-nine.png')});
  return{failedLayoutPreservesRedo:true,failedGLBPreservesRedo:true,lockedScaleControls:true,bookmarkExactGuideAfterTemplate:true,controlsEditCurrentRolesAfterUndo:true,propControlsAfterUndo:true,stableTemplateIdentities:true,templateProps:true,lockedRandomScope:true,masterSeed:123,handshakeAnchor:true,handshakeWristDistancePx:handDistance,photoCancelPreservesRoles:true,photoCurrentPreservesCamera:true,photoDetected:3,copyable:2,photoNewRoles:2,sourcePhotoIdentityBindings:true,editedDescriptionPreservesSourceRegion:true,sceneDepth:true,sceneCanny:stats,reopenedAllSceneData:true,reopenedExactGuide:true,fisherPNGImportedPeople:9,fisherShowsSourceSkeleton:true,fisherDoesNotBindSkeletonAsIdentity:true};
}
