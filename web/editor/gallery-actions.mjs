import { installGalleryKeypoints } from './gallery-keypoints.mjs?v=20261029v180';
import { poseCopyIssue } from './openpose.mjs?v=20261009v160';
import { applyGalleryPose, galleryPoseGuide, galleryViewPlan } from './gallery-pose.mjs?v=20261029v180';
import { libraryManifest } from './reference-library.mjs?v=20261029v180';

const assetURL = asset => `/anyangle-studio/assets/${encodeURIComponent(asset.name)}`;
function modal(title) {
  const dialog = document.createElement('dialog'); dialog.className = 'pose-library-dialog pg-action-dialog';
  const heading = document.createElement('h2'); heading.textContent = title;
  const status = document.createElement('p'); status.className = 'hint'; status.setAttribute('role', 'status');
  const actions = document.createElement('div'); actions.className = 'compact-actions';
  const close = document.createElement('button'); close.type = 'button'; close.textContent = '取消'; close.onclick = () => dialog.close();
  dialog.append(heading, status, actions, close); document.body.append(dialog);
  return { dialog, status, actions, close };
}
function check(text) {
  const label = document.createElement('label'), input = document.createElement('input');
  input.type = 'checkbox'; label.className = 'option-toggle'; label.append(input, document.createTextNode(text));
  return { label, input };
}
function action(text, callback) {
  const button = document.createElement('button'); button.type = 'button'; button.textContent = text; button.onclick = callback;
  return button;
}

