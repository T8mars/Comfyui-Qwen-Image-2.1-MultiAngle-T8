import { app } from '../../scripts/app.js';
import { referencePlan, executeReference } from './reference.mjs';

let graphRevision = 0;
let closeActive = null;
const extensionURL = new URL('./editor/index.html', import.meta.url);

function openEditor(node, widget) {
  closeActive?.();
  const session = crypto.randomUUID(), graph = app.graph, revision = graphRevision, initial = widget.value;
  const dialog = document.createElement('dialog');
  Object.assign(dialog.style, { width: 'min(1600px, 97vw)', height: '94vh', maxWidth: 'none', maxHeight: 'none', padding: '0', border: '1px solid #3a5265', borderRadius: '12px', background: '#101920', overflow: 'hidden' });
  const frame = document.createElement('iframe');
  const url = new URL(extensionURL); url.searchParams.set('session', session);
  frame.src = url; frame.title = 'AnyAngle Studio · 3D 相机与姿势编辑器';
  Object.assign(frame.style, { width: '100%', height: '100%', border: '0', display: 'block' });
  dialog.append(frame); document.body.append(dialog);
  let active = true;
  let reference = { connected: false }, referenceSignature = null, readingReference = false;
  let structure = { connected: false }, structureSignature = null, readingStructure = false;
  const unwiredAnyAngleLoader = () => {
    const strength = node.outputs?.find(output => output.name === 'anyangle_lora_strength');
    return graph._nodes.some(candidate => {
      if (!['LoraLoaderModelOnly', 'AnyAngleOptionalLoRAT8'].includes(candidate.type)
          || !candidate.outputs?.some(output => output.name === 'MODEL' && output.links?.length)) return false;
      const filename = candidate.widgets?.find(item => item.name === 'lora_name')?.value;
      if (!/anyangle/i.test(String(filename || ''))) return false;
      const input = candidate.inputs?.find(item => item.name === 'strength_model');
      return !input?.link || !strength?.links?.includes(input.link);
    });
  };
  const send = (type, payload = {}) => { if (valid()) frame.contentWindow.postMessage({ type, session, ...payload }, location.origin); };
  const getPlan = async () => {
    const { output } = await app.graphToPrompt();
    const plan = referencePlan(output, node.id);
    if (!plan && node.inputs?.find(input => input.name === 'reference_image')?.link != null) throw new Error('参考图连线未能解析，请检查上游是否被禁用');
    return plan;
  };
  const getStructurePlan = async () => {
    const { output } = await app.graphToPrompt();
    const plan = referencePlan(output, node.id, 'structure_image');
    if (!plan && node.inputs?.find(input => input.name === 'structure_image')?.link != null) throw new Error('结构图连线未能解析，请检查上游是否被禁用');
    return plan;
  };
  const readReference = async (execute = false) => {
    if (readingReference) return;
    readingReference = true;
    const previous = reference, previousSignature = referenceSignature;
    const connected = node.inputs?.find(input => input.name === 'reference_image')?.link != null;
    let sameSignature = false;
    reference = { connected, pending: true, ...(connected && previous.asset ? { asset: previous.asset } : {}) };
    try {
      const plan = await getPlan();
      sameSignature = !!plan && plan.signature === previousSignature;
      referenceSignature = plan?.signature || null;
      if (!plan) reference = { connected: false };
      else if (plan.filename || execute) {
        if (!sameSignature) reference = { connected: true, pending: true };
        send('anyangle-reference', { reference: { ...reference, message: plan.filename ? '正在读取连线原图…' : '正在执行参考图的上游节点…' } });
        // Use ComfyUI's decoder for direct images too: JPEG decoding can differ
        // from browser/Pillow import even when the filename ends in .png.
        const asset = await executeReference(plan, valid);
        if (!valid()) return;
        if ((await getPlan())?.signature !== plan.signature) throw new Error('上游已变化，请重新读取图像');
        reference = { connected: true, asset, message: '来自 IMAGE 连线 · 使用第一张图像' };
      } else reference = { connected: true, message: '点击读取上游图像，执行取得原图所需的节点' };
    } catch (error) {
      reference = { connected, ...(sameSignature && previous.asset ? { asset: previous.asset } : {}),
        pending: false, error: error.message, message: error.message };
    }
    finally { readingReference = false; }
  };
  const readStructure = async (execute = false) => {
    if (readingStructure) return;
    readingStructure = true;
    const previous = structure, previousSignature = structureSignature;
    const connected = node.inputs?.find(input => input.name === 'structure_image')?.link != null;
    let sameSignature = false;
    structure = { connected, pending: true, ...(connected && previous.asset ? { asset: previous.asset } : {}) };
    try {
      const plan = await getStructurePlan();
      sameSignature = !!plan && plan.signature === previousSignature;
      structureSignature = plan?.signature || null;
      if (!plan) structure = { connected: false };
      else if (plan.filename || execute) {
        if (!sameSignature) structure = { connected: true, pending: true };
        send('anyangle-structure', { structure: { ...structure, message: '正在读取连线结构图…' } });
        const asset = await executeReference(plan, valid);
        if (!valid()) return;
        if ((await getStructurePlan())?.signature !== plan.signature) throw new Error('结构图上游已变化，请重新读取');
        structure = { connected: true, asset, message: '来自 IMAGE 连线 · 使用第一张结构图' };
      } else structure = { connected: true, message: '点击读取上游结构图' };
    } catch (error) {
      structure = { connected, ...(sameSignature && previous.asset ? { asset: previous.asset } : {}),
        pending: false, error: error.message, message: error.message };
    } finally { readingStructure = false; }
  };
  const close = () => { if (!active) return; active = false; window.removeEventListener('message', receive); dialog.remove(); if (closeActive === close) closeActive = null; };
  const valid = () => active && app.graph === graph && graphRevision === revision && graph.getNodeById(node.id) === node && widget.value === initial;
  const receive = async event => {
    if (event.origin !== location.origin || event.source !== frame.contentWindow || event.data?.session !== session) return;
    if (!valid()) { close(); return; }
    if (event.data.type === 'anyangle-ready') {
      let snapshot = null; try { snapshot = initial ? JSON.parse(initial) : null; } catch { /* New editor can replace a damaged widget. */ }
      await readReference();
      await readStructure();
      send('anyangle-load', { snapshot, reference, structure, unwiredAnyAngle: unwiredAnyAngleLoader() });
    } else if (event.data.type === 'anyangle-read-reference') {
      await readReference(true); send('anyangle-reference', { reference });
    } else if (event.data.type === 'anyangle-read-structure') {
      await readStructure(true); send('anyangle-structure', { structure });
    } else if (event.data.type === 'anyangle-close') close();
    else if (event.data.type === 'anyangle-apply') {
      const token = event.data.snapshot;
      if (token?.version !== 1 || !/^[a-f0-9]{64}$/.test(token.id) || !Number.isInteger(event.data.revision)) return;
      try {
        if (((await getPlan())?.signature || null) !== referenceSignature) throw new Error('上游已变化，请重新打开工作台读取原图');
        if (((await getStructurePlan())?.signature || null) !== structureSignature) throw new Error('结构图上游已变化，请重新读取');
        const response = await fetch(`/anyangle-studio/snapshots/${token.id}`);
        if (!response.ok) throw new Error('无法验证已保存的场景，请重新应用');
        const saved = await response.json();
        if (saved.scene.conditioning?.model === 'base' && unwiredAnyAngleLoader())
          throw new Error('当前工作流的 AnyAngle LoRA 强度仍固定。请将 Studio 的 anyangle_lora_strength 接至 LoRA 加载器 strength_model，或移除该加载器。');
        if (reference.connected && saved.scene.reference?.name !== reference.asset?.name) throw new Error('参考图已变化，请等待对应主体重建后再应用');
        if (structure.connected && saved.scene.conditioning?.model === 'base') {
          const guide = saved.scene.conditioning.guide;
          const name = guide === 'pose' ? saved.scene.openpose?.sourceName : saved.scene.conditioning.map?.name;
          if (['pose', 'depth', 'canny'].includes(guide) && name !== structure.asset?.name)
            throw new Error('结构图已变化，请先在工作台重新读取并应用');
        }
        if (!valid()) return;
        widget.value = JSON.stringify(token); widget.callback?.(widget.value);
        app.graph.setDirtyCanvas(true, true); close();
      } catch (error) { send('anyangle-apply-error', { message: error.message }); }
    }
  };
  window.addEventListener('message', receive);
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  closeActive = close; dialog.showModal();
}

