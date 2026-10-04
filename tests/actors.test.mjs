import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as THREE from '../web/vendor/three.module.mjs';
import { PoseViewerCore } from '../web/vendor/vnccs_pose_studio_core.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { createActor, ensureActors, bindActor, saveActor, cloneActor, removeActor, moveActor, editableActors, actorSeed, applySceneTemplate } from '../web/editor/actors.mjs';
import { buildManifest, actorMode, actorPrompt, scenePrompt } from '../web/editor/manifest.mjs';
import { promptForSnapshot } from '../web/batch-queue.mjs';
import { poseCopyIssue } from '../web/editor/openpose.mjs';

test('legacy pose, translations, shape and asset transform migrate without losing image output selection', () => {
  const old = { version: 1, source: {kind:'human'}, mesh: { age:50 }, pose: { bones:{head:[3,4,5]}, bonePositions:{pelvis:[1,2,3]}, modelRotation:[0,45,0] }, scale:1.2, front:12, openpose:{useRig:false,rawAsset:{name:'photo.png'}}, poseRandom:{seed:42}, camera:{azimuth:75} };
  const original = structuredClone(old); ensureActors(old);
  assert.equal(old.version, 2); assert.equal(old.actors.length, 1);
  assert.deepEqual(old.actors[0].pose, original.pose); assert.deepEqual(old.actors[0].mesh, original.mesh);
  assert.deepEqual(old.actors[0].transform, {x:0,y:0,z:0,scale:1.2,yaw:12});
  assert.deepEqual(old.openpose, original.openpose); assert.deepEqual(old.camera, original.camera);
  bindActor(old); old.mesh.age = 60; saveActor(old);
  assert.equal(old.actors[0].mesh.age, 60);
});
test('stable role IDs, bindings and seeds survive middle deletion, cloning and layer reordering', () => {
  const doc=defaultScene();doc.source.kind='human';doc.actors=Array.from({length:3},(_,i)=>createActor(i,{id:`p${i}`,identity:{inputKey:`actor_reference_${i+1}`,description:`person${i}`}}));ensureActors(doc);
  const lastSeed=actorSeed(42,'p2');removeActor(doc,'p1');moveActor(doc,'p2',-1);
  assert.equal(doc.actors[0].identity.inputKey,'actor_reference_3'); assert.equal(actorSeed(42,doc.actors[0].id),lastSeed);
  const duplicate=cloneActor(doc,'p2');assert.notEqual(duplicate.id,'p2');assert.equal(duplicate.identity.inputKey,null);assert.equal(duplicate.identity.description,'');
  duplicate.pose.bones.head=[90,0,0];assert.equal(doc.actors[0].pose.bones.head,undefined);
  doc.actors[0].locked=true;doc.selectedActorIds=doc.actors.map(actor=>actor.id);
  assert.ok(editableActors(doc,'all').every(actor=>!actor.locked));assert.equal(editableActors(doc,'selected').length,2);
  const shared=cloneActor(doc,'p2',true);assert.deepEqual(shared.identity,doc.actors[0].identity);
});
test('full scene templates retain identities while person pose and camera are independent', () => {
  const doc=defaultScene();doc.actors=[createActor(0,{id:'A',identity:{asset:{name:'a.png'},description:'Alice'}}),createActor(1,{id:'B',identity:{description:'Bob'}})];
  applySceneTemplate(doc,{actors:[createActor(0,{pose:{bones:{head:[1,2,3]}}}),createActor(1,{transform:{x:10,y:2,z:3,scale:.8,yaw:75}})],camera:{azimuth:90}});
  assert.equal(doc.actors[0].id,'A');assert.equal(doc.actors[0].identity.asset.name,'a.png');assert.equal(doc.actors[1].identity.description,'Bob');assert.equal(doc.actors[1].transform.yaw,75);
});

