import { guideSource } from './guides.mjs?v=20261009v160';
export const USES = { free: '自由参考', identity: '身份 / 脸型', clothing: '服装', accessory: '配饰 / 产品', scene: '场景 / 背景', style: '风格 / 灯光', layout: '布局 / 构图' };
const copy = value => JSON.parse(JSON.stringify(value));
const uid = prefix => `${prefix}-${crypto.randomUUID()}`;
export const emptyLibrary = () => ({ version: 1, mode: 'guided', items: [], firstReferenceId: null, firstResolution: 0, templates: [] });
export function newUse(kind = 'free', target = { kind: 'scene', ids: [], text: '' }) {
  return { id: uid('use'), kind, target: copy(target), enabled: true, sourceText: '', instruction: '' };
}
export function addReference(scene, asset, values = {}) {
  const item = { id: uid('ref'), label: asset?.label || `参考 ${scene.referenceLibrary.items.length + 1}`, asset, enabled: true,
    inputKey: null, batchIndex: 0, batchCount: 1, usages: [newUse()], ...copy(values) };
  scene.referenceLibrary.items.push(item); return item;
}
export function upgradeReferences(scene) {
  if (scene.version === 3) return;
  const library = emptyLibrary(); scene.referenceLibrary = library; scene.version = 3;
  const byName = new Map();
  // Migrate only images actually used by the old route; keep static-guide behavior explicit.
  const oldActors = scene.source?.kind === 'human' && scene.conditioning?.identityMode === 'actors'
    && scene.conditioning.model === 'base' && (scene.conditioning.promptMode === 'custom' || !['image','canny-image'].includes(guideSource(scene).kind));
  if (oldActors) for (const actor of scene.actors || []) {
    if (actor.visible === false || scene.conditioning.promptMode === 'single' || !actor.identity?.asset) continue;
    let item = byName.get(actor.identity.asset.name);
    if (!item) { item = addReference(scene, actor.identity.asset, { inputKey: actor.identity.inputKey || null, usages: [] }); byName.set(item.asset.name, item); }
    const use = newUse('identity', { kind: 'actors', ids: [actor.id], text: '' });
    use.sourceText = typeof actor.identity.sourcePerson === 'string' ? actor.identity.sourcePerson : actor.identity.sourcePerson?.description || '';
    use.instruction = actor.identity.description || ''; item.usages.push(use);
  }
  else if (scene.reference && scene.conditioning?.promptMode !== 'single') addReference(scene, scene.reference);
}
export function updateReferences(scene, connected) {
  const items = scene.referenceLibrary.items, keys = new Set(connected.map(entry => entry.inputKey));
  for (const item of items) if (item.inputKey && !keys.has(item.inputKey)) item.missing = true;
  for (const entry of connected) {
    const matches = items.filter(item => item.inputKey === entry.inputKey);
    if (!matches.length) matches.push(addReference(scene, entry.asset || null, { label: entry.asset?.label || entry.inputKey,
      inputKey: entry.inputKey, missing: !entry.asset, batchCount: entry.batchCount || 1 }));
    for (const item of matches) {
      const asset = entry.assets?.[item.batchIndex || 0] || (!item.batchIndex ? entry.asset : null);
      if (asset?.name && item.asset?.name && asset.name !== item.asset.name) item.reviewSource = true;
      item.asset = asset || item.asset; item.missing = !asset; item.batchCount = entry.batchCount || entry.assets?.length || 1;
    }
  }
}
export function detachTargets(scene, kind, id) {
  for (const item of scene.referenceLibrary?.items || []) for (const use of item.usages) {
    if (use.target.kind === kind) use.target.ids = use.target.ids.filter(value => value !== id);
  }
}
export function sourceChanged(scene, previous) {
  if (scene.version !== 3 || previous?.name === scene.reference?.name) return;
  scene.sourceStale = scene.source?.kind === 'splat' && scene.source.reference?.name !== scene.reference?.name;
  if (scene.conditioning?.mapOrigin === 'da3' || scene.openpose?.origin === 'dwpose') {
    if (scene.conditioning.mapOrigin === 'da3') { scene.conditioning.mapReference ||= previous?.name; scene.conditioning.acceptStoredSource = false; }
    if (scene.openpose?.origin === 'dwpose') { scene.openpose.referenceName ||= previous?.name; scene.openpose.acceptStoredSource = false; }
    scene.derivedGuideStale = true;
    scene.derivedGuideSource = previous?.name || null;
  }
}
export function staleGuide(scene) {
  const settings = scene.conditioning || {}, guide = settings.model === 'anyangle' ? 'coarse' : settings.guide || 'coarse';
  const state = guide === 'depth' && settings.mapOrigin === 'da3' ? { name: settings.mapReference, accepted: settings.acceptStoredSource }
    : guide === 'pose' && scene.openpose?.origin === 'dwpose' && !scene.openpose.useRig ? { name: scene.openpose.referenceName, accepted: scene.openpose.acceptStoredSource } : null;
  return !!state && !state.accepted && (state.name ? state.name !== scene.reference?.name : scene.derivedGuideStale);
}
export function targetText(scene, target) {
  if (target.kind === 'scene') return 'the whole generated scene';
  if (target.kind === 'text') return target.text?.trim() || null;
  if (target.kind === 'actors' && scene.source?.kind !== 'human') return null;
  const objects = scene[target.kind === 'actors' ? 'actors' : 'props'] || [];
  return objects.filter(obj => target.ids?.includes(obj.id) && obj.visible !== false).map(obj => obj.label || obj.id).join(', ') || null;
}
export function libraryManifest(scene) {
  const library = scene.referenceLibrary, mode = library.mode || 'guided', settings = scene.conditioning || {};
  let references = []; const excluded = [], byName = new Map();
  for (const item of library.items) {
    const uses = item.usages.filter(use => use.enabled !== false).map(use => ({ ...use, targetText: targetText(scene, use.target) })).filter(use => use.targetText);
    const reason = item.enabled === false ? '素材已停用' : mode === 'text' ? '纯文本模式不发送图片'
      : (settings.model || 'anyangle') === 'anyangle' ? '当前 AnyAngle 双图模式未发送；切换 Qwen 多图创作可使用'
        : !uses.length ? '用途已停用或目标待重新分配' : !item.asset || item.missing ? '连线或素材缺失，请重新读取或明确使用保存版本' : null;
    if (reason) { excluded.push({ id: item.id, label: item.label || item.id, reason }); continue; }
    const name = item.asset.name;
    if (!byName.has(name)) { byName.set(name, references.length); references.push({ asset: item.asset, referenceIds: [], labels: [], usages: [], actorIds: [] }); }
    const entry = references[byName.get(name)]; entry.referenceIds.push(item.id); entry.labels.push(item.label || item.id); entry.usages.push(...uses);
    entry.actorIds = [...new Set([...entry.actorIds, ...uses.filter(use => use.target.kind === 'actors').flatMap(use => use.target.ids || [])])];
  }
  if ((settings.model || 'anyangle') === 'anyangle' && scene.reference) references = [{ asset: scene.reference, referenceIds: ['scene-source'], labels: ['场景来源图'], usages: [], actorIds: [] }];
  const first = library.firstReferenceId;
  if (mode === 'references-only' && first) {
    const selected = references.find(entry => entry.referenceIds.includes(first));
    if (selected) references = [selected, ...references.filter(entry => entry !== selected)];
  }
  const order = settings.imageOrder || 'guide-first';
  const guide = mode === 'guided' ? { index: order === 'guide-first' || !references.length ? 1 : references.length + 1, width: scene.width, height: scene.height } : null;
  references.forEach((reference, i) => { reference.index = i + (guide?.index === 1 ? 2 : 1); reference.resolution = mode === 'references-only' && !i ? library.firstResolution || 0 : 'reference'; });
  const imageCount = references.length + (guide ? 1 : 0);
  const kind = settings.guide || 'coarse', staticGuide = kind !== 'coarse' && (settings.map && (settings.mapKind || kind) === kind || kind === 'canny' && scene.reference && settings.mapOrigin !== 'auto');
  return { version: 2, mode, imageOrder: order, guide, references,
    actors: (scene.actors || []).filter(actor => !staticGuide && scene.source?.kind === 'human' && actor.visible !== false).map(actor => ({ id: actor.id, label: actor.label || actor.id, transform: actor.transform || {}, editorColor: actor.editorColor ?? null, description: actor.identity?.description || '' })),
    imageCount, excluded, missing: excluded.filter(entry => entry.reason.startsWith('连线')).map(entry => entry.label),
    warnings: imageCount > 10 ? ['超过 Qwen Image 2.1 官方建议的 10 图范围，图片仍完整发送；请留意效果和显存。'] : [] };
}
export function libraryPrompt(scene, manifest) {
  const settings = scene.conditioning || {};
  if (settings.promptMode === 'custom') return settings.customPrompt ?? '';
  const lines = [], guide = manifest.guide;
  if (guide) {
    const instructions = { coarse: 'camera angle, composition, poses and placement', pose: 'body poses, limb directions, position and framing', depth: 'spatial depth, layout and occlusion', canny: 'silhouettes, contours and major edges' };
    const kind = settings.guide || 'coarse';
    lines.push(`Create a finished image following the ${instructions[kind]} in <image${guide.index}>. Do not render guide marks, mannequin colors or skeleton lines.`);
    if (manifest.actors.length) {
      lines.push(`The guide contains ${manifest.actors.length} people. Keep their identities and placements separate.`);
      manifest.actors.forEach((actor, index) => {
        const color = kind === 'coarse' && settings.colorActors && actor.editorColor ? ` (${actor.editorColor} mannequin)` : '';
        lines.push(`Person ${index + 1}${color} in the guide is ${actor.label}.${actor.description?.trim() ? ` ${actor.description.trim()}` : ''}`);
      });
    }
  } else if (manifest.mode === 'references-only') lines.push('Create one coherent finished image using the references only for their specified purposes.');
  const rules = { free: 'Use the relevant content as a general reference', identity: 'Use only the face identity and hairstyle; do not copy the clothing, pose or background',
    clothing: "Use only the clothing design; do not copy the model's identity, pose or background", accessory: 'Use only the accessory or product design; do not add people from this reference',
    scene: 'Use the environment and background; do not add people from this reference', style: 'Use the visual style, lighting and color palette; do not copy the subject or pose', layout: 'Use the arrangement and composition; do not copy subject identities' };
  for (const reference of manifest.references) for (const use of reference.usages || []) {
    const source = use.sourceText?.trim() ? ` Source content: ${use.sourceText.trim()}.` : '', extra = use.instruction?.trim() ? ` ${use.instruction.trim()}` : '';
    lines.push(`<image${reference.index}>: ${rules[use.kind]} for ${use.targetText}.${source}${extra}`);
  }
  if (settings.promptExtra?.trim()) lines.push(settings.promptExtra.trim());
  return lines.join('\n');
}