app.registerExtension({
  name: 'T8.AnyAngleStudio',
  afterConfigureGraph() {
    graphRevision++; closeActive?.();
    for (const node of app.graph._nodes) {
      if (node.comfyClass === 'AnyAngleStudioT8') {
        if (!node.inputs?.some(input => input.name === 'reference_image')) node.addInput('reference_image', 'IMAGE');
        if (!node.inputs?.some(input => input.name === 'structure_image')) node.addInput('structure_image', 'IMAGE');
        if (!node.outputs?.some(output => output.name === 'anyangle_lora_strength')) node.addOutput('anyangle_lora_strength', 'FLOAT');
      }
    }
  },
  async beforeRegisterNodeDef(nodeType, data) {
    if (data.name !== 'AnyAngleStudioT8') return;
    const created = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      created?.apply(this, arguments);
      const widget = this.widgets.find(w => w.name === 'snapshot');
      widget.type = 'converted-widget'; widget.computeSize = () => [0, -4];
      if (widget.inputEl) widget.inputEl.style.display = 'none';
      this.addWidget('button', '打开 AnyAngle Studio', null, () => openEditor(this, widget));
      this.color = '#173847'; this.bgcolor = '#111e28'; this.size = [345, 130];
      const removed = this.onRemoved;
      this.onRemoved = function () { closeActive?.(); removed?.apply(this, arguments); };
    };
  },
});
