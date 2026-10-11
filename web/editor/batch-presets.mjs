import { parseAngleList } from './batch.mjs?v=20261011v166';

const STORAGE_KEY = 'anyangle-studio.camera-batch.v1';
const $ = id => document.getElementById(id);
const fields = ['mode', 'angles', 'start', 'end', 'step'];

export function readCameraPresets(data) {
  if (data?.version !== 1 || data.kind !== 'anyangle-camera-presets' || !Array.isArray(data.presets))
    throw new Error('请选择 AnyAngle 导出的角度预设 JSON');
  return data.presets.map(preset => {
    if (typeof preset?.name !== 'string' || !preset.name.trim() || preset.name.trim().length > 48)
      throw new Error('预设名称需为 1–48 个字符');
    return { name: preset.name.trim(), angles: parseAngleList(preset.angles) };
  });
}

export function installBatchPresets({ askName, download, toast, onChange }) {
  const readSettings = () => Object.fromEntries(fields.map(key => [key, $(`batch-${key}`).value]));
  let state = { version: 1, kind: 'anyangle-camera-presets', presets: [], settings: readSettings() };
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const data = JSON.parse(stored), presets = readCameraPresets(data);
      state = { ...state, presets };
      if (['angles', 'range', 'saved'].includes(data.settings?.mode)) {
        for (const key of fields) if (typeof data.settings[key] === 'string') $(`batch-${key}`).value = data.settings[key];
      }
    }
  } catch { toast('未能读取批量机位预设，当前可继续设置或导入 JSON'); }
  const selected = () => $('batch-preset').value === '' ? -1 : Number($('batch-preset').value);
  const render = (index = -1) => {
    $('batch-preset').replaceChildren(new Option('选择已保存的角度预设', ''), ...state.presets.map((preset, i) => new Option(`${preset.name} · ${preset.angles.length} 个角度`, String(i))));
    $('batch-preset').value = index < 0 ? '' : String(index);
    $('batch-preset-delete').disabled = index < 0;
    $('batch-preset-export').disabled = !state.presets.length;
  };
  const persist = (next, settings = readSettings()) => {
    const saved = { ...next, settings };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); state = saved;
  };
  for (const key of fields) $(`batch-${key}`).addEventListener('input', () => {
    if (key === 'angles') render();
    try { persist(state); } catch { toast('浏览器未能保存批量设置，可导出预设 JSON 备份'); }
  });
  $('batch-preset').onchange = () => {
    const index = selected(), preset = state.presets[index]; render(index);
    if (!preset) return;
    $('batch-mode').value = 'angles'; $('batch-angles').value = preset.angles.join(', '); onChange();
    try { persist(state); } catch { toast('预设已载入，但浏览器未能记住本次设置'); }
  };
  $('batch-preset-save').onclick = async () => {
    try {
      const angles = parseAngleList($('batch-angles').value), name = await askName('保存角度预设', state.presets[selected()]?.name || '常用四向');
      if (!name) return;
      const presets = [...state.presets], existing = presets.findIndex(preset => preset.name === name), index = existing < 0 ? presets.length : existing;
      presets[index] = { name, angles }; persist({ ...state, presets }); render(index); toast(existing < 0 ? '角度预设已保存到当前浏览器' : '同名角度预设已更新');
    } catch (error) { toast(`未保存预设：${error.message}`); }
  };
  $('batch-preset-delete').onclick = () => {
    const index = selected(); if (index < 0) return;
    try { persist({ ...state, presets: state.presets.filter((_, i) => i !== index) }); render(); toast('角度预设已删除，当前角度列表保留'); }
    catch { toast('删除失败，浏览器未能保存预设'); }
  };
  $('batch-preset-export').onclick = () => download(new Blob([JSON.stringify({ version: 1, kind: state.kind, presets: state.presets }, null, 2)], { type: 'application/json' }), 'anyangle-camera-presets.json');
  $('batch-preset-import').onclick = () => $('batch-preset-file').click();
  $('batch-preset-file').onchange = async event => {
    const file = event.target.files[0]; event.target.value = ''; if (!file) return;
    try {
      const presets = readCameraPresets(JSON.parse(await file.text()));
      if (!presets.length) throw new Error('文件中没有角度预设');
      const names = new Set(state.presets.map(preset => preset.name));
      for (const preset of presets) {
        const original = preset.name; let number = 2;
        while (names.has(preset.name)) { const suffix = ` (${number++})`; preset.name = original.slice(0, 48 - suffix.length) + suffix; }
        names.add(preset.name);
      }
      const index = state.presets.length, settings = { ...readSettings(), mode: 'angles', angles: presets[0].angles.join(', ') };
      persist({ ...state, presets: [...state.presets, ...presets] }, settings);
      $('batch-mode').value = settings.mode; $('batch-angles').value = settings.angles;
      render(index); onChange(); toast(`已导入 ${presets.length} 个角度预设 · 同名预设自动编号`);
    } catch (error) { toast(`导入失败：${error.message}`); }
  };
  render();
}
