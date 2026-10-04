import { parseMorphPack } from '../vendor/vnccs_pose_morph_runtime.mjs';

export class HumanAssetError extends Error {
  constructor(message) { super(message); this.name = 'HumanAssetError'; }
}

export async function loadHumanPack(timeout = 45000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(new URL('../vendor/assets/pose_studio_makehuman.v2.bin', import.meta.url),
      { signal: controller.signal, cache: 'no-cache' });
    if (!response.ok) throw new HumanAssetError(response.status === 404
      ? '本机缺少内置人偶文件（HTTP 404）。请修复人偶资源后重试。'
      : `人偶文件读取失败（HTTP ${response.status}），请检查 ComfyUI 的访问权限。`);
    return parseMorphPack(await response.arrayBuffer());
  } catch (error) {
    if (error instanceof HumanAssetError) throw error;
    throw new HumanAssetError(controller.signal.aborted ? '读取本地人偶资源超时，请重试或修复资源。'
      : `人偶资源无法读取或已损坏：${error.message}`);
  } finally { clearTimeout(timer); }
}
