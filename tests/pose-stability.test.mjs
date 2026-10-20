import test from 'node:test';
import assert from 'node:assert/strict';
import {poseForActor,applyCatalogTransaction,poseCameraPlan} from '../web/editor/pose-catalog.mjs';
import {cameraBatchPlan} from '../web/editor/batch.mjs';
import {defaultScene} from '../web/editor/scene.mjs';
import {createActor,bindActor} from '../web/editor/actors.mjs';
import {StudioScene} from '../web/editor/scene.mjs';
import * as THREE from '../web/vendor/three.module.mjs';

test('partial arm poses replace matching translations without retaining stale absolute overrides',()=>{
 const current={bones:{head:[1,0,0]},bonePositions:{upperarm_l:[3,4,5],foot_l:[6,7,8]},positionDeltas:{upperarm_l:[1,0,0],foot_l:[0,1,0]}};
 const next=poseForActor(current,{bones:{upperarm_l:[90,0,0]},positionDeltas:{upperarm_l:[0,2,0]}},{part:'arms'});
 assert.deepEqual(next.positionDeltas,{upperarm_l:[0,2,0],foot_l:[0,1,0]});assert.deepEqual(next.bonePositions,{foot_l:[6,7,8]});
 assert.deepEqual(next.bones.head,[1,0,0]);
});

test('preserving hands retains their current translation while replacing body translations',()=>{
 const current={bones:{index_01_l:[50,0,0]},bonePositions:{hand_l:[1,2,3]},positionDeltas:{hand_l:[.1,0,0],head:[.2,0,0]}};
 const next=poseForActor(current,{bones:{head:[10,0,0],hand_l:[30,0,0]},positionDeltas:{head:[0,.3,0],hand_l:[9,9,9]}},{preserveHands:true});
 assert.deepEqual(next.positionDeltas,{head:[0,.3,0],hand_l:[.1,0,0]});assert.deepEqual(next.bonePositions,{hand_l:[1,2,3]});assert.deepEqual(next.bones.index_01_l,[50,0,0]);
});

test('grounding keeps the previous world floor even when restoring the new pose moves the grid',async()=>{
 let doc=defaultScene();doc.source.kind='human';doc.actors=[createActor(0,{id:'a'})];doc.activeActorId='a';bindActor(doc);
 const studio={grid:{position:{y:3}},useRigPose(){},syncPose(){},async restore(next){this.doc=next;this.grid.position.y=-10;},groundActors(){assert.equal(this.grid.position.y,3);}};
 await applyCatalogTransaction({doc:()=>doc,replace:next=>doc=next,begin(){},studio:()=>studio,changed(){}},{pose:{bones:{head:[20,0,0]}}},{ground:true});
});

test('a mixed pose batch validates every composition before any view can be submitted',()=>{
 const doc=defaultScene();doc.source.kind='human';doc.actors=[createActor(0,{id:'a'})];doc.activeActorId='a';bindActor(doc);
 const pose={pose:{bones:{head:[1,0,0]}}},pair={kind:'composition',slots:[{pose:pose.pose},{pose:pose.pose}]};
 assert.throws(()=>poseCameraPlan(doc,{mode:'angles',angles:'0,45'},[pose,pair],{},cameraBatchPlan),/2/);
});

test('grounding ignores unused body-buffer vertices outside the rendered index',()=>{
 const geometry=new THREE.BufferGeometry();geometry.setAttribute('position',new THREE.Float32BufferAttribute([0,5,0,1,6,0,0,6,1,0,-100,0],3));geometry.setIndex([0,1,2]);
 geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(16),4));geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute([1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0],4));
 const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial()),bone=new THREE.Bone();mesh.add(bone);mesh.bind(new THREE.Skeleton([bone]));
 const scene=new THREE.Scene();scene.add(mesh);const actor={id:'a',transform:{y:0}};
 StudioScene.prototype.groundActors.call({grid:{position:{y:-.03}},viewer:{scene},doc:{actors:[actor],activeActorId:'a'},actorMesh:()=>mesh,updateActorTransform(){}},['a']);
 assert.equal(actor.transform.y,-5);geometry.dispose();mesh.material.dispose();mesh.skeleton.dispose();
});