test('saved scene templates match existing stable IDs after reordering instead of swapping poses and identities', () => {
  const doc=defaultScene();doc.actors=[createActor(0,{id:'Alice',label:'Alice',identity:{description:'blue jacket'}}),createActor(1,{id:'Bob',label:'Bob',identity:{description:'red jacket'}})];
  const template={actors:structuredClone(doc.actors)};template.actors[0].pose.bones.head=[10,0,0];template.actors[1].pose.bones.head=[-15,0,0];
  doc.actors.reverse();applySceneTemplate(doc,template);
  assert.equal(doc.actors[0].id,'Alice');assert.equal(doc.actors[0].identity.description,'blue jacket');assert.deepEqual(doc.actors[0].pose.bones.head,[10,0,0]);
  assert.equal(doc.actors[1].id,'Bob');assert.equal(doc.actors[1].identity.description,'red jacket');assert.deepEqual(doc.actors[1].pose.bones.head,[-15,0,0]);
  template.actors[0].id='new-A';template.actors[1].id='Bob';doc.actors.reverse();applySceneTemplate(doc,template);assert.equal(new Set(doc.actors.map(actor=>actor.id)).size,2);assert.equal(doc.actors[1].id,'Bob');
});

test('full templates restore props and remap contact actor IDs while old templates preserve existing props', () => {
  const doc=defaultScene();doc.actors=[createActor(0,{id:'existing-A'}),createActor(1,{id:'existing-B'})];
  const prop={id:'chair',asset:{name:'chair.glb'},transform:{x:5,y:0,z:0,scale:1,yaw:0}};
  const template={actors:[createActor(0,{id:'source-A'}),createActor(1,{id:'source-B'})],props:[prop],contacts:[{id:'contact-1',actors:['source-A','source-B'],sides:['r','r'],anchor:[0,10,0]}]};
  applySceneTemplate(doc,template);assert.deepEqual(doc.props,[prop]);assert.deepEqual(doc.contacts[0].actors,['existing-A','existing-B']);
  doc.props[0].transform.x=10;assert.equal(template.props[0].transform.x,5);
  removeActor(doc,'existing-A');assert.deepEqual(doc.contacts,[]);
  applySceneTemplate(doc,{actors:template.actors});assert.equal(doc.props[0].transform.x,10);assert.deepEqual(doc.contacts,[]);
});

test('photo picker rejects sparse or coincident retarget candidates without deleting their original skeletons', () => {
  const points={neck:[100,100],ls:[80,100],rs:[120,100],le:[60,150]};assert.equal(poseCopyIssue(points),null);
  assert.match(poseCopyIssue({head:[100,60],rs:[120,100],re:[160,120]}),/缺少/);
  assert.match(poseCopyIssue({...points,ls:[120,100]}),/重合/);
  assert.match(poseCopyIssue({...points,le:[NaN,150]}),/无效/);
  assert.match(poseCopyIssue({...points,le:[80,100]}),/重合/);
  assert.equal(poseCopyIssue(points),null);
});
test('frontend manifest and prompt match the backend contract fixture', () => {
  const scene=JSON.parse(readFileSync(new URL('./fixtures/multiperson-contract.json',import.meta.url)));
  assert.deepEqual(buildManifest(scene),scene.manifest);assert.equal(actorPrompt(scene),scene.resolvedPrompt);
  scene.conditioning.promptMode='single';assert.equal(buildManifest(scene).references.length,0);
  scene.conditioning.promptMode='custom';scene.conditioning.customPrompt='my untouched prompt';assert.equal(actorPrompt(scene),'my untouched prompt');
});
test('shared photos deduplicate, hidden roles disappear and moving layers regenerates real image indices', () => {
  const doc=defaultScene();doc.source.kind='human';doc.conditioning={model:'base',identityMode:'actors',guide:'coarse',colorActors:false};doc.actors=[createActor(0,{id:'A',identity:{asset:{name:'shared.png'},sourcePerson:'left person',description:''}}),createActor(1,{id:'B',identity:{asset:{name:'shared.png'},sourcePerson:'right person',description:''}}),createActor(2,{id:'C',visible:false,identity:{asset:{name:'hidden.png'},description:''}})];
  const m=buildManifest(doc);assert.equal(m.imageCount,2);assert.equal(m.actors.length,2);assert.deepEqual(m.references[0].actorIds,['A','B']);
  assert.ok(!actorPrompt(doc).includes('#64cde1 mannequin'));doc.conditioning.colorActors=true;assert.ok(actorPrompt(doc).includes('#64cde1 mannequin'));
  doc.conditioning.imageOrder='reference-first';assert.equal(buildManifest(doc).guide.index,2);
});

