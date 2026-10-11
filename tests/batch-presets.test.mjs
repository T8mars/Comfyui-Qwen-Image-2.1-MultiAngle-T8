import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAngleList, cameraBatchPlan, runCameraBatch } from '../web/editor/batch.mjs';
import { readCameraPresets } from '../web/editor/batch-presets.mjs';
import { defaultScene } from '../web/editor/scene.mjs';

test('fixed angles retain explicit order and every scene setting except azimuth', async () => {
  const original = defaultScene(); original.source = {kind:'splat',name:'scene.splat'};
  Object.assign(original.camera, { azimuth: 13, elevation: -12.5, zoom: 1.7, offsetX: 4, offsetY: 8, focalLength: 85 });
  original.cameraTarget = [2, 3, 4]; const before = structuredClone(original);
  const plan = cameraBatchPlan(original, {mode:'angles',angles:'45, -45, 90, -90'}), views = [...plan.views()];
  assert.equal(plan.count,4); assert.deepEqual(views.map(view=>view.scene.camera.azimuth),[45,-45,90,-90]);
  for (const view of views) assert.deepEqual(view.scene,{...before,camera:{...before.camera,azimuth:view.scene.camera.azimuth}});
  views[0].scene.cameraTarget[0] = 999; assert.deepEqual(views[1].scene.cameraTarget,before.cameraTarget); assert.deepEqual(original,before);
  const jobs=[];
  const result=await runCameraBatch(plan,{capture:async scene=>`png-${scene.camera.azimuth}`,save:async(scene,png)=>({angle:scene.camera.azimuth,png}),queue:async snapshot=>{jobs.push(snapshot.angle);return `job-${snapshot.angle}`;}});
  assert.equal(result.error,null); assert.deepEqual(jobs,[45,-45,90,-90]); assert.equal(result.views.length,4); assert.deepEqual(original,before);
});

test('angle lists accept localized separators, degrees and fractions; preserve repeated angles', () => {
  assert.deepEqual(parseAngleList('45°，-45°、90; -90；\n 12.5 0'),[45,-45,90,-90,12.5,0]);
  const scene=defaultScene();scene.source.kind='human';
  const plan=cameraBatchPlan(scene,{mode:'angles',angles:[450,-450,45,45]});
  assert.deepEqual([...plan.views()].map(view=>view.scene.camera.azimuth),[90,-90,45,45]);
  for(const value of ['', ' , ， ', '45,NaN', '45,Infinity', '45abc', '°', null, [], [0,NaN], ['45']]) assert.throws(()=>parseAngleList(value));
});

test('preset JSON round-trips independently of scenes and rejects invalid imports as a whole', () => {
  const data={version:1,kind:'anyangle-camera-presets',presets:[{name:'四向',angles:[45,-45,90,-90]},{name:'细调',angles:[12.5,-30,180]}]};
  const decoded=readCameraPresets(JSON.parse(JSON.stringify(data)));assert.deepEqual(decoded,data.presets);
  decoded[0].angles[0]=0;assert.equal(data.presets[0].angles[0],45);
  for(const invalid of [null,[],{...data,version:2},{...data,kind:'anyangle-batch'}, {...data,presets:[data.presets[0],{name:'损坏',angles:[null]}]}, {...data,presets:[{name:' ',angles:[0]}]}]) assert.throws(()=>readCameraPresets(invalid));
});
