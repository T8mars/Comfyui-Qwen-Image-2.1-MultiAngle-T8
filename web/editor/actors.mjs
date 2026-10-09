// Stable role identity is independent of layer order, active rig and image index.
export const ACTOR_COLORS = ['#64cde1', '#f5b66f', '#b59bef', '#92d79f', '#f08cab', '#8faaf4', '#d5d677', '#70d9c7', '#d9a58b'];
export const DEFAULT_BODY = { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false };
const copy = value => JSON.parse(JSON.stringify(value));
export function actorSeed(seed, id) {
  let hash = (Number(seed) >>> 0) ^ 2166136261;
  for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  return hash;
}
export function actorId() {
  return `actor-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
}
export function createActor(index = 0, values = {}) {
  const id = values.id || actorId();
  return {
    id, label: `人物 ${index + 1}`, editorColor: ACTOR_COLORS[index % ACTOR_COLORS.length], visible: true, locked: false,
    source: { kind: 'human' }, mesh: copy(DEFAULT_BODY), pose: { bones: { upperarm_l: [0, 0, -8], upperarm_r: [0, 0, 8] } },
    transform: { x: index * 8, y: 0, z: 0, scale: 1, yaw: 0 },
    identity: { asset: null, inputKey: null, description: '', sourcePerson: null }, poseSource: null,
    ...copy(values), id,
  };
}
export function ensureActors(doc, create = false) {
  if (!Array.isArray(doc.actors)) {
    doc.actors = doc.source?.kind === 'human' ? [createActor(0, {
      id: 'actor-legacy', mesh: doc.mesh || DEFAULT_BODY, pose: doc.pose || { bones: {} },
      transform: { x: 0, y: 0, z: 0, scale: doc.scale ?? 1, yaw: doc.front ?? 0 },
      poseSource: doc.openpose ? copy(doc.openpose) : null, ...(doc.poseRandom ? { poseRandom: copy(doc.poseRandom) } : {}),
    })] : [];
  }
  if (create && !doc.actors.length) doc.actors.push(createActor(0, { mesh: doc.mesh || DEFAULT_BODY, pose: doc.pose || { bones: {} },
    transform: { x: 0, y: 0, z: 0, scale: doc.scale ?? 1, yaw: doc.front ?? 0 } }));
  const known = new Set();
  for (const [i, value] of doc.actors.entries()) {
    const id = value.id && !known.has(value.id) ? value.id : actorId();
    const actor = Object.assign(value, createActor(i, { ...value, id }));
    actor.transform = { x: 0, y: 0, z: 0, scale: 1, yaw: 0, ...value.transform };
    actor.identity = { asset: null, inputKey: null, description: '', sourcePerson: null, ...value.identity };
    doc.actors[i] = actor; known.add(id);
  }
  if (!known.has(doc.activeActorId)) doc.activeActorId = doc.actors[0]?.id || null;
  doc.selectedActorIds = [...new Set(doc.selectedActorIds || [doc.activeActorId])].filter(id => known.has(id));
  if (doc.version !== 3) doc.version = 2;
  return doc.actors;
}
export function activeActor(doc) { return doc.actors?.find(actor => actor.id === doc.activeActorId) || null; }
export function bindActor(doc, id = doc.activeActorId) {
  const actor = doc.actors?.find(item => item.id === id);
  if (!actor) return null;
  doc.activeActorId = actor.id;
  doc.mesh = actor.mesh; doc.pose = actor.pose; doc.scale = actor.transform.scale; doc.front = actor.transform.yaw;
  doc.poseRandom = actor.poseRandom;
  return actor;
}
export function saveActor(doc, pose = doc.pose) {
  const actor = activeActor(doc);
  if (!actor) return null;
  actor.mesh = copy(doc.mesh); actor.pose = copy(pose);
  actor.transform.scale = doc.scale; actor.transform.yaw = doc.front;
  if (doc.poseRandom) actor.poseRandom = copy(doc.poseRandom);
  doc.mesh = actor.mesh; doc.pose = actor.pose;
  return actor;
}
export function visibleActors(doc) { return (doc.actors || []).filter(actor => actor.visible !== false); }
export function editableActors(doc, scope = 'current') {
  const ids = scope === 'selected' ? doc.selectedActorIds || [] : [doc.activeActorId];
  return (doc.actors || []).filter(actor => !actor.locked && actor.visible !== false && (scope === 'all' || ids.includes(actor.id)));
}
export function cloneActor(doc, id = doc.activeActorId, reuseIdentity = false) {
  const source = doc.actors.find(actor => actor.id === id);
  if (!source) throw new Error('未选择人物');
  const actor = createActor(doc.actors.length, source);
  actor.id = actorId(); actor.label = `${source.label} 副本`; actor.locked = false;
  if (!reuseIdentity) actor.identity = { asset: null, inputKey: null, sourcePerson: null, description: '' };
  actor.editorColor = ACTOR_COLORS[doc.actors.length % ACTOR_COLORS.length];
  actor.transform.x += 8;
  doc.actors.push(actor); return actor;
}
export function removeActor(doc, id) {
  for (const item of doc.referenceLibrary?.items || []) for (const use of item.usages) {
    if (use.target.kind === 'actors') use.target.ids = use.target.ids.filter(value => value !== id);
  }
  doc.actors = doc.actors.filter(actor => actor.id !== id);
  doc.contacts = (doc.contacts || []).filter(contact => !contact.actors?.includes(id));
  doc.selectedActorIds = (doc.selectedActorIds || []).filter(value => value !== id);
  if (doc.activeActorId === id) doc.activeActorId = doc.actors.find(actor => actor.visible !== false)?.id || doc.actors[0]?.id || null;
  if (!doc.actors.length) doc.source = { kind: 'empty' };
  bindActor(doc); return doc.activeActorId;
}
export function moveActor(doc, id, delta) {
  const from = doc.actors.findIndex(actor => actor.id === id), to = Math.max(0, Math.min(doc.actors.length - 1, from + delta));
  if (from < 0 || from === to) return;
  const [actor] = doc.actors.splice(from, 1); doc.actors.splice(to, 0, actor);
}
// A composition template owns posing and placement, while existing identity bindings remain.
export function applySceneTemplate(doc, template) {
  const existing = doc.actors || [];
  const idMap = new Map();
  const used = new Set(), reserved = new Set(template.actors.map(actor => actor.id));
  doc.actors = template.actors.map((actor, i) => {
    const current = existing.find(item => item.id === actor.id && !used.has(item.id))
      || existing.find((item, index) => index === i && !used.has(item.id) && !reserved.has(item.id))
      || existing.find(item => !used.has(item.id) && !reserved.has(item.id));
    if (current) used.add(current.id);
    const result = createActor(i, { ...actor, id: current?.id || actorId(), label: current?.label || actor.label,
      editorColor: current?.editorColor || actor.editorColor,
      identity: current?.identity || { asset: null, inputKey: null, description: '', sourcePerson: null } });
    idMap.set(actor.id, result.id); return result;
  });
  if (template.props) doc.props = copy(template.props);
  doc.contacts = (template.contacts || []).filter(contact => contact.actors?.every(id => idMap.has(id)))
    .map(contact => ({ ...copy(contact), actors: contact.actors.map(id => idMap.get(id)) }));
  doc.source = { kind: 'human' }; doc.activeActorId = doc.actors[0]?.id || null;
  if (template.camera) doc.camera = copy(template.camera);
  if (template.cameraTarget) doc.cameraTarget = copy(template.cameraTarget);
  bindActor(doc);
}