test('photo structure guides do not assign an unrelated retained 3D cast to the image', () => {
  const doc=defaultScene();doc.source.kind='human';doc.reference={name:'group.png'};
  doc.conditioning={model:'base',identityMode:'actors',guide:'pose',imageOrder:'guide-first'};
  doc.actors=Array.from({length:9},(_,i)=>createActor(i,{id:`a${i}`,identity:{asset:{name:`a${i}.png`},description:`character ${i}`}}));
  for(const guide of ['pose','depth','canny']) {
    doc.conditioning.guide=guide;doc.conditioning.map={name:'structure.png'};doc.conditioning.mapKind=guide;
    assert.equal(actorMode(doc),false);const manifest=buildManifest(doc);
    assert.equal(manifest.actors.length,0);assert.deepEqual(manifest.references.map(ref=>ref.asset.name),['group.png']);assert.equal(manifest.imageCount,2);
    doc.conditioning.map=null;doc.conditioning.mapOrigin=guide==='canny'?'auto':'scene';
    assert.equal(actorMode(doc),true);assert.equal(buildManifest(doc).actors.length,9);
  }
  doc.conditioning.mapOrigin='reference';assert.equal(actorMode(doc),false);
  doc.conditioning.promptMode='custom';doc.conditioning.customPrompt='Use my chosen image mapping';
  assert.equal(actorMode(doc),true);assert.equal(actorPrompt(doc),doc.conditioning.customPrompt);
  assert.ok(doc.actors.every(actor=>actor.identity.asset));
});

test('static guides without a shared original have one actual image and a single-guide prompt', () => {
  const doc=defaultScene();doc.source.kind='human';doc.reference=null;
  doc.conditioning={model:'base',identityMode:'actors',imageOrder:'reference-first',promptExtra:'A dancer in blue.'};
  doc.actors=[createActor(0,{identity:{asset:{name:'identity.png'},description:'dancer'}})];
  for(const guide of ['pose','depth','canny']) {
    Object.assign(doc.conditioning,{guide,map:{name:'static.png'},mapKind:guide});
    const manifest=buildManifest(doc);assert.equal(manifest.imageCount,1);assert.equal(manifest.guide.index,1);
    assert.match(scenePrompt(doc),/<image1>/);assert.doesNotMatch(scenePrompt(doc),/<image2>/);
    assert.match(scenePrompt(doc),/A dancer in blue\./);assert.equal(doc.conditioning.promptMode,undefined);
  }
  doc.conditioning.promptMode='custom';doc.conditioning.customPrompt='Keep my <image7> mapping.';
  assert.equal(scenePrompt(doc),doc.conditioning.customPrompt);assert.ok(doc.actors[0].identity.asset);
});

