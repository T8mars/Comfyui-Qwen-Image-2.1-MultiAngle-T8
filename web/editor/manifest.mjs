import { visibleActors } from './actors.mjs?v=20261004mp1';
import { guideSource, guidePrompt } from './guides.mjs?v=20261004mp1';

export function actorMode(scene) {
  return scene.source?.kind === 'human' && scene.conditioning?.identityMode === 'actors' && scene.conditioning?.model === 'base'
    && (scene.conditioning.promptMode === 'custom' || !['image', 'canny-image'].includes(guideSource(scene).kind));
}
export function scenePrompt(scene, manifest = buildManifest(scene)) {
  if (actorMode(scene)) return actorPrompt(scene, manifest);
  const settings = scene.conditioning || {};
  const singleStructure = settings.model === 'base' && settings.identityMode === 'actors'
    && scene.source?.kind === 'human' && !manifest.references.length && settings.promptMode !== 'custom';
  return guidePrompt(singleStructure ? { ...settings, promptMode: 'single' } : settings, scene.source);
}
export function buildManifest(scene) {
  const settings = scene.conditioning || {}, multi = actorMode(scene);
  const order = settings.imageOrder || (multi ? 'guide-first' : 'reference-first');
  let references = []; const byName = new Map(), actors = [];
  for (const actor of multi ? visibleActors(scene) : []) {
    const identity = actor.identity || {}, asset = settings.promptMode === 'single' ? null : identity.asset, name = asset?.name;
    if (name && !byName.has(name)) { byName.set(name, references.length); references.push({ asset, actorIds: [] }); }
    if (name) references[byName.get(name)].actorIds.push(actor.id);
    actors.push({ id: actor.id, label: actor.label || actor.id, editorColor: actor.editorColor,
      description: identity.description || '', sourcePerson: identity.sourcePerson ?? null, inputKey: identity.inputKey ?? null,
      transform: actor.transform || {}, referenceName: name });
  }
  if (!multi && settings.promptMode !== 'single' && scene.reference) references = [{ asset: scene.reference, actorIds: [] }];
  const guideIndex = order === 'guide-first' || !references.length ? 1 : references.length + 1;
  references.forEach((reference, i) => { reference.index = (guideIndex > 1 ? 1 : 2) + i; });
  const indices = new Map(references.map(reference => [reference.asset.name, reference.index]));
  for (const actor of actors) { actor.referenceIndex = indices.get(actor.referenceName) ?? null; delete actor.referenceName; }
  const imageCount = references.length + 1;
  return { version: 1, imageOrder: order, guide: { index: guideIndex, width: scene.width, height: scene.height },
    references, actors, imageCount, warnings: imageCount > 10 ? ['超过 Qwen Image 2.1 官方说明的 10 张参考图范围，效果未验证。'] : [] };
}
const number = value => Number(value || 0).toString();
function sourcePersonText(source) {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return '';
  const parts = source.description ? [String(source.description)] : [];
  const box = source.bbox;
  if (Array.isArray(box) && box.length === 4 && box.every(value => typeof value === 'number' && Number.isFinite(value))) {
    let region = `selected source pixel region [${box.map(number).join(', ')}]`;
    const w = source.canvasWidth, h = source.canvasHeight;
    if ([w, h].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
      region += ` in a ${number(w)} x ${number(h)} image`;
      const normalized = box.map((value, index) => value / (index % 2 ? h : w));
      if (normalized.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) {
        const rounded = normalized.map(value => Math.sign(value) * Math.floor(Math.abs(value) * 1e6 + .5) / 1e6);
        region += ` (normalized region [${rounded.map(number).join(', ')}])`;
      }
    }
    parts.push(region);
  }
  return parts.join('; ');
}
export function actorPrompt(scene, manifest = buildManifest(scene)) {
  const settings = scene.conditioning || {}; if (settings.promptMode === 'custom') return settings.customPrompt ?? '';
  const guide = settings.guide || 'coarse', instructions = {
    coarse: 'camera angle, composition, body poses, scale and facing directions', pose: 'body poses, limb directions, position and framing',
    depth: 'spatial depth, layout and occlusion relationships', canny: 'silhouettes, contours and major edge layout',
  };
  const lines = [`Create one coherent scene with exactly ${manifest.actors.length} people.`,
    `Use <image${manifest.guide.index}> as the ${guide} guide for ${instructions[guide]}.`];
  for (const [index, actor] of manifest.actors.entries()) {
    const descriptor = actor.description.trim(), source = actor.sourcePerson;
    const sourceText = sourcePersonText(source);
    const identity = actor.referenceIndex ? `the character ${sourceText || ''} from <image${actor.referenceIndex}>`.replace(/  /g, ' ')
      : descriptor || `the person described as ${actor.label}`;
    const p = actor.transform;
    const location = `world position (${number(p.x)}, ${number(p.y)}, ${number(p.z)}), facing ${number(p.yaw)} degrees`;
    const color = guide === 'coarse' && settings.colorActors && actor.editorColor ? `${actor.editorColor} mannequin` : `person ${index + 1} in the guide`;
    lines.push(`Person ${index+1} (${actor.label}): use ${identity}; match the ${color}'s pose and placement (${location}).${descriptor && actor.referenceIndex ? ` ${descriptor}` : ''}`);
  }
  lines.push("Keep each person's face, hairstyle and clothing separate. Do not add extra people, mannequin colors, skeleton lines, labels or guide borders.");
  if (settings.promptExtra?.trim()) lines.push(settings.promptExtra.trim());
  return lines.join('\n');
}
