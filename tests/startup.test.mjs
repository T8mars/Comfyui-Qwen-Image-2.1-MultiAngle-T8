import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { defaultScene as currentDefaultScene, restoreSceneDefaults } from '../web/editor/scene.mjs';
const defaultScene = () => { const scene = currentDefaultScene(); scene.version = 2; delete scene.referenceLibrary; return scene; };
import { ensureActors } from '../web/editor/actors.mjs';
import { buildManifest, actorMode, actorPrompt, scenePrompt } from '../web/editor/manifest.mjs';
import { createActor } from '../web/editor/actors.mjs';

const source = readFileSync(new URL('../web/editor/app.mjs', import.meta.url), 'utf8');
const startSource = source.slice(source.indexOf('async function start('), source.indexOf('\nfunction readPendingReference('));

test('first custom prompt copies the actual cast prompt and subsequent switches preserve edits', () => {
  const doc=defaultScene();doc.source.kind='human';doc.conditioning={model:'base',identityMode:'actors',guide:'pose'};
  doc.actors=[createActor(0,{identity:{description:'Alice in red'}}),createActor(1,{identity:{description:'Bob in blue'}})];
  const expected=scenePrompt(doc),element={},state={doc,scenePrompt,actorMode,actorPrompt,buildManifest,$:()=>element,begin(){},changed(){}};
  const handler=source.slice(source.indexOf("$('#prompt-mode').onchange ="),source.indexOf("\n$('#image-order').onchange"));
  vm.runInNewContext(handler,state);element.onchange({target:{value:'custom'}});
  assert.equal(doc.conditioning.customPrompt,expected);assert.match(expected,/exactly 2 people/);
  assert.match(expected,/Alice in red/);assert.match(expected,/Bob in blue/);assert.doesNotMatch(expected,/<image2>/);
  doc.conditioning.customPrompt='User edited text.';element.onchange({target:{value:'default'}});element.onchange({target:{value:'custom'}});
  assert.equal(doc.conditioning.customPrompt,'User edited text.');
});

test('first custom static prompt uses the newly enabled identity mapping', () => {
  const doc=defaultScene();doc.source.kind='human';doc.reference=null;
  doc.conditioning={model:'base',identityMode:'actors',guide:'pose',map:{name:'pose.png'},mapKind:'pose',imageOrder:'reference-first'};
  doc.actors=[createActor(0,{identity:{asset:{name:'a.png'},description:'Alice'}}),createActor(1,{identity:{asset:{name:'b.png'},description:'Bob'}})];
  assert.equal(buildManifest(doc).guide.index,1);assert.doesNotMatch(scenePrompt(doc),/<image2>|<image3>/);
  const element={},state={doc,scenePrompt,actorMode,actorPrompt,buildManifest,$:()=>element,begin(){},changed(){}};
  const handler=source.slice(source.indexOf("$('#prompt-mode').onchange ="),source.indexOf("\n$('#image-order').onchange"));
  vm.runInNewContext(handler,state);element.onchange({target:{value:'custom'}});
  assert.equal(buildManifest(doc).guide.index,3);assert.match(doc.conditioning.customPrompt,/<image3> as the pose guide/);
  assert.match(doc.conditioning.customPrompt,/from <image1>/);assert.match(doc.conditioning.customPrompt,/from <image2>/);
});

