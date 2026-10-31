import { createActor, bindActor, ensureActors } from './actors.mjs?v=20261010lan1';
import { poseCopyIssue } from './openpose.mjs?v=20261009v160';
import { addReference, newUse, upgradeReferences, libraryManifest } from './reference-library.mjs?v=20261029v180';

const clone = value => structuredClone(value);

// Detection slots are explicit: an empty target is ignored, "new" creates one role.
export function prepareGalleryPose(scene, detection, mapping, options = {}) {
  if (!Array.isArray(mapping) || mapping.length !== detection.people?.length) throw new Error('人物映射与检测结果不一致');
  if (!['human', 'empty'].includes(scene.source?.kind)) throw new Error('请先切换到人偶场景，再复制图库动作；也可直接使用静态 POSE 引导图');
  const result = clone(scene), assignments = [], seen = new Set();
  ensureActors(result);
  for (const [index, target] of mapping.entries()) {
    if (!target) continue;
    const person = detection.people[index], issue = poseCopyIssue(person.points || {});
    if (issue) throw new Error(`检测人物 ${index + 1}：${issue}`);
    let actor;
    if (target === 'new') {
      actor = createActor(result.actors.length); result.actors.push(actor);
    } else {
      actor = result.actors.find(role => role.id === target);
      if (!actor || actor.visible === false || actor.locked) throw new Error('所选人物不可编辑，请重新选择目标');
      if (seen.has(target)) throw new Error('同一个人物不能接收两套动作，请分别指定目标');
    }
    seen.add(actor.id);
    assignments.push({ actorId: actor.id, person: clone(person), index });
  }
  if (!assignments.length) throw new Error('请至少指定一个目标人物');
  const touches = (result.contacts || []).filter(contact => contact.actors?.some(id => seen.has(id)));
  if (touches.length && !options.releaseContacts) throw new Error(`这些人物有 ${touches.length} 项接触关系，请确认解除后再复制`);
  result.contacts = (result.contacts || []).filter(contact => !contact.actors?.some(id => seen.has(id)));
  if (options.matchLayout) {
    const heights = assignments.filter(row => row.person.fullBody && row.person.bbox).map(row => row.person.bbox[3] - row.person.bbox[1]).filter(value => value > 0);
    const scale = heights.length ? 20 / Math.max(...heights) : 30 / (detection.height || 1024);
    for (const { actorId, person } of assignments) {
      const actor = result.actors.find(row => row.id === actorId), box = person.bbox;
      if (!box) continue;
      actor.transform.x = ((box[0] + box[2]) / 2 - (person.canvasWidth || detection.width || 1024) / 2) * scale;
      if (person.fullBody) actor.transform.scale = Math.max(.25, (box[3] - box[1]) * scale / 20);
    }
  }
  result.source = { kind: 'human' };
  result.activeActorId = assignments[0].actorId;
  result.selectedActorIds = assignments.map(row => row.actorId);
  bindActor(result);
  return { scene: result, assignments };
}

export async function applyGalleryPose(context, detection, mapping, provenance, options = {}) {
  context.studio().syncPose();
  const previous = clone(context.doc());
  const prepared = prepareGalleryPose(previous, detection, mapping, options);
  const rollback = context.begin();
  try {
    context.replace(prepared.scene);
    await context.studio().restore(prepared.scene);
    for (const row of prepared.assignments) {
      await context.studio().selectActor(row.actorId);
      context.studio().applyOpenPose(row.person.points, {}, 'conservative');
      const actor = prepared.scene.actors.find(role => role.id === row.actorId);
      actor.poseSource = { origin: 'gallery', useRig: true, rawAsset: detection.asset, points: clone(row.person.points),
        fullBody: row.person.fullBody, retargetMode: 'conservative', gallerySource: clone(provenance) };
      delete actor.poseRandom; delete prepared.scene.poseRandom;
    }
    await context.studio().selectActor(prepared.assignments[0].actorId);
    const scene = prepared.scene;
    scene.openpose = { origin: 'gallery', useRig: true, rawAsset: detection.asset, people: clone(detection.people), gallerySource: clone(provenance) };
    Object.assign(scene.conditioning, { model: 'base', guide: 'pose', map: null, mapKind: null, mapOrigin: 'rig' });
    upgradeReferences(scene); scene.referenceLibrary.mode = 'guided';
    if (options.matchLayout) {
      context.studio().groundActors(prepared.assignments.map(row => row.actorId));
      scene.camera.azimuth = 0; scene.camera.elevation = 0; context.studio().fit();
    }
    await context.ensureHumanTools();
    context.changed();
    return prepared;
  } catch (error) {
    context.replace(previous); rollback?.();
    try { await context.studio().restore(previous); } catch { /* Preserve the original failure. */ }
    throw error;
  }
}

