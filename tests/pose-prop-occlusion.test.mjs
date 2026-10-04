import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from '../web/vendor/three.module.mjs';
import { StudioScene, defaultScene } from '../web/editor/scene.mjs';
import { createActor } from '../web/editor/actors.mjs';

function fixture() {
  const studio=Object.create(StudioScene.prototype),doc=defaultScene();
  doc.source.kind='human';doc.actors=[createActor(0,{id:'person'})];doc.activeActorId='person';
  doc.conditioning={poseOcclusion:'visible',poseHands:true};doc.props=[{id:'table',visible:true}];studio.doc=doc;
  const camera=new THREE.PerspectiveCamera(50,1,.1,100);camera.position.set(0,0,10);camera.lookAt(0,0,0);
  const bone=(x,y,z=0)=>{const b=new THREE.Bone();b.position.set(x,y,z);b.updateMatrixWorld(true);return b;};
  const bones={upperarm_r:bone(-1,2),upperarm_l:bone(1,2),hand_r:bone(-2,0),hand_l:bone(2,0),head:bone(0,3)};
  // Own skin encloses the wrist, but must not hide its own joint centers.
  const skin=new THREE.Mesh(new THREE.BoxGeometry(6,6,6),new THREE.MeshBasicMaterial());
  const propRoot=new THREE.Group(),plane=new THREE.Mesh(new THREE.PlaneGeometry(.8,1.4),new THREE.MeshBasicMaterial({side:THREE.DoubleSide}));
  plane.position.set(-1,0,5);propRoot.add(plane);studio.propRoots=new Map([['table',propRoot]]);
  studio.viewer={captureCamera:camera,skinnedMesh:skin,bones,modelLandmarkIndices:null};
  studio.actorBones=()=>bones;studio.actorMesh=()=>skin;studio.configureCapture=()=>{};
  const dispose=()=>{skin.geometry.dispose();skin.material.dispose();plane.geometry.dispose();plane.material.dispose();};
  return{studio,doc,plane,propRoot,dispose};
}

test('visible POSE omits a wrist and hand behind a visible GLB prop, while the unblocked arm remains',()=>{
  const f=fixture();try {
    const person=f.studio.projectPeople(512,512)[0];
    assert.equal(person.positions.rw,undefined);assert.equal(person.hands.r[0],null);
    assert.ok(person.positions.lw);assert.ok(person.hands.l[0]);assert.ok(person.positions.rs);
  } finally {f.dispose();}
});

test('all-joints mode, hidden props and hidden child meshes keep the original pose, excluding own skin',()=>{
  const f=fixture();try {
    for(const change of [()=>{f.doc.conditioning.poseOcclusion='all';},()=>{f.doc.conditioning.poseOcclusion='visible';f.doc.props[0].visible=false;},()=>{f.doc.props[0].visible=true;f.plane.visible=false;},()=>{f.plane.visible=true;f.propRoot.visible=false;}]) {
      change();const person=f.studio.projectPeople(512,512)[0];
      assert.ok(person.positions.rw);assert.ok(person.positions.lw);assert.ok(person.hands.r[0]);
    }
  } finally {f.dispose();}
});

test('a prop behind the joint cannot hide it',()=>{
  const f=fixture();try {
    f.plane.position.set(-2,0,-2);assert.ok(f.studio.projectPeople(512,512)[0].positions.rw);
  } finally {f.dispose();}
});
