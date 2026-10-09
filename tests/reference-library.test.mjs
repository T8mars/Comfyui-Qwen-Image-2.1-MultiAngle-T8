import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { defaultScene } from '../web/editor/scene.mjs';
import { addReference, newUse, libraryManifest, libraryPrompt, upgradeReferences, updateReferences, sourceChanged, detachTargets, staleGuide } from '../web/editor/reference-library.mjs';
import { createActor } from '../web/editor/actors.mjs';
import { scenePrompt } from '../web/editor/manifest.mjs';
const photo = i => ({ name: String(i).padStart(64,'a')+'.png', width: 111, height: 79 });
function scene() { const doc=defaultScene();doc.conditioning.model='base';return doc; }
test('products and styles do not require actors; sorting and disabling use the exact deduplicated image numbers',()=>{
  const doc=scene();doc.referenceLibrary.mode='references-only';
  const a=addReference(doc,photo(1),{usages:[newUse('accessory'),newUse('style')]});
  const b=addReference(doc,photo(2));addReference(doc,photo(1),{usages:[newUse('scene')]});
  doc.referenceLibrary.firstReferenceId=b.id;
  let manifest=libraryManifest(doc);assert.equal(manifest.imageCount,2);assert.equal(manifest.references[0].asset.name,b.asset.name);assert.equal(manifest.references[1].usages.length,3);
  assert.ok(!libraryPrompt(doc,manifest).includes('0 people'));assert.match(libraryPrompt(doc,manifest),/<image2>: Use only the accessory/);
  b.enabled=false;manifest=libraryManifest(doc);assert.equal(manifest.imageCount,1);assert.equal(manifest.references[0].index,1);assert.equal(a.id,manifest.references[0].referenceIds[0]);
});
test('static maps and guide switches retain the same material library; custom text remains unchanged',()=>{
  const doc=scene();addReference(doc,photo(1));const library=structuredClone(doc.referenceLibrary);
  for(const guide of ['pose','depth','canny','coarse']){
    doc.conditioning.guide=guide;doc.conditioning.map=guide==='coarse'?null:photo(2);doc.conditioning.mapKind=guide;
    assert.deepEqual(doc.referenceLibrary,library);assert.equal(libraryManifest(doc).imageCount,2);
  }
  doc.conditioning.promptMode='custom';doc.conditioning.customPrompt='  raw <image8>\n';assert.equal(libraryPrompt(doc,libraryManifest(doc)),'  raw <image8>\n');
});
test('disconnected batch slots require explicit saved-version use; replacing them preserves the reference ID and marks review',()=>{
  const doc=scene();updateReferences(doc,[{inputKey:'actor_reference_1',asset:photo(1),assets:[photo(1),photo(2)],batchCount:2}]);
  const item=doc.referenceLibrary.items[0],id=item.id;item.batchIndex=1;
  updateReferences(doc,[{inputKey:'actor_reference_1',assets:[photo(3),photo(4)],batchCount:2}]);
  assert.equal(item.id,id);assert.equal(item.asset.name,photo(4).name);assert.equal(item.reviewSource,true);
  updateReferences(doc,[]);assert.equal(libraryManifest(doc).missing.length,1);
  item.inputKey=null;item.missing=false;assert.equal(libraryManifest(doc).missing.length,0);
});
test('multi-target uses are not silently transferred after target deletion',()=>{
  const doc=scene();doc.source.kind='human';doc.actors=[createActor(0,{id:'alice'}),createActor(1,{id:'bob'})];
  addReference(doc,photo(1),{usages:[newUse('identity',{kind:'actors',ids:['alice','bob'],text:''})]});
  detachTargets(doc,'actors','alice');assert.deepEqual(doc.referenceLibrary.items[0].usages[0].target.ids,['bob']);
  detachTargets(doc,'actors','bob');assert.equal(libraryManifest(doc).references.length,0);
});
test('legacy upgrade follows actual static-guide semantics and keeps explicitly shared original photos',()=>{
  const doc=scene();doc.version=2;delete doc.referenceLibrary;doc.source.kind='human';doc.reference=photo(9);
  doc.conditioning.identityMode='actors';doc.conditioning.guide='canny';doc.conditioning.mapOrigin='reference';
  doc.actors=[createActor(0,{identity:{asset:photo(1),inputKey:null,description:'Alice'}})];
  upgradeReferences(doc);assert.equal(doc.referenceLibrary.items.length,1);assert.equal(doc.referenceLibrary.items[0].asset.name,photo(9).name);
});
test('source updates mark derived maps stale while ordinary reference updates do not alter cameras',()=>{
  const doc=scene(),camera=structuredClone(doc.camera);doc.reference=photo(2);doc.conditioning.mapOrigin='da3';
  sourceChanged(doc,photo(1));assert.equal(doc.derivedGuideStale,true);assert.equal(doc.derivedGuideSource,photo(1).name);assert.deepEqual(doc.camera,camera);
  const old=scene();old.version=2;old.reference=photo(2);sourceChanged(old,photo(1));assert.equal(old.derivedGuideStale,undefined);
});
test('a fresh depth extraction cannot make an old photo pose silently valid after a guide switch',()=>{
  const doc=scene();doc.reference=photo(2);doc.openpose={origin:'dwpose',referenceName:photo(1).name};doc.conditioning.guide='pose';
  assert.equal(staleGuide(doc),true);doc.conditioning.guide='coarse';assert.equal(staleGuide(doc),false);
  doc.openpose.useRig=true;doc.conditioning.guide='pose';assert.equal(staleGuide(doc),false);
  doc.openpose.useRig=false;doc.openpose.acceptStoredSource=true;assert.equal(staleGuide(doc),false);
});