export function galleryPoseGuide(scene, detection, provenance) {
  const next = clone(scene);
  next.openpose = { origin: 'gallery', useRig: false, rawAsset: detection.asset, people: clone(detection.people), gallerySource: clone(provenance) };
  Object.assign(next.conditioning, { model: 'base', guide: 'pose', map: detection.asset, mapKind: 'pose', mapOrigin: 'gallery' });
  upgradeReferences(next); next.referenceLibrary.mode = 'guided';
  return next;
}

export function addGalleryReference(scene, asset, source, target) {
  upgradeReferences(scene);
  const usage = newUse('pose', target);
  let material = scene.referenceLibrary.items.find(row => row.asset?.name === asset.name);
  if (!material) material = addReference(scene, asset, { usages: [], gallerySource: clone(source) });
  material.enabled = true; material.missing = false;
  if (!material.usages.some(use => use.kind === 'pose' && use.enabled !== false && JSON.stringify(use.target) === JSON.stringify(target))) material.usages.push(usage);
  return material;
}

export function galleryViewPlan(scene, rows, target, mode = 'references-only') {
  if (!Array.isArray(rows) || !rows.length || rows.length > 256) throw new Error('请选择 1–256 个实际视角');
  if (!['references-only', 'guided'].includes(mode)) throw new Error('未知图库批量方式');
  const base = clone(scene), selected = clone(rows), mapping = clone(target);
  if (mapping.kind === 'actors' && (!mapping.ids.length || mapping.ids.some(id => !base.actors?.some(actor => actor.id === id && actor.visible !== false)))) throw new Error('批量目标人物已改变，请重新选择');
  upgradeReferences(base);
  // Each task gets one selected gallery view. Other references and draft text remain frozen.
  for (const item of base.referenceLibrary.items) {
    if (item.inputKey) { item.frozenInputKey = item.inputKey; item.inputKey = null; }
    for (const use of item.usages) if (item.gallerySource && use.kind === 'pose' && JSON.stringify(use.target) === JSON.stringify(mapping)) use.enabled = false;
  }
  // AnyAngle always displays coarse, even if another guide was selected before it.
  if (mode === 'guided' && base.conditioning.model === 'anyangle') base.conditioning.guide = 'coarse';
  base.conditioning.model = 'base'; base.referenceLibrary.mode = mode;
  const keys = new Set();
  for (const row of selected) {
    if (!row.asset?.name || !row.source?.viewId || !row.source.hash || keys.has(row.source.viewId)) throw new Error('批量包含重复或未就绪的视角');
    keys.add(row.source.viewId);
  }
  return { count: selected.length, *views() {
    for (const row of selected) {
      const current = clone(base);
      addGalleryReference(current, row.asset, row.source, mapping);
      const manifest = libraryManifest(current);
      if (manifest.missing.length) throw new Error(`参考素材缺失：${manifest.missing.join('、')}`);
      yield { scene: current, label: row.asset.label || row.source.viewId, gallerySource: clone(row.source) };
    }
  } };
}