function fixture(response) {
  const elements = new Map();
  const notices = [], errors = [], requests = [];
  const state = {
    doc: defaultScene(), snapshot: null, ready: false, busy: true,
    initCount: 0, reconstructionCount: 0, previewCount: 0,
    defaultScene, restoreSceneDefaults,
    $: selector => {
      if (!elements.has(selector)) elements.set(selector, { hidden: false, textContent: '', dataset: {} });
      return elements.get(selector);
    },
    fetch: async url => { requests.push(url); return response; },
    toast: message => notices.push(message), error: failure => errors.push(failure.message),
    showLoadError: () => { state.$('#loading').hidden = true; },
    StudioScene: class { async init(doc) { state.initCount++; state.initializedSource = doc.source.kind; } },
    begin() {}, changed() {}, refresh() {}, schedulePreview() {}, selectRole() {},
    sourceChanged() {},
    renderShots() {}, renderLibrary() {}, ensureHumanTools: async () => {},
    usesLocalGuide: () => false, applyStructureAsset: async () => {},
    requiresGuide: () => state.doc.version !== 3 || state.doc.referenceLibrary.mode === 'guided',
    setBusy: value => { state.busy = value; },
    renderPreview: async () => { state.previewCount++; },
    currentGuide: () => state.doc.conditioning.guide,
    run: async action => action(),
    reconstructPhoto: async () => { state.reconstructionCount++; },
  };
  vm.runInNewContext(startSource, state);
  return { state, elements, notices, errors, requests };
}

test('missing migrated snapshot opens an editable scene and reconstructs the connected reference', async () => {
  const { state, elements, notices, errors, requests } = fixture({
    ok: false, status: 404, json: async () => ({ error: 'AnyAngle asset is missing' }),
  });
  const reference = { connected: true, asset: { name: 'photo.png' } };
  await state.start({ version: 1, id: 'old/snapshot' }, reference);
  assert.equal(requests[0], '/anyangle-studio/snapshots/old%2Fsnapshot');
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(elements.get('#loading').hidden, true);
  assert.equal(state.snapshot, null);
  assert.equal(state.initializedSource, 'empty');
  assert.equal(state.doc.reference, reference.asset);
  assert.equal(state.reconstructionCount, 1);
  assert.equal(state.previewCount, 1);
  assert.equal(notices.length, 1);
  assert.deepEqual(errors, []);
});

test('missing snapshot without a connected photo leaves import controls available', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 404, json: async () => { throw new SyntaxError('not JSON'); } });
  await state.start({ version: 1, id: 'missing' });
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(state.reconstructionCount, 0);
  assert.equal(notices.length, 1);
  assert.deepEqual(errors, []);
});

test('existing saved snapshot retains its camera and scene without new reconstruction', async () => {
  const saved = defaultScene();
  saved.source = { kind: 'glb', name: 'model.glb' };
  saved.camera.azimuth = 90;
  const { state, notices, errors } = fixture({ ok: true, status: 200, json: async () => ({ scene: saved }) });
  const token = { version: 1, id: 'existing' };
  await state.start(token);
  assert.equal(state.ready, true);
  assert.equal(state.busy, false);
  assert.equal(state.snapshot, token);
  assert.equal(state.doc.camera.azimuth, 90);
  assert.equal(state.initializedSource, 'glb');
  assert.equal(state.reconstructionCount, 0);
  assert.deepEqual(notices, []);
  assert.deepEqual(errors, []);
});

test('sparse legacy snapshot without bookmarks or optional settings opens and preserves its original pose during migration', async () => {
  const saved = { version: 1, width: 96, height: 64, source: { kind: 'human' }, conditioning: null,
    camera: { azimuth: 17, elevation: 9, zoom: .8 }, front: 42, scale: .7,
    mesh: { muscle: .8 }, pose: { bones: { head: [3, 24, 0] } } };
  const { state, errors } = fixture({ ok: true, status: 200, json: async () => ({ scene: saved }) });
  await state.start({ version: 1, id: 'sparse-legacy' });
  assert.equal(state.ready, true); assert.equal(state.busy, false); assert.deepEqual(errors, []);
  assert.deepEqual(state.doc.shots, []); assert.equal(state.doc.background, '#69717b');
  assert.equal(state.doc.camera.azimuth, 17); assert.equal(state.doc.camera.offsetZ, 0);
  assert.equal(state.doc.conditioning.model, 'anyangle'); assert.equal(state.doc.mesh.muscle, .8);
  assert.equal(state.doc.actors, undefined);
  ensureActors(state.doc, true);
  assert.equal(state.doc.actors.length, 1); assert.deepEqual(state.doc.actors[0].pose, saved.pose);
  assert.equal(state.doc.actors[0].transform.yaw, 42); assert.equal(state.doc.actors[0].transform.scale, .7);
});

