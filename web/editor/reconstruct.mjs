export function reconstructionGraph(reference, models, seed = 46) {
  const node = (class_type, inputs) => ({ class_type, inputs });
  return {
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
    '12': node('AnyAngleReconstructionOutputT8', { splat: ['11', 0], samples: ['9', 0], reference: ['1', 0], prepared: ['4', 0], mask: ['3', 0] }),
  };
}

export async function reconstruct(reference, onProgress) {
  const key = `anyangle-reconstruction:${reference.name}`;
  let cached;
  try { cached = JSON.parse(localStorage.getItem(key)); } catch { /* Ignore an incomplete browser save. */ }
  if (cached?.source?.reference?.name === reference.name) {
    const existing = await fetch(`/anyangle-studio/assets/${encodeURIComponent(cached.source.name)}`, { method: 'HEAD' });
    if (existing.ok) return cached.source;
    localStorage.removeItem(key); cached = null;
  }
  const config = await (await fetch('/anyangle-studio/reconstruction-config')).json();
  if (!config.available) throw new Error(`缺少本地重建模型：${config.missing.join('、')}。请运行节点目录中的 install_reconstruction.py。`);
  let job = typeof cached === 'string' ? cached : cached?.job;
  if (!job) {
    const response = await fetch('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: reconstructionGraph(reference, config.models), client_id: crypto.randomUUID() }) });
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
      localStorage.setItem(key, JSON.stringify({ source: result.source }));
      return result.source;
    }
    if (item?.status?.status_str === 'error') {
      localStorage.removeItem(key);
      const detail = item.status.messages.find(([type]) => type === 'execution_error')?.[1];
      throw new Error(detail?.exception_message || 'TripoSplat 重建失败');
    }
    const queue = await (await fetch('/queue')).json();
    const running = queue.queue_running.some(entry => entry[1] === job);
    const pending = queue.queue_pending.some(entry => entry[1] === job);
    if (!running && !pending && !item && Date.now() - started > 5000) {
      localStorage.removeItem(key); throw new Error('重建任务已被移除，请重新重建');
    }
    onProgress(running ? `正在从原图重建主体 · ${Math.round((Date.now() - started) / 1000)} 秒` : '重建任务排队中');
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}
