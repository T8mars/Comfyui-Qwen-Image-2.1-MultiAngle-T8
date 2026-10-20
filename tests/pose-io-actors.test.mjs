import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultScene} from '../web/editor/scene.mjs';
import {createActor,bindActor} from '../web/editor/actors.mjs';
import {applyCatalogPose,poseForActor,poseCameraPlan,applyCatalogTransaction,finishCatalogPose} from '../web/editor/pose-catalog.mjs';
import {cameraBatchPlan} from '../web/editor/batch.mjs';
import {guideSource} from '../web/editor/guides.mjs';
const entry={id:'pose-a',name:'抬手',pose:{bones:{head:[12,0,0],upperarm_l:[0,0,90],index_01_l:[10,0,0]}}};
function scene(){const doc=defaultScene();doc.source.kind='human';doc.conditioning.model='base';doc.conditioning.guide='pose';doc.camera.focalLength=85;doc.cameraTarget=[3,4,5];doc.actors=[
 createActor(0,{id:'a',identity:{description:'Alice',inputKey:'ref-1'},mesh:{...doc.mesh,muscle:.8}}),
 createActor(1,{id:'b',locked:true,identity:{description:'Bob',inputKey:'ref-2'}}),
 createActor(2,{id:'c',visible:false}),createActor(3,{id:'d'})];doc.activeActorId='a';doc.selectedActorIds=['a','b','c','d'];bindActor(doc);return doc;}
