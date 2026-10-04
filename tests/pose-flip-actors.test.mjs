import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { activeActor, createActor } from '../web/editor/actors.mjs';
import { defaultScene } from '../web/editor/scene.mjs';

const app=readFileSync(new URL('../web/editor/app.mjs',import.meta.url),'utf8');
function fixture() {
  const doc=defaultScene();doc.source.kind='human';
  const source=(x)=>({points:{head:[x,20],neck:[x,40]},fullBody:true,retargetMode:'estimated',flips:{}});
  doc.openpose=source(100);doc.actors=[createActor(0,{id:'one',poseSource:source(100)}),createActor(1,{id:'two',poseSource:source(600)})];doc.activeActorId='two';
  const button={dataset:{flip:'lArmUpper'}},calls=[],state={doc,activeActor,document:{querySelectorAll:()=>[button]},begin(){},changed(){},studio:{applyOpenPose(...args){calls.push(args);}}};
  const start=app.indexOf("document.querySelectorAll('[data-flip]').forEach(button => {");
  vm.runInNewContext(app.slice(start,app.indexOf("$('#reference-button').onclick",start)),state);
  return{doc,button,calls};
}
test('depth flip uses the selected actor source and never overwrites a neighbour or global group source',()=>{
  const f=fixture(),global=structuredClone(f.doc.openpose),other=structuredClone(f.doc.actors[0]);
  f.button.onclick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],f.doc.actors[1].poseSource.points);
  assert.equal(f.calls[0][1].lArmUpper,true);assert.equal(f.calls[0][2],'estimated');
  assert.deepEqual(f.doc.openpose,global);assert.deepEqual(f.doc.actors[0],other);
  f.button.onclick();assert.equal(f.doc.actors[1].poseSource.flips.lArmUpper,false);
});
test('a locked, cropped, conservative or sourceless actor cannot flip using someone else’s global source',()=>{
  for(const mutate of [f=>f.doc.actors[1].locked=true,f=>f.doc.actors[1].poseSource.fullBody=false,f=>f.doc.actors[1].poseSource.retargetMode='conservative',f=>f.doc.actors[1].poseSource=null]) {
    const f=fixture();mutate(f);const before=structuredClone(f.doc);f.button.onclick();assert.equal(f.calls.length,0);assert.deepEqual(f.doc,before);
  }
});
test('legacy single-person flips retain their global source compatibility',()=>{
  const f=fixture();f.doc.actors=[f.doc.actors[1]];f.doc.actors[0].poseSource=null;
  f.button.onclick();assert.equal(f.calls.length,1);assert.equal(f.calls[0][0],f.doc.openpose.points);assert.equal(f.doc.openpose.flips.lArmUpper,true);
});
