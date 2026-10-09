import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultScene } from '../web/editor/scene.mjs';
import { addReference, newUse, libraryManifest, libraryPrompt, upgradeReferences, updateReferences, sourceChanged, detachTargets, staleGuide } from '../web/editor/reference-library.mjs';
import { createActor } from '../web/editor/actors.mjs';
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
