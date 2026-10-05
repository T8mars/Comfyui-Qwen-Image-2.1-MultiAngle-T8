// Separate static test server: does not read, start or operate a ComfyUI instance.
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, sep } from 'node:path';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { editorActions } from './editor-actions.mjs';
import { framingMatrix } from './framing-matrix.mjs';
import { pointerWebGL, pointerEditor } from './pointer-webgl.mjs';
import { gestureEditor } from './gesture-webgl.mjs';
const require=createRequire(import.meta.url), {chromium}=require(process.env.ANYANGLE_PLAYWRIGHT || 'playwright');
const hardware=process.env.ANYANGLE_HARDWARE==='1';
const root=resolve(fileURLToPath(new URL('..',import.meta.url))),out=resolve(root,'.local',hardware?'webgl-hardware':'webgl');await mkdir(out,{recursive:true});
function cubeGLB(){
  const positions=new Float32Array([-2,0,-1,2,0,-1,2,8,-1,-2,8,-1,-2,0,1,2,0,1,2,8,1,-2,8,1]),indices=new Uint16Array([0,2,1,0,3,2,4,5,6,4,6,7,0,1,5,0,5,4,3,7,6,3,6,2,0,4,7,0,7,3,1,2,6,1,6,5]);
  const binary=Buffer.concat([Buffer.from(positions.buffer),Buffer.from(indices.buffer)]),data={asset:{version:'2.0'},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],meshes:[{primitives:[{attributes:{POSITION:0},indices:1}]}],buffers:[{byteLength:binary.length}],bufferViews:[{buffer:0,byteOffset:0,byteLength:positions.byteLength,target:34962},{buffer:0,byteOffset:positions.byteLength,byteLength:indices.byteLength,target:34963}],accessors:[{bufferView:0,componentType:5126,count:8,type:'VEC3',min:[-2,0,-1],max:[2,8,1]},{bufferView:1,componentType:5123,count:36,type:'SCALAR'}]};
  let json=Buffer.from(JSON.stringify(data));json=Buffer.concat([json,Buffer.alloc((4-json.length%4)%4,32)]);const header=Buffer.alloc(20);header.writeUInt32LE(0x46546c67,0);header.writeUInt32LE(2,4);header.writeUInt32LE(28+json.length+binary.length,8);header.writeUInt32LE(json.length,12);header.writeUInt32LE(0x4e4f534a,16);const tail=Buffer.alloc(8);tail.writeUInt32LE(binary.length,0);tail.writeUInt32LE(0x004e4942,4);return Buffer.concat([header,json,tail,binary]);
}
function skinnedGLB() {
  const base = cubeGLB(), length = base.readUInt32LE(12), data = JSON.parse(base.subarray(20, 20 + length).toString());
  const original = base.subarray(28 + length), joints = new Uint16Array(32), weights = new Float32Array(32);
  for (let i = 0; i < 8; i++) weights[i * 4] = 1;
  const binary = Buffer.concat([original, Buffer.from(joints.buffer), Buffer.from(weights.buffer)]);
  data.buffers[0].byteLength = binary.length;
  data.bufferViews.push({ buffer: 0, byteOffset: original.length, byteLength: joints.byteLength },
    { buffer: 0, byteOffset: original.length + joints.byteLength, byteLength: weights.byteLength });
  data.accessors.push({ bufferView: 2, componentType: 5123, count: 8, type: 'VEC4' },
    { bufferView: 3, componentType: 5126, count: 8, type: 'VEC4' });
  Object.assign(data.meshes[0].primitives[0].attributes, { JOINTS_0: 2, WEIGHTS_0: 3 });
  data.nodes[0].skin = 0; data.nodes.push({ name: 'FixtureJoint' }); data.scenes[0].nodes.push(1);
  data.skins = [{ joints: [1], skeleton: 1 }];
  let json = Buffer.from(JSON.stringify(data)); json = Buffer.concat([json, Buffer.alloc((4 - json.length % 4) % 4, 32)]);
  const header = Buffer.alloc(20), tail = Buffer.alloc(8);
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + binary.length, 8);
  header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  tail.writeUInt32LE(binary.length, 0); tail.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, json, tail, binary]);
}
const server=createServer(async(req,res)=>{try{
  const path=new URL(req.url,'http://localhost').pathname;
  if(path==='/tests/editor.html'){
    const html=await readFile(resolve(root,'web/editor/index.html'),'utf8');res.writeHead(200,{'Content-Type':'text/html'});res.end(html.replace('<head>','<head><base href="/web/editor/">'));return;
  }
  if (path === '/tests/gestures.html') {
    const html = await readFile(resolve(root, 'web/editor/index.html'), 'utf8'), app = await readFile(resolve(root, 'web/editor/app.mjs'), 'utf8');
    const scene = app.match(/from '(\.\/scene\.mjs[^']*)'/)[1];
    const fixture = html.replace(/<script type="module" src="([^"]+)"><\/script>/, (_, entry) => `<script type="module">import {StudioScene} from '${scene}'; const init = StudioScene.prototype.init; StudioScene.prototype.init = async function(...args) { window.auditStudio = this; return init.apply(this,args); }; await import('${entry}');</script>`);
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(fixture.replace('<head>', '<head><base href="/web/editor/">')); return;
  }
  if(path!=='/tests/webgl.html'&&path!=='/tests/fixtures/fisher-skeleton.mjs'&&!path.startsWith('/web/')){res.writeHead(404);res.end();return;}
  const file=resolve(root,'.'+path);if(!file.startsWith(root+sep)){res.writeHead(400);res.end();return;}
  const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.png':'image/png','.jpg':'image/jpeg','.css':'text/css','.svg':'image/svg+xml','.woff2':'font/woff2'};
  const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]||'application/octet-stream'});res.end(data);
}catch{res.writeHead(404);res.end();}});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({headless:true,executablePath:process.env.ANYANGLE_CHROMIUM||undefined,args:hardware?['--enable-gpu','--use-angle=d3d11','--ignore-gpu-blocklist']:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});const page=await browser.newPage({viewport:{width:1200,height:840}}),errors=[];
  page.on('pageerror',error=>errors.push(error.message));await page.goto(`http://127.0.0.1:${server.address().port}/tests/webgl.html`);await page.waitForFunction(()=>window.ready,{timeout:120000});assert.deepEqual(errors,[]);
  const frames=await page.evaluate(async()=>{
    const s=window.studio;const camera=JSON.stringify(window.doc.camera),display={width:s.canvas.width,height:s.canvas.height,position:s.viewer.camera.position.toArray(),projection:s.viewer.camera.projectionMatrix.toArray()};
    const coarse=await s.capture(),pose=s.captureOpenPose(),depth=await s.capture(undefined,undefined,{depth:true});
    const after={width:s.canvas.width,height:s.canvas.height,position:s.viewer.camera.position.toArray(),projection:s.viewer.camera.projectionMatrix.toArray()};
    const gl=s.viewer.renderer.getContext(),extension=gl.getExtension('WEBGL_debug_renderer_info');
    return{coarse,pose,depth,camera,display,after,people:s.poseJSON().people.length,memory:{...s.viewer.renderer.info.memory},gpu:extension?gl.getParameter(extension.UNMASKED_RENDERER_WEBGL):'unavailable'};
  });assert.equal(frames.people,2);assert.deepEqual(frames.display,frames.after);
  for(const key of ['coarse','pose','depth'])await writeFile(resolve(out,`${key}-2.png`),Buffer.from(frames[key].split(',')[1],'base64'));
  const depthStats=await page.evaluate(async(png)=>{const image=new Image();image.src=png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);const p=ctx.getImageData(0,0,canvas.width,canvas.height).data,values=new Set();let colored=0;for(let i=0;i<p.length;i+=4){values.add(p[i]);if(p[i]!==p[i+1]||p[i]!==p[i+2])colored++;}return{range:values.size,colored};},frames.depth);assert.ok(depthStats.range>8);assert.equal(depthStats.colored,0);
  await page.locator('#stage').screenshot({path:resolve(out,'stage-2.png')});
  const result=await page.evaluate(async()=>{
    const {createActor,ensureActors,bindActor}=await import('/web/editor/actors.mjs'),{randomPose}=await import('/web/editor/poses.mjs');const s=window.studio,d=window.doc,records=[];
    for(const n of [3,6,9]){
      d.actors=Array.from({length:n},(_,i)=>createActor(i,{id:`p${i}`,pose:randomPose(40+i,'standing'),transform:{x:(i-(n-1)/2)*6,y:0,z:(i%2)*3,scale:1,yaw:(i%3-1)*15}}));ensureActors(d);bindActor(d);await s.restore(d);s.fit();
      const camera=JSON.stringify(d.camera),before=JSON.stringify(s.viewer.captureCamera.projectionMatrix.elements),start=performance.now();for(const role of d.actors)await s.selectActor(role.id);
      records.push({count:n,outputPeople:s.poseJSON().people.length,cameraStable:JSON.stringify(d.camera)===camera,projectionStable:JSON.stringify(s.viewer.captureCamera.projectionMatrix.elements)===before,averageSwitchMs:Math.round((performance.now()-start)/n),heap:performance.memory?.usedJSHeapSize});
    }
    const memoryBefore={...s.viewer.renderer.info.memory};for(let i=0;i<100;i++){await s.selectActor(d.actors[i%d.actors.length].id);s.viewer.renderer.render(s.viewer.scene,s.viewer.camera);}
    const memoryAfter={...s.viewer.renderer.info.memory},frames=s.viewer.renderer.info.render.frame;await new Promise(resolve=>setTimeout(resolve,1000));
    return{records,memoryBefore,memoryAfter,idleDraws:s.viewer.renderer.info.render.frame-frames,shapeCacheBytes:s.morphCacheBytes,nine:await s.capture()};
  });process.stdout.write(JSON.stringify({memoryBefore:result.memoryBefore,memoryAfter:result.memoryAfter}));for(const record of result.records){assert.equal(record.outputPeople,record.count);assert.ok(record.cameraStable&&record.projectionStable);}assert.ok(result.memoryAfter.textures<=result.memoryBefore.textures);assert.ok(result.memoryAfter.geometries<=result.memoryBefore.geometries);assert.ok(result.idleDraws<=1);assert.ok(result.shapeCacheBytes<=16*1024*1024);
  await writeFile(resolve(out,'coarse-9.png'),Buffer.from(result.nine.split(',')[1],'base64'));delete result.nine;
  await page.route('**/anyangle-studio/assets/fixture.glb',route=>route.fulfill({status:200,body:cubeGLB(),contentType:'model/gltf-binary'}));
  result.props=await page.evaluate(async()=>{
    const s=window.studio,d=window.doc,before=await s.capture(),camera=JSON.stringify(d.camera);
    const prop={id:'fixture-prop',label:'Fixture',asset:{name:'fixture.glb'},transform:{x:0,y:0,z:12,scale:1,yaw:30},visible:true,locked:false};d.props=[prop];await s.restoreProps();
    const shown=await s.capture();prop.visible=false;s.updateProp(prop);const hidden=await s.capture();d.props=[];await s.restoreProps();
    return{appears:shown!==before,hiddenSame:hidden===before,removed:s.propRoots.size===0,cameraStable:camera===JSON.stringify(d.camera)};
  });assert.ok(Object.values(result.props).every(Boolean));
  await page.route('**/anyangle-studio/assets/skinned-fixture.glb', route => route.fulfill({ body: skinnedGLB(), contentType: 'model/gltf-binary' }));
  result.skinnedGLBRelease = await page.evaluate(async () => {
    const s = window.studio, d = window.doc, before = s.viewer.renderer.info.memory.textures;
    d.source = { kind: 'glb', name: 'skinned-fixture.glb' }; await s.restore(d); await s.capture();
    let skeleton; s.glb.traverse(mesh => { if (mesh.skeleton) skeleton = mesh.skeleton; });
    const allocated = !!skeleton.boneTexture, withGLB = s.viewer.renderer.info.memory.textures;
    d.source = { kind: 'human' }; await s.restore(d); await s.capture();
    return { allocated, released: skeleton.boneTexture === null, before, withGLB, after: s.viewer.renderer.info.memory.textures };
  });
  assert.ok(result.skinnedGLBRelease.allocated && result.skinnedGLBRelease.released);
  assert.equal(result.skinnedGLBRelease.after, result.skinnedGLBRelease.before);
  // Exercise the actual editor DOM on this static fixture; no ComfyUI routes exist.
  await page.setViewportSize({width:1660,height:1000});await page.goto(`http://127.0.0.1:${server.address().port}/tests/editor.html`);
  await page.waitForFunction(()=>document.querySelector('#loading').hidden&&!document.querySelector('#workspace').inert,{timeout:120000});
  for(let i=0;i<2;i++){await page.locator('#add-actor').click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert,{timeout:120000});}
  assert.equal(await page.locator('.actor-card').count(),2);
  await page.locator('.actor-name').first().click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert);
  await page.locator('#actor-description').fill('Person A wearing a dark blue jacket');await page.locator('#actor-description').blur();
  await page.locator('[data-guide="pose"]').click();await page.locator('#pose-hands').check();await page.locator('#view-scene').click();await page.locator('#fit-frame').click();
  await page.locator('#actors-panel').evaluate(element=>element.scrollIntoView({block:'start'}));
  await page.waitForFunction(()=>document.querySelector('#toast').hidden);await page.screenshot({path:resolve(out,'studio-multi-person.png')});
  const downloadEvent=page.waitForEvent('download');await page.locator('#export-keypoints').click();const downloaded=await downloadEvent;
  await downloaded.saveAs(resolve(out,'ui-people.json'));const json=JSON.parse(await readFile(resolve(out,'ui-people.json'),'utf8'));
  assert.equal(json.people.length,2);assert.ok(json.people.every(person=>person.hand_left_keypoints_2d.length===63&&person.pose_keypoints_2d[2]===1));
  await page.locator('#clone-actor').click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert);assert.equal(await page.locator('.actor-card').count(),3);
  assert.equal(await page.locator('#actor-description').inputValue(),'','A copied pose does not silently duplicate identity');
  await page.locator('.actor-name').first().click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert);
  await page.locator('#delete-actor').click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert);assert.equal(await page.locator('.actor-card').count(),2);
  await page.locator('#undo').click();await page.waitForFunction(()=>!document.querySelector('#workspace').inert);assert.equal(await page.locator('.actor-card').count(),3);
  result.editorUI={added:2,cloned:3,deleted:2,undoRestored:3,exportedPeople:json.people.length,handPoints:21,noseLandmarks:true};
  result.editorActions=await editorActions(page,`http://127.0.0.1:${server.address().port}`,out,cubeGLB());
  result.pointerWebGL = await pointerWebGL(browser, `http://127.0.0.1:${server.address().port}`, out, cubeGLB());
  result.pointerEditor = await pointerEditor(browser, `http://127.0.0.1:${server.address().port}`, out);
  result.gestureEditor = await gestureEditor(browser, `http://127.0.0.1:${server.address().port}`);
  result.framingMatrix=await framingMatrix(browser,`http://127.0.0.1:${server.address().port}`);
  assert.deepEqual(errors,[]);const receipt={date:new Date().toISOString(),hardware:frames.gpu,requestedHardware:hardware,depthStats,initialMemory:frames.memory,...result};await writeFile(resolve(out,'receipt.json'),JSON.stringify(receipt,null,2));process.stdout.write(JSON.stringify(receipt));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
