import { uuid } from '../uuid.mjs?v=20261010lan1';

export function reconstructionGraph(reference, models, seed = 46, keepBackground = false) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  const graph = {
    '1': node('LoadImage', { image: `anyangle_studio/${reference.name}` }),
    '2': node('LoadBackgroundRemovalModel', { bg_removal_name: models.background_removal }),
    '3': node('RemoveBackground', { bg_removal_model: ['2', 0], image: ['1', 0] }),
    '4': node('TripoSplatPreprocessImage', { image: ['1', 0], mask: ['3', 0], erode_radius: 1, size: 1024 }),
    '5': node('CLIPVisionLoader', { clip_name: models.clip_vision }),
    '6': node('VAELoader', { vae_name: models.vae_encoder }),
    '7': node('TripoSplatConditioning', { clip_vision: ['5', 0], vae: ['6', 0], image: ['4', 0] }),
    '8': node('UNETLoader', { unet_name: models.diffusion_models, weight_dtype: 'default' }),
    '9': node('KSampler', { model: ['8', 0], positive: ['7', 0], negative: ['7', 1], latent_image: ['7', 2],
      seed, steps: 20, cfg: 3, sampler_name: 'dpmpp_2m', scheduler: 'simple', denoise: 1 }),
    '10': node('VAELoader', { vae_name: models.vae_decoder }),
    '11': node('VAEDecodeTripoSplat', { samples: ['9', 0], vae: ['10', 0], num_gaussians: 262144, seed }),
    '12': node('AnyAngleReconstructionOutputT8', { splat: ['11', 0], samples: ['9', 0], reference: ['1', 0], prepared: ['4', 0], mask: ['3', 0], keep_background: keepBackground }),
  };
  if (keepBackground) {
    delete graph['2'];
    graph['3'] = node('SolidMask', { value: 1, width: 1, height: 1 });
  }
  return graph;
}

const MODEL_SELECTION_KEY = 'anyangle-reconstruction.models.v1';

function reconstructionSource(item, reference) {
  const source = item?.outputs?.['12']?.anyangle_reconstruction?.[0]?.source;
  if (!source || source.reference?.name === reference.name) return source;
  const graph = item.prompt?.[2], load = graph?.['1'], output = graph?.['12'];
  // LoadImage drops alpha; its RGB re-export can have a different file hash.
  if (load?.class_type !== 'LoadImage' || load.inputs?.image !== `anyangle_studio/${reference.name}`
      || output?.class_type !== 'AnyAngleReconstructionOutputT8'
      || output.inputs?.reference?.[0] !== '1' || output.inputs.reference[1] !== 0
      || source.reference?.width !== reference.width || source.reference?.height !== reference.height)
    throw new Error('无法确认重建所用来源图，请重新重建；机位和构图可以自由调整');
  return { ...source, reference: { ...reference } };
}

export function selectedReconstructionModels() {
  try {
    const selected = JSON.parse(localStorage.getItem(MODEL_SELECTION_KEY));
    if (selected && typeof selected === 'object' && !Array.isArray(selected)) return selected;
  } catch { /* Use automatic discovery if browser preferences are unavailable. */ }
  return {};
}

export async function reconstructionConfig(selections = selectedReconstructionModels(), keepBackground = false) {
  const parameters = new URLSearchParams(selections);
  if (keepBackground) parameters.set('keep_background', '1');
  const query = parameters.toString();
  const response = await fetch('/anyangle-studio/reconstruction-config' + (query ? `?${query}` : ''));
  const config = await response.json();
  if (!response.ok) throw new Error(config.error || '无法检查本地重建模型，请确认 ComfyUI 服务正常运行');
  return config;
}

export async function saveReconstructionModels(selections, keepBackground = false) {
  const config = await reconstructionConfig(selections, keepBackground);
  localStorage.setItem(MODEL_SELECTION_KEY, JSON.stringify(selections));
  return config;
}

export async function reconstruct(reference, onProgress, retryStaleJob = true, keepBackground = false) {
  const selections = selectedReconstructionModels();
  const suffix = Object.keys(selections).length ? ':' + JSON.stringify(Object.fromEntries(Object.entries(selections).sort())) : '';
  const key = `anyangle-reconstruction:${reference.name}${suffix}${keepBackground ? ':keep-background' : ''}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* Ignore an incomplete browser save. */ }
  if (cached?.source && cached.source.reference?.name !== reference.name && !!cached.source.keep_background === keepBackground) {
    const response = await fetch('/history?max_items=200');
    if (response.ok) {
      const item = Object.values(await response.json()).find(item =>
        item.outputs?.['12']?.anyangle_reconstruction?.[0]?.source?.name === cached.source.name
        && item.prompt?.[2]?.['1']?.inputs?.image === `anyangle_studio/${reference.name}`);
      if (item) {
        try {
          cached = { source: reconstructionSource(item, reference) };
          localStorage.setItem(key, JSON.stringify(cached));
        } catch { localStorage.removeItem(key); cached = null; }
      }
    }
  }
  if (cached?.source?.reference?.name === reference.name) {
    const existing = await fetch(`/anyangle-studio/assets/${encodeURIComponent(cached.source.name)}`, { method: 'HEAD' });
    if (existing.ok && !!cached.source.keep_background === keepBackground) return cached.source;
    localStorage.removeItem(key); cached = null;
  }
  const config = await reconstructionConfig(selections, keepBackground);
  if (!config.available) {
    const hint = Object.keys(config.ambiguous || {}).length ? '发现多个同名文件，请在左侧「重建模型」手动选择。'
      : '请在左侧「重建模型」选择兼容权重，或运行节点目录中的 install_reconstruction.py。';
    throw new Error(`缺少或尚未选择本地重建模型：${config.missing.join('、')}。${hint}`);
  }
  let job = typeof cached === 'string' ? cached : cached?.job;
  if (!job) {
    const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: reconstructionGraph(reference, config.models, 46, keepBackground), client_id: uuid() }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || JSON.stringify(result.node_errors) || '重建任务提交失败');
    job = result.prompt_id; localStorage.setItem(key, JSON.stringify({ job }));
  }
  const started = Date.now();
  for (;;) {
    const historyResponse = await fetch(`/history/${encodeURIComponent(job)}`);
    if (!historyResponse.ok) throw new Error('无法读取重建结果，请检查 ComfyUI 服务');
    const item = (await historyResponse.json())[job];
    const result = item?.outputs?.['12']?.anyangle_reconstruction?.[0];
    if (result) {
      let source;
      try { source = reconstructionSource(item, reference); }
      catch (error) { localStorage.removeItem(key); throw error; }
      localStorage.setItem(key, JSON.stringify({ source }));
      return source;
    }
    if (item?.status?.status_str === 'error') {
      localStorage.removeItem(key);
      const detail = item.status.messages?.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || 'TripoSplat 重建失败');
    }
    const queueResponse = await fetch('/queue');
    if (!queueResponse.ok) throw new Error('无法读取重建队列，请检查 ComfyUI 服务');
    const queue = await queueResponse.json();
    const running = queue.queue_running.some(entry => entry[1] === job);
    const pending = queue.queue_pending.some(entry => entry[1] === job);
    if (!running && !pending && !item && Date.now() - started > 5000) {
      localStorage.removeItem(key);
      if (retryStaleJob) return reconstruct(reference, onProgress, false, keepBackground);
      throw new Error('重建任务已被移除，请重新重建');
    }
    onProgress(running ? `正在${keepBackground ? '保留背景重建' : '从原图重建主体'} · ${Math.round((Date.now() - started) / 1000)} 秒` : '重建任务排队中');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