test('applying a catalog pose retains identity, body, placement, lens and all other people',()=>{
 const doc=scene(),before=structuredClone(doc),next=applyCatalogPose(doc,entry).scene;
 assert.deepEqual(doc,before);for(const key of ['identity','mesh','transform'])assert.deepEqual(next.actors[0][key],before.actors[0][key]);
 for(const key of ['camera','cameraTarget'])assert.deepEqual(next[key],before[key]);assert.deepEqual(next.actors.slice(1),before.actors.slice(1));assert.deepEqual(next.actors[0].pose.bones,entry.pose.bones);
});
test('selected/all apply skip hidden and locked actors without replacing stable IDs',()=>{
 for(const scope of ['selected','all']){const result=applyCatalogPose(scene(),entry,{scope});assert.deepEqual(result.actorIds,['a','d']);assert.deepEqual(result.scene.actors.map(x=>x.id),['a','b','c','d']);}
});
test('body partitions and hand preservation do not leak the previous full-body pose',()=>{
 const old={bones:{head:[9,0,0],index_01_l:[70,0,0],thigh_l:[-20,0,0]}};
 const next=poseForActor(old,entry.pose,{preserveHands:true});assert.deepEqual(next.bones.index_01_l,[70,0,0]);assert.equal(next.bones.thigh_l,undefined);
 const hands=poseForActor(old,entry.pose,{part:'hands'});assert.deepEqual(hands.bones.head,[9,0,0]);assert.deepEqual(hands.bones.index_01_l,[10,0,0]);assert.equal(hands.bones.upperarm_l,undefined);
});
test('all four guide modes follow the edited rig without changing model strategy',()=>{
 for(const [guide,kind]of [['coarse','scene'],['pose','pose'],['depth','depth-scene'],['canny','canny-scene']]){
  const doc=scene();doc.reference={name:'old.png'};Object.assign(doc.conditioning,{guide,map:{name:'old.png'},mapKind:guide,mapOrigin:'import'});
  const next=applyCatalogPose(doc,entry).scene;assert.equal(guideSource(next).kind,kind);assert.equal(next.conditioning.model,'base');
 }
});
test('contact release is explicit and unrelated relationships remain intact',()=>{
 const doc=scene();doc.contacts=[{actors:['a','b']},{actors:['b','d']}];assert.throws(()=>applyCatalogPose(doc,entry),/接触/);
 assert.deepEqual(applyCatalogPose(doc,entry,{releaseContacts:true}).scene.contacts,[{actors:['b','d']}]);
});
test('static reconstructed sources reject posing without mutation',()=>{
 const doc=scene();doc.source.kind='splat';const before=structuredClone(doc);assert.throws(()=>applyCatalogPose(doc,entry),/可编辑人偶/);assert.deepEqual(doc,before);
});
test('three poses by four angles freeze twelve scenes and preserve all actor identities',()=>{
 const doc=scene(),poses=[structuredClone(entry),{...entry,id:'b',name:'侧看',pose:{bones:{head:[0,40,0]}}},{...entry,id:'c',name:'低头',pose:{bones:{head:[20,0,0]}}}];
 const plan=poseCameraPlan(doc,{mode:'angles',angles:'45,-45,90,-90'},poses,{},cameraBatchPlan),before=structuredClone(doc);poses[0].pose.bones.head[0]=999;
 const views=[...plan.views()];assert.equal(plan.count,12);assert.equal(views.length,12);assert.equal(views[0].scene.actors[0].pose.bones.head[0],12);assert.deepEqual(views.map(x=>x.scene.actors[0].id),Array(12).fill('a'));assert.deepEqual(doc,before);
});
test('compositions require explicit role count and preserve identity without adding people',()=>{
 const doc=scene(),template={kind:'composition',slots:[{pose:entry.pose,transform:{x:0,y:0,z:0,yaw:70}},{pose:entry.pose,transform:{x:7,y:0,z:0,yaw:-70}}]};
 assert.throws(()=>applyCatalogPose(doc,template),/2/);const result=applyCatalogPose(doc,template,{scope:'selected'});
 assert.deepEqual(result.actorIds,['a','d']);assert.equal(result.scene.actors.length,4);assert.deepEqual(result.scene.actors.map(x=>x.identity),doc.actors.map(x=>x.identity));assert.equal(result.scene.actors[3].transform.x,7);
});
test('failed asynchronous apply restores scene and history even when recovery also fails',async()=>{
 let doc=scene(),history=['before'],calls=0;const original=structuredClone(doc),failure=new Error('mesh unavailable');
 const context={doc:()=>doc,replace:value=>doc=value,begin:()=>{const old=[...history];history.push('change');return()=>{history=old;}},changed:()=>{throw new Error('must not commit');},studio:()=>({restore:async()=>{calls++;throw failure;},useRigPose(){}})};
 await assert.rejects(applyCatalogTransaction(context,entry),error=>error===failure);assert.equal(calls,2);assert.deepEqual(doc,original);assert.deepEqual(history,['before']);
});

test('pose batch freezes scene, settings and options before the first lazy view',()=>{
 const doc=scene(),settings={mode:'angles',angles:'45,-45'},options={scope:'current',ground:true};
 const plan=poseCameraPlan(doc,settings,[entry],options,cameraBatchPlan);doc.actors[0].identity.description='changed';settings.angles='0';options.scope='all';options.ground=false;
 const views=[...plan.views()];assert.equal(views.length,2);assert.equal(views[0].scene.actors[0].identity.description,'Alice');assert.deepEqual(views[0].preparation.actorIds,['a']);assert.equal(views[0].preparation.options.ground,true);
});

test('batch and direct apply use the same grounding and contact alignment preparation',async()=>{
 const calls=[],studio={doc:{contacts:[{actors:['unrelated-a','unrelated-b']}]},useRigPose(){calls.push('rig');},groundActors(ids){calls.push(ids);},async alignHands(a,sideA,b,sideB){calls.push([a,sideA,b,sideB]);this.doc.contacts=[{actors:[a,b]}];},syncPose(){calls.push('sync');}};
 await finishCatalogPose(studio,{actorIds:['a','d'],align:[{actors:['a','d'],hands:['r','l']}]},{ground:true});
 assert.deepEqual(calls,['rig',['a','d'],['a','r','d','l'],'sync']);assert.equal(studio.doc.contacts.length,2);
});
