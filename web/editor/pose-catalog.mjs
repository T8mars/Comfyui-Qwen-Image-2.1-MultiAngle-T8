import { editableActors, bindActor } from './actors.mjs?v=20261010lan1';

const clone = value => structuredClone(value);
const handBone = name => /^(hand|thumb|index|middle|ring|pinky)_/.test(name);
export function poseForActor(current, incoming, { part = 'full', preserveHands = false } = {}) {
  if (!incoming?.bones || typeof incoming.bones !== 'object') throw new Error('姿势缺少骨骼数据');
  if (!['full','body','arms','legs','hands'].includes(part)) throw new Error('未知动作范围');
  const match = name => part === 'full' || part === 'body' && !handBone(name)
    || part === 'hands' && handBone(name) || part === 'arms' && /^(clavicle|upperarm|lowerarm|hand|thumb|index|middle|ring|pinky)_/.test(name)
    || part === 'legs' && /^(thigh|calf|foot|ball)_/.test(name);
  const next = part === 'full' ? { bones: {} } : clone(current || { bones: {} });
  next.bones ||= {};
  for (const name of Object.keys(next.bones)) if (match(name) && !(preserveHands && handBone(name))) delete next.bones[name];
  for (const [name, values] of Object.entries(incoming.bones)) {
    if (['__proto__','constructor','prototype'].includes(name) || !Array.isArray(values) || values.length !== 3 || !values.every(Number.isFinite))
      throw new Error('姿势包含无效的骨骼旋转');
    if (match(name) && !(preserveHands && handBone(name))) next.bones[name] = [...values];
  }
  if (preserveHands) for (const [name, values] of Object.entries(current?.bones || {})) if (handBone(name)) next.bones[name] = [...values];
  // World placement belongs to the actor. Imported absolute hip/IK positions belong to another body.
  if (part === 'full' && incoming.modelRotation) next.modelRotation = [...incoming.modelRotation];
  const replace = name => match(name) && !(preserveHands && handBone(name));
  for (const field of ['bonePositions','positionDeltas']) {
    const values=part==='full' ? {} : clone(current?.[field] || {});
    for(const name of Object.keys(values))if(replace(name))delete values[name];
    if(part==='full' && preserveHands)for(const[name,value]of Object.entries(current?.[field] || {}))if(handBone(name))values[name]=clone(value);
    if(field==='positionDeltas')for(const[name,value]of Object.entries(incoming.positionDeltas || {})){
      if(['__proto__','constructor','prototype'].includes(name)||!Array.isArray(value)||value.length!==3||!value.every(Number.isFinite))throw new Error('姿势包含无效的骨骼位移');
      if(replace(name))values[name]=clone(value);
    }
    if(Object.keys(values).length)next[field]=values;else delete next[field];
  }
  delete next.ikEffectorPositions; delete next.poleTargetPositions;
  return next;
}

export function applyCatalogPose(scene, entry, options = {}) {
  if (scene.source?.kind !== 'human') throw new Error('姿势库需要可编辑人偶；请先切换到人偶场景');
  const result = clone(scene), roles = editableActors(result, options.scope || 'current');
  if (!roles.length) throw new Error('请先选择可见且未锁定的人物');
  const ids = new Set(roles.map(role => role.id));
  if (entry.kind === 'composition' && roles.length !== entry.slots.length) throw new Error(`此编排需要明确选中 ${entry.slots.length} 位可编辑人物，不会自动增删人物`);
  const contacts = (result.contacts || []).filter(contact => contact.actors?.some(id => ids.has(id)));
  if (contacts.length && !options.releaseContacts) throw new Error(`此动作会解除 ${contacts.length} 项接触关系，请先勾选允许解除`);
  const origin = clone(roles[0].transform);
  for (const [index,role] of roles.entries()) {
    const slot = entry.kind === 'composition' ? entry.slots[index] : null;
    role.pose = poseForActor(role.pose, slot?.pose || entry.pose, options);
    if (slot) for (const key of ['x','y','z','yaw']) role.transform[key] = origin[key] + slot.transform[key];
    role.poseSource = role.poseSource ? { ...role.poseSource, useRig: true } : null;
    delete role.poseRandom;
  }
  result.contacts = (result.contacts || []).filter(contact => !contact.actors?.some(id => ids.has(id)));
  if (result.openpose) result.openpose.useRig = true;
  if (result.conditioning.guide === 'pose') Object.assign(result.conditioning, { map: null, mapKind: null, mapOrigin: 'rig' });
  if (result.conditioning.guide === 'depth' || result.conditioning.guide === 'canny') {
    Object.assign(result.conditioning, { map: null, mapKind: null, mapOrigin: result.conditioning.guide === 'depth' ? 'scene' : 'auto' });
  }
  bindActor(result, result.activeActorId);
  const align = (entry.align || []).map(pair => ({ actors: pair.slots.map(i=>roles[i].id), hands: pair.hands }));
  return { scene: result, actorIds: [...ids], align };
}

export async function finishCatalogPose(studio, result, options = {}) {
  studio.useRigPose();
  if(options.ground && Number.isFinite(options.floorY))studio.grid.position.y=options.floorY;
  if(options.ground)studio.groundActors(result.actorIds);
  for(const pair of result.align){
    const contacts=clone(studio.doc.contacts || []);
    await studio.alignHands(pair.actors[0],pair.hands[0],pair.actors[1],pair.hands[1]);
    studio.doc.contacts=[...contacts,...studio.doc.contacts];
  }
  studio.syncPose?.();
}

export async function applyCatalogTransaction(context, entry, options = {}) {
  const previous=clone(context.doc()), rollback=context.begin();
  const floorY=context.studio().grid?.position.y;
  try {
    const result=applyCatalogPose(context.doc(),entry,options);context.replace(result.scene);await context.studio().restore(result.scene);
    await finishCatalogPose(context.studio(),result,{...options,floorY});
    context.changed();return result;
  }catch(error){context.replace(previous);rollback?.();try{await context.studio().restore(previous);}catch{}throw error;}
}

export function poseCameraPlan(scene, settings, entries, options, cameraPlan) {
  scene=clone(scene); settings=clone(settings); options=clone(options || {});
  const list = entries.map(entry => clone(entry));
  if (!list.length) return cameraPlan(scene, settings);
  for(const entry of list)applyCatalogPose(scene,entry,options);
  const cameras = cameraPlan(applyCatalogPose(scene, list[0], options).scene, settings);
  return { count: cameras.count * list.length, *views() {
    for (const entry of list) {
      const result = applyCatalogPose(scene, entry, entry.kind==='composition' ? {...options,part:'full',preserveHands:false} : options);
      for (const view of cameraPlan(result.scene, settings).views()) yield { ...view, label: `${entry.name} · ${view.label}`, poseId: entry.id, poseName: entry.name,
        preparation: {actorIds:result.actorIds,align:result.align,options:clone(options)} };
    }
  } };
}

export function filterCatalog(items, { query = '', category = '', tab = 'all', source = '' } = {}) {
  const text = query.trim().toLocaleLowerCase();
  return items.filter(item => !item.hidden && (!category || item.category === category) && (!source || item.source?.id === source)
    && (tab !== 'favorites' || item.favorite) && (tab !== 'imported' || !item.builtin)
    && (!text || [item.name,item.originalName,...(item.tags || [])].join(' ').toLocaleLowerCase().includes(text)));
}
