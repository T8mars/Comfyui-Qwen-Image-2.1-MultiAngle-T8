import test from 'node:test';
import assert from 'node:assert/strict';
import { createActor, bindActor, saveActor } from '../web/editor/actors.mjs';
import { emptyLibrary, newUse, addReference, libraryManifest } from '../web/editor/reference-library.mjs';
import { prepareGalleryPose, applyGalleryPose, galleryPoseGuide, addGalleryReference, galleryViewPlan } from '../web/editor/gallery-pose.mjs';
import { runCameraBatch, supportsCameraBatch } from '../web/editor/batch.mjs';
import { galleryKeypointFrame } from '../web/editor/gallery-keypoints.mjs';

const provenance={id:'gallery-test',viewId:'full_single_P001_front',hash:'image.png',source:{id:'test'}};
test('manual keypoints export exact visible body18 joints without inventing legs',()=>{
  const people=[{points:{head:[30,20],neck:[30,40],ls:[50,40],rs:[10,40]}}];
  const frame=galleryKeypointFrame(people,100,200), values=frame.people[0].pose_keypoints_2d;
  assert.equal(values.length,54);assert.deepEqual(values.slice(0,6),[30,20,1,30,40,1]);
  assert.deepEqual(values.slice(24,42),Array(18).fill(0));
  assert.throws(()=>galleryKeypointFrame([{points:{head:[100,20]}}],100,200),/范围/);
});
const person={id:'detected-1',fullBody:false,points:{ls:[60,60],rs:[30,60],neck:[45,60],le:[70,40],lw:[75,20]},bbox:[20,10,80,90],canvasWidth:100};
const detection={people:[person,{...person,id:'detected-2'}],asset:{name:'skeleton.png',width:100,height:100},width:100,height:100};
function scene(){return{version:3,source:{kind:'human'},reference:{name:'original.png'},camera:{azimuth:40,elevation:17,zoom:1.5},cameraTarget:[1,2,3],width:1024,height:768,
  conditioning:{model:'base',guide:'coarse',promptExtra:'keep my text'},referenceLibrary:emptyLibrary(),
  actors:[createActor(0,{id:'a',identity:{asset:{name:'face.png'},inputKey:null,sourcePerson:null,description:''},transform:{x:8,y:2,z:4,scale:1.4,yaw:30}}),createActor(1,{id:'b'})],activeActorId:'a',selectedActorIds:['a'],contacts:[],props:[{id:'chair'}]};}

