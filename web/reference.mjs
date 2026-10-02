// Work from ComfyUI's executable graph so reroutes and bypassed nodes resolve normally.
export function referencePlan(output, nodeId, inputName = 'reference_image') {
  const link = output[String(nodeId)]?.inputs?.[inputName];
  if (!link) return null;
  const upstream = {};
  function visit(id) {
    id = String(id);
    if (upstream[id]) return;
    const node = output[id];
    if (!node) throw new Error('参考图上游节点不可执行，请检查连线');
    upstream[id] = node;
    for (const value of Object.values(node.inputs)) {
      if (Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]) && output[value[0]]) visit(value[0]);
    }
  }
  visit(link[0]);
  const source = output[link[0]];
  const filename = source.class_type === 'LoadImage' && link[1] === 0 && typeof source.inputs.image === 'string' ? source.inputs.image : null;
  return { link, upstream, filename, signature: JSON.stringify({ link, upstream }) };
}

export function imageViewURL(filename, type = 'input', subfolder = '') {
  const annotated = filename.match(/ \[(input|output|temp)\]$/);
  if (annotated) { type = annotated[1]; filename = filename.slice(0, -annotated[0].length); }
  return '/view?' + new URLSearchParams({ filename, type, subfolder });
}

export async function importReference(url) {
  if (typeof url !== 'string') throw new Error('无效的参考图地址');
  const target = new URL(url, location.origin);
  if (target.origin !== location.origin || target.pathname !== '/view' || target.username || target.password)
    throw new Error('参考图仅支持当前 ComfyUI 的图像地址');
  const image = await fetch(target.href, { cache: 'no-store', mode: 'same-origin', redirect: 'error' });
  if (!image.ok) throw new Error('无法读取连线原图，请检查上游文件');
  const form = new FormData(); form.append('file', await image.blob(), 'reference.png');
  const response = await fetch('/anyangle-studio/assets', { method: 'POST', body: form });
  const asset = await response.json();
  if (!response.ok) throw new Error(asset.error || '参考图导入失败');
  return asset;
}

export async function executeReference(plan, isActive) {
  const previewId = 'anyangle_reference_' + crypto.randomUUID();
  const prompt = { ...plan.upstream, [previewId]: { class_type: 'PreviewImage', inputs: { images: plan.link } } };
  const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) });
  const queued = await response.json();
  if (!response.ok) throw new Error(queued.error?.message || '上游图像执行失败，请检查上游节点');
  let polls = 0;
  while (isActive()) {
    await new Promise(resolve => setTimeout(resolve, 1000));
    const response = await fetch(`/history/${encodeURIComponent(queued.prompt_id)}`);
    if (!response.ok) throw new Error('无法读取上游执行结果，请重新读取');
    const item = (await response.json())[queued.prompt_id];
    if (!item) {
      if (++polls % 5 === 0) {
        const queueResponse = await fetch('/queue');
        if (!queueResponse.ok) throw new Error('无法读取执行队列，请重新读取');
        const queue = await queueResponse.json();
        if (![...queue.queue_running, ...queue.queue_pending].some(entry => entry[1] === queued.prompt_id)) {
          // A completed job may have moved into history between these requests.
          const final = await fetch(`/history/${encodeURIComponent(queued.prompt_id)}`);
          if (!(await final.json())[queued.prompt_id]) throw new Error('上游任务已从队列移除，请重新读取');
        }
      }
      continue;
    }
    if (item.status?.status_str === 'error') {
      const detail = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || '上游执行失败或已取消');
    }
    const image = item.outputs?.[previewId]?.images?.[0];
    if (image) return importReference(imageViewURL(image.filename, image.type, image.subfolder));
    throw new Error('上游没有输出可用图像');
  }
  return null;
}