test('AnyAngle keeps its trained image pair before enabled multi-purpose references and uses',()=>{
  const doc=scene();doc.conditioning.model='anyangle';doc.conditioning.imageOrder='reference-first';doc.reference=photo(9);
  doc.source.kind='splat';doc.actors=[createActor(0,{id:'alice',label:'woman on the left'}),createActor(1,{id:'bob',visible:false})];
  addReference(doc,photo(1),{usages:[newUse('identity',{kind:'actors',ids:['alice','bob','deleted'],text:''})]});
  addReference(doc,photo(2),{usages:[newUse('clothing'),newUse('style')]});
  const stopped=addReference(doc,photo(3));stopped.enabled=false;
  let manifest=libraryManifest(doc);assert.equal(manifest.imageCount,4);assert.equal(manifest.guide.index,2);
  assert.deepEqual(manifest.references.map(ref=>[ref.asset.name,ref.index,ref.resolution]),[[photo(9).name,1,0],[photo(1).name,3,'reference'],[photo(2).name,4,'reference']]);
  assert.deepEqual(manifest.references[1].actorIds,['alice']);assert.equal(manifest.actors.length,0);
  assert.equal(manifest.excluded[0].id,stopped.id);
  const prompt=scenePrompt(doc,manifest);
  assert.ok(prompt.startsWith('Change the camera angle from <image2> to <image1>.'));
  assert.match(prompt,/<image3>: Use only the face identity.*woman on the left/);
  assert.match(prompt,/<image4>: Use only the clothing design/);assert.match(prompt,/<image4>: Use the visual style/);
  assert.ok(!prompt.includes('0 people'));assert.ok(!prompt.includes('<image5>'));
  delete doc.conditioning.imageOrder;assert.equal(libraryManifest(doc).guide.index,2);
  doc.conditioning.imageOrder='guide-first';manifest=libraryManifest(doc);
  assert.equal(manifest.guide.index,1);assert.deepEqual(manifest.references.map(ref=>ref.index),[2,3,4]);
  assert.ok(scenePrompt(doc,manifest).startsWith('Change the camera angle from <image1> to <image2>.'));
});

test('switching splat models retains descriptive face and clothing targets without inventing rigs',()=>{
  const doc=scene();doc.source.kind='splat';doc.reference=photo(9);
  doc.actors=[createActor(0,{id:'alice',label:'woman on the left'}),createActor(1,{id:'bob',visible:false})];
  const target={kind:'actors',ids:['alice','bob','deleted'],text:''};
  addReference(doc,photo(1),{usages:[newUse('identity',target),newUse('clothing',target)]});
  addReference(doc,photo(2),{usages:[newUse('style')]});
  for(const model of ['base','anyangle','base']){
    doc.conditioning.model=model;let manifest=libraryManifest(doc);
    assert.equal(manifest.imageCount,model==='anyangle'?4:3);
    assert.deepEqual(manifest.actors,[]);
    const face=manifest.references.find(ref=>ref.asset.name===photo(1).name);
    assert.deepEqual(face.actorIds,['alice']);assert.equal(face.usages.length,2);
    assert.match(scenePrompt(doc,manifest),/Use only the face identity.*woman on the left/);
    assert.match(scenePrompt(doc,manifest),/Use only the clothing design.*woman on the left/);
    assert.ok(!scenePrompt(doc,manifest).includes('0 people'));
    doc.source.kind='glb';manifest=libraryManifest(doc);
    assert.ok(!manifest.references.some(ref=>ref.asset.name===photo(1).name));
    assert.ok(manifest.references.some(ref=>ref.asset.name===photo(2).name));
    doc.source.kind='splat';
  }
});

test('AnyAngle deduplicates source uses and keeps custom prompts and missing-source references',()=>{
  const doc=scene();doc.conditioning.model='anyangle';doc.conditioning.imageOrder='reference-first';doc.reference=photo(9);
  addReference(doc,{...photo(9),label:'material copy',width:32},{usages:[newUse('scene')]});addReference(doc,photo(1));
  let manifest=libraryManifest(doc);assert.equal(manifest.imageCount,3);assert.equal(manifest.references[0].usages.length,1);
  assert.deepEqual(manifest.references[0].asset,doc.reference);
  assert.match(scenePrompt(doc,manifest),/<image1>: Use the environment/);
  doc.conditioning.promptMode='custom';doc.conditioning.customPrompt='  My prompt <image3>\n';
  assert.equal(scenePrompt(doc,manifest),doc.conditioning.customPrompt);
  doc.conditioning.promptMode='default';doc.reference=null;manifest=libraryManifest(doc);
  assert.equal(manifest.imageCount,3);assert.equal(manifest.guide.index,1);
  assert.deepEqual(manifest.references.map(ref=>ref.index),[2,3]);assert.ok(!scenePrompt(doc,manifest).includes('Change the camera angle'));
  doc.referenceLibrary.items=[];doc.reference=photo(9);manifest=libraryManifest(doc);
  assert.equal(scenePrompt(doc,manifest),'Change the camera angle from <image2> to <image1>.');
});

test('AnyAngle front-end mapping and prompt follow the shared back-end contract',()=>{
  const {scene,expected}=JSON.parse(readFileSync(new URL('./fixtures/anyangle-references.json',import.meta.url),'utf8'));
  const manifest=libraryManifest(scene);
  assert.equal(manifest.imageCount,expected.imageCount);assert.equal(manifest.guide.index,expected.guideIndex);
  assert.deepEqual(manifest.references.map(ref=>({name:ref.asset.name,index:ref.index,resolution:ref.resolution,actorIds:ref.actorIds})),expected.references);
  assert.equal(scenePrompt(scene,manifest),expected.prompt);
});