test('background reconstruction preference restores with its snapshot and old scenes default to subject mode', async () => {
  for (const keepBackground of [true, false]) {
    const saved = defaultScene(); delete saved.reconstruction;
    saved.reference = { name: 'photo.png' };
    saved.source = { kind: 'splat', name: 'scene.ply', reference: saved.reference, keep_background: keepBackground };
    const { state, errors } = fixture({ ok: true, json: async () => ({ scene: saved }) });
    await state.start({ version: 1, id: 'saved-scene' });
    assert.equal(state.doc.reconstruction.keepBackground, keepBackground);
    assert.equal(state.reconstructionCount, 0);
    assert.deepEqual(errors, []);
  }
});

test('authorization errors remain visible instead of being reported as a missing scene', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 403, json: async () => ({ error: 'Authentication required' }) });
  await state.start({ version: 1, id: 'restricted' });
  assert.equal(state.initCount, 0);
  assert.equal(state.ready, false);
  assert.deepEqual(notices, []);
  assert.deepEqual(errors, ['Authentication required']);
});

test('server errors with a non-JSON body retain the HTTP status', async () => {
  const { state, notices, errors } = fixture({ ok: false, status: 503, json: async () => { throw new SyntaxError('not JSON'); } });
  await state.start({ version: 1, id: 'unavailable' });
  assert.equal(state.initCount, 0);
  assert.deepEqual(notices, []);
  assert.match(errors[0], /503/);
});

test('actor and keypoint replies wait for the current edit and preserve revision history', async () => {
  const microtasks=[],jobs=[],references=[],notices=[];
  const state={busy:true,ready:true,pendingActors:{actorReferences:[{inputKey:'actor_reference_2',asset:{name:'b.png'}}]},pendingKeypoints:{posePeople:{asset:{name:'pose.png'},people:[{points:{},fullBody:false}],signature:'new'}},pendingReference:null,pendingStructure:null,
    doc:{conditioning:{},openpose:null},$:()=>({}),hasGuide:()=>true,linkedReference:{},linkedStructure:{},usesLocalGuide:()=>true,undo:[],redo:[],queueMicrotask:fn=>microtasks.push(fn),
    readPendingReference(){},readPendingStructure(){},setReferenceConnections(){},updateActorReferences:value=>references.push(value),toast:message=>notices.push(message),changed:()=>{state.changes++},changes:0,
    applyOpenPoseAsset:async(asset)=>{state.doc.openpose={sourceName:asset.name,useRig:false};state.changes++},
  };
  state.run=task=>{if(state.busy)return;state.setBusy(true);const job=Promise.resolve().then(task).finally(()=>state.setBusy(false));jobs.push(job);return job};
  const busyCode=source.slice(source.indexOf('function setBusy('),source.indexOf('\nasync function run('));
  const pendingCode=source.slice(source.indexOf('function readPendingActors('),source.indexOf('\ninstallActorsUI('));
  vm.runInNewContext(busyCode+'\n'+pendingCode,state);
  state.readPendingActors();state.readPendingKeypoints();assert.equal(references.length,0);assert.equal(state.changes,0);
  state.setBusy(false);
  while(microtasks.length||jobs.length){while(microtasks.length)microtasks.shift()();await Promise.all(jobs.splice(0));}
  assert.equal(references.length,1);assert.equal(state.doc.openpose.inputSignature,'new');assert.equal(state.changes,2);assert.equal(state.pendingActors,null);assert.equal(state.pendingKeypoints,null);
  state.pendingKeypoints={posePeople:{asset:{name:'pose.png'},people:[],signature:'new'}};state.readPendingKeypoints();await Promise.all(jobs.splice(0));assert.equal(state.changes,2,'Repeated identical keypoints do not overwrite an edit or add history');
});
