import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { promptForSnapshot } from '../web/batch-queue.mjs';
import { referencePlan } from '../web/reference.mjs';

const source = readFileSync(new URL('../web/anyangle.js', import.meta.url), 'utf8');
const code = source.slice(source.indexOf('  const validateSnapshot ='), source.indexOf("  window.addEventListener('message', receive)"));

function fixture() {
  const frame = { contentWindow: {} }, replies = [], prompts = [];
  const state = {
    location: { origin: 'http://localhost:8189' }, frame, session: 'session', node: { id: 1, outputs: [{ name: 'guide_image_2', links: [1] }] },
    batchGraph: null, batchRequests: new Map(), referenceSignature: 'reference', structureSignature: null,
    reference: { connected: true, asset: { name: 'reference.png' } }, structure: { connected: false },
    valid: () => true, getPlan: async () => ({ signature: 'reference' }), getStructurePlan: async () => null,
    unwiredAnyAngleLoader: () => false, promptForSnapshot, close() {},
    actorPlans: async () => [], actorSignatures: new Map(), actorReferences: [], poseSignature:null, posePeople:null, referencePlan,
    fetch: async () => ({ ok: true, json: async () => ({ scene: { reference: { name: 'reference.png' }, conditioning: { model: 'anyangle' } } }) }),
    app: { graphToPrompt: async () => ({ output: { '1': { class_type: 'AnyAngleStudioT8', inputs: { snapshot: 'old' } } },
      workflow: { nodes: [{ id: 1, widgets_values: ['old'] }] } }) },
    api: { queuePrompt: async (position, prompt) => { assert.equal(position, 0); prompts.push(prompt); return { prompt_id: `job-${prompts.length}` }; } },
    send: (type, payload) => replies.push({ type, ...payload }),
  };
  vm.runInNewContext(code + '\nthis.receive = receive;', state);
  const receive = (requestId, action, snapshot) => state.receive({ origin: state.location.origin, source: frame.contentWindow,
    data: { type: 'anyangle-batch-request', session: 'session', requestId, action, snapshot } });
  return { state, receive, prompts, replies };
}

test('duplicate batch requests queue a view once, and every frame keeps its own snapshot metadata', async () => {
  const { receive, prompts, replies } = fixture();
  await receive('prepare', 'prepare');
  const first = { version: 1, id: 'a'.repeat(64) }, second = { version: 1, id: 'b'.repeat(64) };
  await Promise.all([receive('first', 'queue', first), receive('first', 'queue', first)]);
  await receive('second', 'queue', second);
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].output['1'].inputs.snapshot, JSON.stringify(first));
  assert.equal(prompts[1].workflow.nodes[0].widgets_values[0], JSON.stringify(second));
  assert.equal(replies.filter(reply => reply.requestId === 'first').length, 2);
  assert.ok(replies.filter(reply => reply.requestId === 'first').every(reply => reply.result.prompt_id === 'job-1'));
});

test('reference changes stop the batch before any final-image job is queued', async () => {
  const { state, receive, prompts, replies } = fixture();
  await receive('prepare', 'prepare');
  state.getPlan = async () => ({ signature: 'changed' });
  await receive('view', 'queue', { version: 1, id: 'a'.repeat(64) });
  assert.equal(prompts.length, 0); assert.match(replies.at(-1).error, /上游已变化/);
});

test('static keypoints compare graph signatures and data hashes separately and preserve explicit guide priority', async () => {
  const {state,receive,prompts,replies}=fixture();
  const graph={'1':{class_type:'AnyAngleStudioT8',inputs:{snapshot:'old',pose_keypoints:['2',0]}},'2':{class_type:'SDPose',inputs:{threshold:.5}}};
  state.app.graphToPrompt=async()=>({output:graph,workflow:{nodes:[{id:1,widgets_values:['old']}]}});
  state.poseSignature=referencePlan(graph,1,'pose_keypoints').signature;state.posePeople={signature:'a'.repeat(64)};
  state.structure={connected:true,asset:{name:'old-structure.png'}};
  state.fetch=async()=>({ok:true,json:async()=>({scene:{reference:{name:'reference.png'},conditioning:{model:'base',guide:'pose'},openpose:{origin:'keypoints',useRig:false,sourceName:'selected-pose.png',inputSignature:state.posePeople.signature,inputPlanSignature:state.poseSignature}}})});
  await receive('prepare','prepare');await receive('view','queue',{version:1,id:'b'.repeat(64)});
  assert.equal(prompts.length,1);assert.ok(!replies.at(-1).error);
  graph['2'].inputs.threshold=.8;
  await receive('changed','queue',{version:1,id:'c'.repeat(64)});assert.equal(prompts.length,1);assert.match(replies.at(-1).error,/关键点上游已变化/);
});

test('multi-person encoder displays the native latent frame without changing socket identity', async () => {
  const calls=[],outputs=[{name:'positive'},{name:'negative'},{name:'latent'}];let extension;
  const context={app:{registerExtension:value=>{extension=value},graph:{setDirtyCanvas:()=>calls.push('redraw')}}};
  vm.runInNewContext(source.slice(source.indexOf('app.registerExtension(')),context);
  class Encoder {onExecuted(){calls.push('native')}}
  await extension.beforeRegisterNodeDef(Encoder,{name:'AnyAngleMultiPersonEncodeT8'});
  const node=new Encoder();node.outputs=outputs;node.onExecuted({anyangle_encoding:[{width:864,height:1536}]});
  assert.equal(node.outputs[2].name,'latent');assert.equal(node.outputs[2].label,'latent · 864 × 1536');assert.deepEqual(calls,['native','redraw']);
});
