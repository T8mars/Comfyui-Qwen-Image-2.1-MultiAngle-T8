import { guideSource } from './guides.mjs';

export function supportsCameraBatch(scene) {
  const kind = guideSource(scene).kind;
  return scene.source.kind !== 'empty' && (['scene', 'canny-scene'].includes(kind) || kind === 'pose' && scene.source.kind === 'human');
}

const wrapAngle = value => ((value + 180) % 360 + 360) % 360 - 180;

export function cameraBatchPlan(scene, settings) {
  if (!supportsCameraBatch(scene)) throw new Error('批量机位需要三维主体及粗图、三维人偶骨架或三维 Canny；原图结构图保持原机位。');
  const base = structuredClone(scene);
  if (settings.mode === 'saved') {
    if (!base.shots.length) throw new Error('请先收藏至少一个机位');
    return { count: base.shots.length, *views() {
      for (const shot of base.shots) yield { label: shot.name || '收藏机位', scene: { ...structuredClone(base),
        camera: { ...base.camera, ...shot.camera }, width: shot.width, height: shot.height } };
    } };
  }
  const { start, end, step } = settings;
  if (![start, end, step].every(Number.isFinite) || step === 0 || (end - start) * step < 0)
    throw new Error('请输入有限的起止角度和非零步长；步长方向需与起止角度一致');
  let count = Math.floor((end - start) / step + 1e-9) + 1;
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('机位数量超出可计算范围，请调整步长');
  if (count > 1 && Math.abs(wrapAngle(start + (count - 1) * step) - wrapAngle(start)) < 1e-7) count--;
  return { count, *views() {
    for (let i = 0; i < count; i++) {
      const angle = wrapAngle(start + i * step), current = structuredClone(base);
      current.camera.azimuth = angle;
      yield { label: `方位角 ${Number(angle.toFixed(6))}°`, scene: current };
    }
  } };
}

// Persist one guide at a time so a 360-view run never retains all PNGs in memory.
export async function runCameraBatch(plan, { capture, save, queue, signal, onProgress = () => {} }) {
  const result = { views: [], stopped: false, error: null };
  for (const view of plan.views()) {
    if (signal?.aborted) { result.stopped = true; break; }
    onProgress({ index: result.views.length, total: plan.count, label: view.label, phase: 'capture' });
    try {
      const png = await capture(view.scene);
      if (signal?.aborted) { result.stopped = true; break; }
      const snapshot = await save(view.scene, png);
      const entry = { label: view.label, snapshot, camera: view.scene.camera, width: view.scene.width, height: view.scene.height };
      result.views.push(entry);
      if (signal?.aborted) { result.stopped = true; break; }
      if (queue) entry.prompt_id = await queue(snapshot);
      onProgress({ index: result.views.length, total: plan.count, label: view.label, phase: queue ? 'queued' : 'saved' });
    } catch (error) { result.error = error; break; }
  }
  return result;
}