test('explicit mapping preserves scene source image, body, identity, transform and camera',()=>{
  const before=scene(), input=structuredClone(before);
  const result=prepareGalleryPose(input,detection,['b','a']);
  assert.deepEqual(input,before); assert.deepEqual(result.assignments.map(x=>x.actorId),['b','a']);
  for(const key of ['camera','cameraTarget','reference','props'])assert.deepEqual(result.scene[key],before[key]);
  for(const [i,actor] of result.scene.actors.entries())for(const key of ['mesh','identity','transform','pose'])assert.deepEqual(actor[key],before.actors[i][key]);
});
test('mapping rejects duplicates, locked/hidden actors and unresolved contacts without changing input',()=>{
  const value=scene(), before=structuredClone(value);
  assert.throws(()=>prepareGalleryPose(value,detection,['a','a']),/两套动作/);
  value.actors[1].locked=true;assert.throws(()=>prepareGalleryPose(value,detection,['b','']),/不可编辑/);value.actors[1].locked=false;
  value.actors[1].visible=false;assert.throws(()=>prepareGalleryPose(value,detection,['b','']),/不可编辑/);value.actors[1].visible=true;
  value.contacts=[{actors:['a','b']}];assert.throws(()=>prepareGalleryPose(value,detection,['a','']),/接触/);
  const released=prepareGalleryPose(value,detection,['a',''],{releaseContacts:true});assert.equal(released.scene.contacts.length,0);assert.equal(value.contacts.length,1);
  value.contacts=[];assert.deepEqual(value,before);
});
test('new people are explicit and invalid detection does not create an actor',()=>{
  const value=scene(), added=prepareGalleryPose(value,detection,['new','']);
  assert.equal(added.scene.actors.length,3);assert.equal(value.actors.length,2);
  assert.throws(()=>prepareGalleryPose(value,detection,['','']),/至少/);
  assert.throws(()=>prepareGalleryPose(value,{...detection,people:[{points:{}}]},['new']),/肩/);
  assert.throws(()=>prepareGalleryPose({...value,source:{kind:'splat'}},detection,['new','']),/切换到人偶/);
});
function context(fail=false){let doc=scene(), rolled=0, changed=0, count=0;
  const studio={syncPose(){},async restore(value){this.doc=value;},async selectActor(id){this.doc.activeActorId=id;},applyOpenPose(points,flips,mode){
    assert.equal(mode,'conservative');this.doc.actors.find(x=>x.id===this.doc.activeActorId).pose.bones.lowerarm_l=[1,2,3];if(fail&&++count===2)throw Error('rig failed');}};
  studio.doc=doc;
  return{doc:()=>doc,replace:value=>{doc=value;},studio:()=>studio,begin:()=>()=>rolled++,changed:()=>changed++,ensureHumanTools:async()=>{},result:()=>({doc,rolled,changed})};
}
test('all mapped people apply in conservative mode with one undo transaction',async()=>{
  const c=context(), before=structuredClone(c.doc());await applyGalleryPose(c,detection,['a','b'],provenance);
  assert.equal(c.result().changed,1);assert.equal(c.result().rolled,0);
  assert.equal(c.doc().actors.length,2);assert.equal(c.doc().openpose.origin,'gallery');assert.equal(c.doc().conditioning.mapOrigin,'rig');
  assert.deepEqual(c.doc().camera,before.camera);assert.deepEqual(c.doc().reference,before.reference);
  assert.deepEqual(c.doc().actors[0].identity,before.actors[0].identity);
  assert.deepEqual(c.doc().actors[0].transform,before.actors[0].transform);
});
for (const mode of ['references-only','text']) test(`copying a gallery pose from ${mode} enables the rig guide`,async()=>{
  const c=context();c.doc().referenceLibrary.mode=mode;
  await applyGalleryPose(c,detection,['a',''],provenance);
  assert.equal(c.doc().referenceLibrary.mode,'guided');
  assert.equal(c.doc().conditioning.guide,'pose');
  assert.equal(c.doc().conditioning.mapOrigin,'rig');
  assert.notEqual(libraryManifest(c.doc()).guide,null);
});
test('actor switching and sync do not restore old random-pose metadata after gallery copy',async()=>{
  const c=context(), studio=c.studio(), random={seed:123,category:'standing'};
  c.doc().actors.push(createActor(2,{id:'untouched',poseRandom:random}));
  for(const actor of c.doc().actors)actor.poseRandom={...random};
  bindActor(c.doc());
  studio.syncPose=function(){saveActor(this.doc);};
  studio.restore=async function(value){this.doc=value;bindActor(value);};
  studio.selectActor=async function(id){if(id===this.doc.activeActorId)return;this.syncPose();bindActor(this.doc,id);};
  c.changed=()=>studio.syncPose();
  await applyGalleryPose(c,detection,['a','b'],provenance);
  assert.equal(c.doc().poseRandom,undefined);
  assert.equal(c.doc().actors[0].poseRandom,undefined);assert.equal(c.doc().actors[1].poseRandom,undefined);
  assert.deepEqual(c.doc().actors[2].poseRandom,random);
});
test('failure on the second rig rolls back both people, scene and history',async()=>{
  const c=context(true), before=structuredClone(c.doc());await assert.rejects(applyGalleryPose(c,detection,['a','b'],provenance),/rig failed/);
  assert.deepEqual(c.doc(),before);assert.equal(c.result().rolled,1);assert.equal(c.result().changed,0);assert.deepEqual(c.studio().doc,before);
});
test('static gallery guide keeps image and actors and cannot masquerade as a rotatable camera batch',()=>{
  const before=scene(), result=galleryPoseGuide(before,detection,provenance);
  assert.equal(result.conditioning.map.name,'skeleton.png');assert.equal(result.openpose.useRig,false);assert.equal(result.openpose.origin,'gallery');
  assert.deepEqual(result.actors,before.actors);assert.deepEqual(result.reference,before.reference);assert.deepEqual(result.camera,before.camera);
  assert.equal(supportsCameraBatch(result),false);
});
test('adding the same reference twice is idempotent and does not assume scene v3',()=>{
  const value=scene(), asset={name:'pose.png'};addGalleryReference(value,asset,provenance,{kind:'scene',ids:[],text:''});
  addGalleryReference(value,asset,provenance,{kind:'scene',ids:[],text:''});assert.equal(value.referenceLibrary.items.length,1);assert.equal(value.referenceLibrary.items[0].usages.length,1);
  const old={...scene(),version:2};delete old.referenceLibrary;addGalleryReference(old,asset,provenance,{kind:'scene',ids:[],text:''});assert.equal(old.version,3);assert.equal(old.referenceLibrary.items.at(-1).usages[0].kind,'pose');
});
const rows=[provenance,{...provenance,viewId:'full_single_P001_side',hash:'side.png'}].map((source,i)=>({source,asset:{name:`pose-${i}.png`,label:`view ${i}`}}));
test('view batch freezes references and metadata, changes no camera and restores no imaginary views',()=>{
  const value=scene();addReference(value,{name:'face.png'},{inputKey:'reference1',usages:[newUse('identity',{kind:'actors',ids:['a'],text:''})]});
  const before=structuredClone(value), plan=galleryViewPlan(value,rows,{kind:'actors',ids:['a'],text:''}), views=[...plan.views()];
  value.referenceLibrary.items[0].asset.name='changed.png';rows[0].asset.label='changed';
  assert.equal(plan.count,2);assert.equal(views[0].scene.referenceLibrary.mode,'references-only');assert.equal(views[0].scene.conditioning.promptExtra,'keep my text');
  assert.deepEqual(views[0].scene.camera,before.camera);assert.equal(views[0].scene.referenceLibrary.items[0].asset.name,'face.png');assert.equal(views[0].scene.referenceLibrary.items[0].inputKey,null);
  assert.equal([...plan.views()][0].label,'view 0');assert.notEqual(views[0].scene.referenceLibrary.items.at(-1).asset.name,views[1].scene.referenceLibrary.items.at(-1).asset.name);
  assert.throws(()=>galleryViewPlan(value,[rows[0],rows[0]],{kind:'scene',ids:[]}),/重复/);
});
test('gallery batches keep all references above the recommended image count and retain its warning',()=>{
  const value=scene();
  for(let i=0;i<10;i++)addReference(value,{name:`reference-${i}.png`});
  const [view]=galleryViewPlan(value,[rows[0]],{kind:'scene',ids:[],text:''}).views();
  const manifest=libraryManifest(view.scene);
  assert.equal(manifest.imageCount,11);assert.equal(manifest.references.length,11);
  assert.equal(manifest.warnings.length,1);assert.match(manifest.warnings[0],/完整发送/);
});
test('cancellation keeps completed view receipts including the original file hash',async()=>{
  const abort=new AbortController(), plan=galleryViewPlan(scene(),rows,{kind:'scene',ids:[],text:''});
  const result=await runCameraBatch(plan,{signal:abort.signal,capture:async()=>null,save:async()=>({version:1,id:'test'}),queue:async()=>{abort.abort();return'prompt-1';}});
  assert.equal(result.views.length,1);assert.equal(result.stopped,true);assert.deepEqual(result.views[0].gallerySource,provenance);assert.equal(result.views[0].prompt_id,'prompt-1');
});