export function installGalleryActions(context) {
  const requests = new Set();
  async function extract(asset, provenance, expectedPeople) {
    const { dialog, status, actions, close } = modal('提取图库姿势 · 预览与人物映射');
    const controller = new AbortController(); requests.add(controller);
    const views = document.createElement('div'); views.className = 'pg-detection-images';
    const original = new Image(); original.alt = '所选图库原图'; original.src = assetURL(asset); views.append(original);
    dialog.insertBefore(views, status);
    const targets = document.createElement('div'); targets.className = 'pg-detection-targets'; dialog.insertBefore(targets, actions);
    const layout = check('匹配来源横向站位、人物大小并重新取景（默认保留当前站位和机位）');
    const release = check('允许解除被修改人物的现有接触关系');
    dialog.insertBefore(layout.label, actions); dialog.insertBefore(release.label, actions);
    let detection, applying = false, applied = false, detecting = false;
    const selectors = [];
    const editorHost = document.createElement('section'); dialog.insertBefore(editorHost, targets);
    const editor = installGalleryKeypoints(editorHost, asset, () => {
      renderTargets(editor.people()); skeleton.hidden = true;
      status.textContent = '已修改关节，请核对原图上的彩色骨架；确认后才写入当前场景。';
    });
    const skeleton = new Image(); skeleton.alt = '提取或修正后的骨架'; skeleton.hidden = true; views.append(skeleton);
    async function requestDetection(payload) {
      const response = await fetch('/anyangle-studio/pose-people', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload), signal: controller.signal });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '姿势检测失败');
      if (!result.people?.length || !result.asset) throw new Error('没有检测到人物；可框选人物、手动标点或将原图作为动作参考使用');
      return result;
    }
    const apply = mode => async () => {
      if (applying || detecting || !editor.people().some(person => Object.keys(person.points || {}).length)) return;
      applying = true; actions.inert = true; targets.inert = true; close.disabled = true; editor.setBusy(true);
      const mapping = selectors.map(select => select.disabled ? '' : select.value);
      const options = { matchLayout: layout.input.checked, releaseContacts: release.input.checked };
      layout.input.disabled = release.input.disabled = true;
      try {
        if (editor.edited() || !detection) detection = await requestDetection({ keypoints: editor.frame() });
        await context.run(async () => {
          if (mode === 'guide') {
            const scene = galleryPoseGuide(context.doc(), detection, provenance);
            context.begin(); context.replace(scene); context.studio().doc = scene; context.changed();
          } else await applyGalleryPose(context, detection, mapping, provenance, options);
        });
        applied = true; dialog.close();
        context.toast(mode === 'guide' ? '已使用此视角的静态 POSE 引导；来源图与人物身份保留' : '已复制可见关节；二维图无法确定的肢体深度可继续手动调整');
      } catch (error) { status.textContent = error.message; }
      finally { applying = false; actions.inert = false; targets.inert = false; close.disabled = false; layout.input.disabled = release.input.disabled = false; editor.setBusy(false); }
    };
    const guide = action('使用预览中的静态 POSE 引导', apply('guide'));
    const copy = action('确认复制到指定人物', apply('rig'));
    guide.disabled = copy.disabled = true; actions.append(guide, copy);
    function renderTargets(people, reset = false) {
      const previous = reset ? [] : selectors.map(select => select.value); selectors.length = 0; targets.replaceChildren();
      const actors = (context.doc().actors || []).filter(actor => actor.visible !== false && !actor.locked);
      for (const [index, person] of people.entries()) {
        const label = document.createElement('label'), select = document.createElement('select');
        const issue = poseCopyIssue(person.points || {});
        label.textContent = `人物 ${index + 1}${person.fullBody === false ? ' · 半身 / 遮挡' : ''}${person.lowConfidence ? ' · 低置信度' : ''}${issue ? ' · ' + issue : ''}`;
        select.setAttribute('aria-label', `人物 ${index + 1} 复制目标`);
        select.append(new Option('不复制此人', ''), new Option('新增人偶', 'new'), ...actors.map(actor => new Option(actor.label, actor.id)));
        select.value = issue ? '' : previous[index] || ''; select.disabled = !!issue;
        selectors.push(select); label.append(select); targets.append(label);
      }
      const editable = ['human', 'empty'].includes(context.doc().source.kind);
      guide.disabled = !people.some(person => Object.keys(person.points || {}).length);
      copy.disabled = !editable || !selectors.length || selectors.every(select => select.disabled);
    }
    async function detect(regions) {
      if(detecting || applying)return;
      detecting = true; editor.setBusy(true); actions.inert = true;
      status.textContent = regions ? '正在按选框提取；重叠人物的关节可能混淆，请核对并修正。' : '正在运行 DWPose 检测；首次使用需要检测模型。可取消，不会改动场景。';
      try {
        const result = await requestDetection({ reference: asset.name, ...(regions ? { regions } : {}) });
        if (!dialog.open) return;
        detection = result; editor.setPeople(result.people); renderTargets(result.people, true);
        skeleton.src = assetURL(result.asset); skeleton.hidden = false;
        status.textContent = `提取 ${result.people.length} 人${result.people.length !== expectedPeople ? '，与图库标注人数不同，请检查漏检或误检' : ''}。自动检测按从左至右编号，框选按画框次序编号；先核对骨架，再逐人指定目标。`;
      } catch(error) {
        if(dialog.open && error.name !== 'AbortError') { status.textContent = error.message + '。可在下方框选区域重试，或手动标注可见关节。'; editor.open(); }
      } finally { detecting=false;editor.setBusy(false);actions.inert=false; }
    }
    editor.bar.append(action('按框提取姿势', () => {
      if(!editor.regions().length){status.textContent='请先拖动框选人物，或点击“整张图作为单人区域”';return;}
      detect(editor.regions());
    }));
    dialog.addEventListener('cancel', event => { if (applying) event.preventDefault(); });
    const done = new Promise(resolve => dialog.addEventListener('close', () => {
      controller.abort(); requests.delete(controller); dialog.remove(); resolve(applied);
    }, { once: true }));
    dialog.showModal(); await detect();
    return done;
  }

  async function batch(rows, target) {
    const { dialog, status, actions, close } = modal(`图库视角批量 · ${rows.length} 张`);
    const mode = document.createElement('select'); mode.setAttribute('aria-label', '视角批量创作方式');
    mode.append(new Option('以图库动作为参考 · 不附加当前构图引导', 'references-only'), new Option('保留当前构图引导 + 图库动作参考', 'guided'));
    dialog.insertBefore(mode, status);
    status.textContent = '每个任务使用一个实际视角，保留其他参考和文字。切换 Qwen 底模；完成或停止后恢复当前草稿。队列任务使用多人编码节点的提示词方式，建议选择“studio-plus-input”让动作用途生效。';
    const list = document.createElement('ul'); list.className = 'pg-batch-summary';
    for (const row of rows) { const item = document.createElement('li'); item.textContent = row.asset.label || row.source.viewId; list.append(item); }
    dialog.insertBefore(list, actions);
    let controller = null, running = false, result = null;
    const receipt = action('下载批量回执', () => context.download(new Blob([JSON.stringify(result, null, 2)], { type: 'application/json' }), 'anyangle-gallery-batch.json'));
    receipt.disabled = true;
    const start = queue => async () => {
      if (running) return;
      running = true; actions.inert = true; mode.disabled = true; close.textContent = '停止后续任务';
      controller = new AbortController(); requests.add(controller);
      try {
        // Validate the complete plan before the first snapshot or queue operation.
        context.studio().syncPose();
        const plan = galleryViewPlan(context.doc(), rows, target, mode.value), previews = [...plan.views()];
        const warnings = [...new Set(previews.flatMap(view => libraryManifest(view.scene).warnings || []))];
        await context.run(async () => { result = await context.runBatch(plan, queue, controller.signal, progress => {
          status.textContent = `${progress.phase === 'capture' ? '准备' : '已处理'} ${progress.index}${progress.phase === 'capture' ? ' → ' + (progress.index + 1) : ''} / ${progress.total} · ${progress.label}`;
        }); });
        status.textContent = `${result.error ? '已中止：' + result.error.message : result.stopped ? '已停止后续任务' : '批量完成'} · 已保存 ${result.views.length}，已入队 ${result.views.filter(row => row.prompt_id).length}。当前草稿已恢复。${warnings.join(' ')}`;
        result = { version: 1, kind: 'anyangle-gallery-batch', ...result, error: result.error?.message || null };
        receipt.disabled = !result.views.length;
      } catch (error) { status.textContent = error.message; }
      finally { requests.delete(controller); running = false; actions.inert = false; mode.disabled = false; close.textContent = '关闭'; }
    };
    const save = action('仅保存场景快照', start(false)), queue = action('保存并加入 ComfyUI 队列', start(true));
    queue.disabled = !context.canQueue;
    if (!context.canQueue) queue.title = '请从 ComfyUI 节点打开 Studio 后入队；独立工作台可保存快照';
    actions.append(save, queue, receipt);
    close.onclick = () => running ? controller.abort() : dialog.close();
    dialog.addEventListener('cancel', event => { if (running) { event.preventDefault(); controller.abort(); } });
    const done = new Promise(resolve => dialog.addEventListener('close', () => { dialog.remove(); resolve(result); }, { once: true }));
    dialog.showModal(); return done;
  }
  return { extract, batch, destroy() { for (const request of requests) request.abort(); requests.clear(); } };
}