function minimalRig(viewer) {
  if(viewer.skinnedMesh)viewer._cleanupPrevious();
  const geometry=new THREE.BoxGeometry(4,20,2); geometry.translate(0,10,0);
  const n=geometry.attributes.position.count;
  geometry.setAttribute('skinIndex',new THREE.Uint16BufferAttribute(new Uint16Array(n*4),4));const weights=new Float32Array(n*4);for(let i=0;i<n;i++)weights[i*4]=1;
  geometry.setAttribute('skinWeight',new THREE.Float32BufferAttribute(weights,4));
  const mesh=new THREE.SkinnedMesh(geometry,new THREE.MeshBasicMaterial({color:'#ffffff'}));
  const root=new THREE.Bone();root.name='pelvis';mesh.add(root);const bones={pelvis:root};
  for(const [name,pos]of Object.entries({head:[0,18,0],upperarm_l:[3,15,0],lowerarm_l:[4,11,0],hand_l:[4,8,0],upperarm_r:[-3,15,0],lowerarm_r:[-4,11,0],hand_r:[-4,8,0],thigh_l:[1,9,0],calf_l:[1,4,0],foot_l:[1,0,0],thigh_r:[-1,9,0],calf_r:[-1,4,0],foot_r:[-1,0,0]})){const bone=new THREE.Bone();bone.name=name;bone.position.fromArray(pos);bone.userData.parentName='pelvis';root.add(bone);bones[name]=bone;}
  viewer.bones=bones;viewer.boneList=Object.values(bones);viewer.shapedBoneRestPositions=Object.fromEntries(viewer.boneList.map(b=>[b.name,b.position.clone()]));viewer.initialBoneStates={};viewer.skeleton=new THREE.Skeleton(viewer.boneList);mesh.bind(viewer.skeleton);viewer.skinnedMesh=mesh;viewer.scene.add(mesh);viewer.meshCenter=new THREE.Vector3(0,10,0);
}
function stage(count) {
  const studio=Object.create(StudioScene.prototype),doc=defaultScene();doc.source.kind='human';doc.actors=Array.from({length:count},(_,i)=>createActor(i,{id:`p${i}`,pose:{bones:{head:[i*3,0,0]}},transform:{x:(i-(count-1)/2)*7,y:0,z:i%2*4,scale:1+i*.03,yaw:i*5}}));ensureActors(doc);bindActor(doc);
  const viewer=Object.create(PoseViewerCore.prototype);Object.assign(viewer,{THREE,initialized:true,scene:new THREE.Scene(),passiveCharacters:new Map(),jointMarkers:[],modelRotation:{x:0,y:0,z:0},options:{},activeCharacterAppearance:{color:'#fff',transform:{}},camera:new THREE.PerspectiveCamera(38,1.6,.1,1000),captureCamera:new THREE.PerspectiveCamera(30,1,.1,1000),captureFrame:new THREE.Object3D(),orbit:{target:new THREE.Vector3(),update(){viewer.camera.lookAt(this.target);viewer.camera.updateMatrixWorld(true);}},updateMarkers(){},updateIKEffectorPositions(){},requestRender(){},setIKMode(){},transform:{detach(){}},waitForCaptureReady:async()=>{},_applySAMProjectionCaptureCamera:()=>false});
  Object.assign(studio,{doc,viewer,mode:'camera',actorRoots:new Map(),pack:{},grid:new THREE.Object3D(),ring:new THREE.Object3D(),photoFrame:new THREE.Object3D(),shotHelper:{update(){}},cameraClips:[{near:.1,far:1000},{near:.1,far:1000}],callbacks:{}});
  studio.buildHuman=function(pose,actor){minimalRig(viewer);viewer.setPose(pose,true);viewer.setActiveCharacterAppearance({color:actor.editorColor});this.attachActor(actor,viewer.skinnedMesh);};return studio;
}
for(const count of [2,3,6,9])test(`${count} real Three skeletons keep world transforms, selection, bounds and complete POSE output`,async()=>{
  const studio=stage(count);await studio.restore(studio.doc);studio.fit();const camera=studio.viewer.captureCamera.clone(),settings=structuredClone(studio.doc.camera);
  const ids=studio.doc.actors.map(actor=>actor.id);
  for(const id of [...ids].reverse()){await studio.selectActor(id);assert.deepEqual(studio.doc.camera,settings);assert.deepEqual(studio.viewer.captureCamera.projectionMatrix.elements,camera.projectionMatrix.elements);}
  const json=studio.poseJSON();assert.equal(json.people.length,count);
  const neckXs=json.people.map(person=>person.pose_keypoints_2d[3]);assert.equal(new Set(neckXs).size,count);assert.ok(neckXs.every(x=>x>0&&x<studio.doc.width));
  assert.equal(studio.actorRoots.size,count);assert.equal(studio.viewer.passiveCharacters.size,count-1);
  studio.doc.actors[1].visible=false;studio.updateActorTransform(studio.doc.actors[1]);assert.equal(studio.poseJSON().people.length,count-1);
  const target=studio.baseTarget.toArray();studio.doc.activeActorId=ids[0];studio.doc.actors[0].transform.x+=5;studio.updateActorTransform(studio.doc.actors[0]);assert.deepEqual(studio.baseTarget.toArray(),target);
  studio.viewer.clearPassiveCharacters();studio.viewer._cleanupPrevious();
});
test('grounding uses the common displayed stage floor and leaves locked actors and camera unchanged', async()=>{
  const studio=stage(2);await studio.restore(studio.doc);studio.grid.position.y=-7.03;
  const locked=studio.doc.actors[1];locked.locked=true;const original=structuredClone(locked.transform),camera=structuredClone(studio.doc.camera);
  studio.groundActors(studio.doc.actors.map(actor=>actor.id));
  const mesh=studio.actorMesh(studio.doc.actors[0].id);mesh.updateMatrixWorld(true);mesh.skeleton.update();mesh.computeBoundingBox();
  assert.ok(Math.abs(new THREE.Box3().setFromObject(mesh).min.y+7)<1e-6);assert.deepEqual(locked.transform,original);assert.deepEqual(studio.doc.camera,camera);
  studio.viewer.clearPassiveCharacters();studio.viewer._cleanupPrevious();
});

test('frozen batch snapshots use stored role photos rather than regenerate upstream identity inputs',()=>{
  const compiled={output:{1:{class_type:'AnyAngleStudioT8',inputs:{snapshot:'old',reference_image:['2',0],actor_reference_1:['3',0]}}},workflow:{nodes:[{id:1,widgets_values:['old'],inputs:[{name:'actor_reference_1',link:4}]},{id:3,outputs:[{links:[4]}]}],links:[[4,3,0,1,0,'IMAGE']]}};
  const result=promptForSnapshot(compiled,1,{version:1,id:'a'.repeat(64)},{version:2});assert.equal(result.output[1].inputs.actor_reference_1,undefined);assert.equal(result.workflow.links.length,0);assert.deepEqual(compiled.workflow.nodes[1].outputs[0].links,[4]);
});

test('multi-person workflow keeps scene/guide and native conditioning links aligned', () => {
  const workflow=JSON.parse(readFileSync(new URL('../workflows/AnyAngle-Studio-Qwen21-MultiPerson.json',import.meta.url)));
  const nodes=new Map(workflow.nodes.map(node=>[node.id,node]));
  for(const[id,source,output,target,input,type]of workflow.links){const from=nodes.get(source),to=nodes.get(target);assert.equal(to.inputs[input].link,id);assert.ok(from.outputs[output].links.includes(id));assert.equal(to.inputs[input].type,type);}
  const encoder=workflow.nodes.find(node=>node.type==='AnyAngleMultiPersonEncodeT8');
  assert.deepEqual(encoder.inputs.map(input=>input.name),['clip','vae','scene_json','guide_image']);
  const sceneLink=workflow.links.find(link=>link[0]===encoder.inputs[2].link);assert.equal(sceneLink[2],2);
  assert.ok(!workflow.nodes.some(node=>node.type==='LoadImage'),'The text-only identity route runs without placeholder photo assets');
});
