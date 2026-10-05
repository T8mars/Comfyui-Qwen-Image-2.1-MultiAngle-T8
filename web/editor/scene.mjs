import * as THREE from '../vendor/three.module.mjs';
import { GLTFLoader } from '../vendor/GLTFLoader.mjs';
import { PoseViewerCore } from '../vendor/vnccs_pose_studio_core.mjs?v=20261004mp1';
import { solveMorph, buildStaticModelData } from '../vendor/vnccs_pose_morph_runtime.mjs';
import { loadHumanPack, HumanAssetError } from './human.mjs?v=20261004mp1';
import { applyLens } from './lens.mjs?v=20261004mp1';
import { HAND_PRESETS } from '../vendor/vnccs_hand_presets.mjs';
import { SplatScene } from './splat.mjs?v=20261004mp1';
import { capturePNG } from './capture.mjs?v=20261004mp1';
import { liftOpenPose, copyVisiblePose, WORLD_KEYPOINT_NAMES, ORDER, LIMBS, COLORS } from './openpose.mjs?v=20261004mp1';
import { ensureActors, activeActor, bindActor, saveActor, visibleActors } from './actors.mjs?v=20261004mp1';
import { loadProp, disposeProp, placeProp } from './props.mjs?v=20261004mp1';

export const PRESETS = [
  { name: '自然站立', bones: { upperarm_l: [0, 0, -8], upperarm_r: [0, 0, 8] } },
  { name: '迈步', bones: { thigh_l: [-25, 0, 0], calf_l: [16, 0, 0], thigh_r: [20, 0, 0], calf_r: [9, 0, 0], upperarm_l: [20, 0, -8], upperarm_r: [-20, 0, 8] } },
  { name: '坐姿', bones: { thigh_l: [-85, 0, -5], thigh_r: [-85, 0, 5], calf_l: [85, 0, 0], calf_r: [85, 0, 0], lowerarm_l: [-45, 0, 0], lowerarm_r: [-45, 0, 0] } },
  { name: '举手', bones: { upperarm_l: [0, 0, 100], lowerarm_l: [0, 0, 20], upperarm_r: [0, 0, 10] } },
];
export const defaultScene = () => ({
  version: 2, width: 1024, height: 1024, actors: [], activeActorId: null, selectedActorIds: [],
  source: { kind: 'empty' }, reference: null,
  reconstruction: { keepBackground: false },
  interaction: { mousePitch: true, quality: 'balanced', livePreview: true },
  camera: { azimuth: 35, elevation: 8, zoom: 1.3, offsetX: 0, offsetY: 0, offsetZ: 0, focalLength: 0 },
  mesh: { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false },
  pose: { bones: PRESETS[0].bones }, shots: [], front: 0, scale: 1,
  background: '#69717b',
  conditioning: { model: 'anyangle', guide: 'coarse', map: null, cannyLow: 50, cannyHigh: 150 },
  openpose: null,
});
export function restoreSceneDefaults(doc) {
  const defaults = defaultScene();
  for (const key of ['width', 'height', 'source', 'reference', 'shots', 'front', 'scale', 'background', 'pose', 'openpose'])
    doc[key] ??= defaults[key];
  for (const key of ['camera', 'mesh', 'conditioning', 'interaction']) doc[key] = { ...defaults[key], ...doc[key] };
  doc.reconstruction = { keepBackground: !!doc.source.keep_background, ...doc.reconstruction };
  // Leave legacy actors absent so ensureActors can migrate the original pose.
  return doc;
}
export const assetURL = name => `/anyangle-studio/assets/${encodeURIComponent(name)}`;
const radians = THREE.MathUtils.degToRad;
const degrees = THREE.MathUtils.radToDeg;
const clamp = THREE.MathUtils.clamp;

function modelData(morph, data) {
  return {
    vertices: morph.vertices, uvs: data.uvs, indices: data.indices,
    skinIndices: data.skinIndices, skinWeights: data.skinWeights,
    landmarks: morph.landmarks || {}, landmark_indices: morph.landmarkIndices || {},
    bones: data.bones.map((bone, i) => {
      const headPos = Array.from(morph.bonePositions.subarray(i * 6, i * 6 + 3));
      const tailPos = Array.from(morph.bonePositions.subarray(i * 6 + 3, i * 6 + 6));
      return { name: bone.name, parent: bone.parent || null, headPos, tailPos, length: Math.hypot(...tailPos.map((v, j) => v - headPos[j])) };
    }),
  };
}

function disposeObject(root) {
  root.traverse(object => {
    object.geometry?.dispose();
    object.skeleton?.dispose();
    for (const material of [].concat(object.material || [])) {
      for (const value of Object.values(material)) if (value?.isTexture) value.dispose();
      material.dispose();
    }
  });
  root.removeFromParent();
}

function worldBounds(root) {
  root.updateMatrixWorld(true);
  root.traverse(object => {
    if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); }
  });
  return new THREE.Box3().setFromObject(root);
}

export class StudioScene {
  constructor(canvas, callbacks) {
    this.canvas = canvas;
    this.callbacks = callbacks;
    this.mode = 'camera';
    this.restoring = true;
    this.actorRoots = new Map();
    this.propRoots = new Map();
    this.viewer = new PoseViewerCore(canvas, {
      skinMode: 'naked', enableTextureSkinning: true,
      showSkeletonHelper: false, showCaptureFrame: false, useHandControlPopover: false,
      onPoseChange: () => { if (!this.restoring) callbacks.change(); },
      onBoneSelectionChange: ({ boneName }) => callbacks.select(boneName),
      onError: error => callbacks.error(error),
    });
    // One editor history owns the pose, camera, assets and shot library together.
    this.viewer.recordState = () => { if (!this.restoring) callbacks.begin(); };
    this.viewer.options.onInteractionEnd = () => { if (!this.restoring) callbacks.change(); };
    const requestRender = this.viewer.requestRender.bind(this.viewer);
    this.viewer.requestRender = () => { if (!this.capturing) requestRender(); };
  }

  async init(doc) {
    this.doc = doc;
    await this.viewer.init();
    if (!this.viewer.initialized) throw new Error('WebGL 初始化失败，请开启浏览器硬件加速');
    this.cameraClips = [this.viewer.camera, this.viewer.captureCamera].map(camera => ({ near: camera.near, far: camera.far }));
    this.viewer.setDirectionalSkydomeVisible(false);
    this.viewer.scene.background = new THREE.Color('#171f28');
    this.viewer.camera.fov = 38;
    this.viewer.updateLights([{ type: 'ambient', color: '#ffffff', intensity: 1.3 },
      { type: 'directional', color: '#ffffff', intensity: 1.7, x: 8, y: 20, z: 18 }]);
    this.grid = new THREE.GridHelper(100, 50, 0x425365, 0x28343f);
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.32;
    this.viewer.scene.add(this.grid);
    const points = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(Math.sin(i / 128 * Math.PI * 2) * 14, 0, Math.cos(i / 128 * Math.PI * 2) * 14));
    this.ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0x24cce3, transparent: true, opacity: 0.72 }));
    this.viewer.scene.add(this.ring);
    this.shotHelper = new THREE.CameraHelper(this.viewer.captureCamera);
    this.shotHelper.material.color.set('#eba84b');
    this.viewer.scene.add(this.shotHelper);
    this.photoFrame = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0xeba84b, depthTest: false }));
    this.photoFrame.renderOrder = 1000;
    this.viewer.scene.add(this.photoFrame);
    await this.restore(doc);
    this.bindCamera();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.canvas.parentElement);
    this.resize();
  }

  updatePerformance() {
    const renderer = this.viewer.renderer;
    if (!renderer) return;
    const limit = { economy: 1, balanced: 1.5, sharp: 2 }[this.doc.interaction?.quality] || 1.5;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, limit);
    if (renderer.getPixelRatio() !== ratio) renderer.setPixelRatio(ratio);
    this.viewer.requestRender();
  }

  resize() {
    const { width, height } = this.canvas.parentElement.getBoundingClientRect();
    this.viewer.resize(Math.max(1, width), Math.max(1, height));
    if (this.mode === 'camera' && this.baseTarget) this.updateShot();
  }

  buildHuman(pose, actor = activeActor(this.doc)) {
    if (this.cachedPack !== this.pack) {
      this.cachedPack = this.pack; this.morphCache = new Map(); this.morphCacheBytes = 0;
      this.humanStatic = buildStaticModelData(this.pack, false);
    }
    const key = JSON.stringify(this.doc.mesh);
    let cached = this.morphCache.get(key);
    if (!cached) {
      const morph = solveMorph(this.pack, this.doc.mesh);
      cached = { morph, bytes: morph.vertices.byteLength + morph.bonePositions.byteLength + 65536 };
      this.morphCacheBytes += cached.bytes;
    } else this.morphCache.delete(key);
    this.morphCache.set(key, cached);
    while (this.morphCache.size > 16 || this.morphCacheBytes > 16 * 1024 * 1024) {
      const first = this.morphCache.keys().next().value;
      this.morphCacheBytes -= this.morphCache.get(first).bytes; this.morphCache.delete(first);
    }
    const morph = cached.morph;
    // Native cached proportion controls belong to a rig, never to its previous occupant.
    this.viewer.headScale = this.viewer.armScale = this.viewer.handScale = this.viewer.footScale = 1;
    this.viewer.setSkinTexture('naked');
    this.viewer.loadData(modelData(morph, this.humanStatic), true);
    this.viewer.setPose(pose || { bones: {} }, true);
    this.viewer.setActiveCharacterAppearance({ color: actor?.editorColor || '#e3e9ee', transform: { x: 0, y: 0, z: 0, zoom: actor ? 1 : this.doc.scale } });
    if (actor) this.attachActor(actor, this.viewer.skinnedMesh);
  }

  attachActor(actor, mesh) {
    let root = this.actorRoots.get(actor.id);
    if (!root) { root = new THREE.Group(); root.userData.actorId = actor.id; this.actorRoots.set(actor.id, root); this.viewer.scene.add(root); }
    root.add(mesh); mesh.userData.actorId = actor.id;
    this.updateActorTransform(actor);
    return root;
  }

  updateActorTransform(actor = activeActor(this.doc)) {
    const root = this.actorRoots.get(actor?.id); if (!root) return;
    const t = actor.transform;
    root.position.set(t.x, t.y, t.z); root.rotation.y = radians(t.yaw); root.scale.setScalar(t.scale);
    root.visible = this.doc.source.kind === 'human' && actor.visible !== false;
    root.updateMatrixWorld(true);
    root.traverse(object => { if (object.isSkinnedMesh) { object.skeleton.update(); object.computeBoundingBox(); object.computeBoundingSphere(); } });
    if (actor.id === this.doc.activeActorId) { this.viewer.updateMarkers(); this.viewer.updateIKEffectorPositions?.(); }
    this.viewer.requestRender();
  }

  actorMesh(id) { return id === this.doc.activeActorId ? this.viewer.skinnedMesh : this.viewer.passiveCharacters.get(id)?.mesh; }
  actorBones(id) { return id === this.doc.activeActorId ? this.viewer.bones : this.viewer.passiveCharacters.get(id)?.bones; }
  humanBounds(selected = false) {
    const box = new THREE.Box3();
    for (const actor of selected ? this.doc.actors || [] : visibleActors(this.doc)) {
      if (selected && !(this.doc.selectedActorIds || [this.doc.activeActorId]).includes(actor.id)) continue;
      const mesh = this.actorMesh(actor.id);
      if (mesh) { mesh.updateMatrixWorld(true); mesh.skeleton.update(); mesh.computeBoundingBox(); box.union(mesh.boundingBox.clone().applyMatrix4(mesh.matrixWorld)); }
    }
    if (!selected) for (const prop of this.doc.props || []) if (prop.visible !== false) {
      const root = this.propRoots?.get(prop.id); if (root) box.union(worldBounds(root));
    }
    return box;
  }

  async restoreProps() {
    this.propRoots ||= new Map(); const props = this.doc.props || [], ids = new Set(props.map(prop=>prop.id));
    for (const [id, root] of this.propRoots) if (!ids.has(id) || props.find(prop=>prop.id===id)?.asset.name !== root.userData.assetName) { disposeProp(root); this.propRoots.delete(id); }
    for (const prop of props) {
      let root = this.propRoots.get(prop.id);
      if (this.doc.source.kind !== 'human') { if (root) root.visible = false; continue; }
      if (!root) { root = await loadProp(prop.asset); root.userData.assetName = prop.asset.name; this.propRoots.set(prop.id,root); this.viewer.scene.add(root); }
      placeProp(root,prop,this.doc.source.kind==='human');
    }
  }

  updateProp(prop) { const root = this.propRoots.get(prop.id); if (root) { placeProp(root,prop,this.doc.source.kind==='human'); this.viewer.requestRender(); } }

  async selectActor(id) {
    if (id === this.doc.activeActorId || this.doc.source.kind !== 'human') return;
    const actor = this.doc.actors.find(item => item.id === id); if (!actor) return;
    this.syncPose(); this.restoring = true;
    try {
      const previous = activeActor(this.doc);
      if (previous && this.viewer.upsertPassiveCharacterFromActive(previous.id, { pose: previous.pose, color: previous.editorColor }))
        this.attachActor(previous, this.viewer.passiveCharacters.get(previous.id).mesh);
      this.viewer.removePassiveCharacter(id);
      bindActor(this.doc, id); this.buildHuman(actor.pose, actor);
      this.setMode(this.mode); await this.waitForCaptureReady(); this.syncPose();
    } finally { this.restoring = false; }
    this.callbacks.actor?.(id);
  }

  async waitForCaptureReady(timeout = 45000) {
    if (this.doc.source.kind !== 'human') return this.viewer.waitForCaptureReady();
    let timer;
    try {
      return await Promise.race([this.viewer.waitForCaptureReady(), new Promise((resolve, reject) => {
        timer = setTimeout(() => reject(new HumanAssetError('人偶贴图加载超时，请重试或修复人偶资源。')), timeout);
      })]);
    } finally { clearTimeout(timer); }
  }

  async restore(doc) {
    this.restoring = true;
    try {
      this.doc = restoreSceneDefaults(doc);
      ensureActors(doc, doc.source.kind === 'human');
      await this.restoreProps();
      this.updatePerformance();
      if (doc.source.kind !== 'splat') [this.viewer.camera, this.viewer.captureCamera].forEach((camera, i) => {
        camera.clearViewOffset(); camera.near = this.cameraClips[i].near; camera.far = this.cameraClips[i].far;
        camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      });
      if (this.splat && doc.source.kind !== 'splat') { await this.splat.dispose(); this.splat = null; }
      if (this.glb && doc.source.kind !== 'glb') { disposeObject(this.glb); this.glb = null; this.glbName = null; }
      if (doc.source.kind === 'human') {
        if (!this.pack) this.pack = await loadHumanPack();
        this.viewer.clearPassiveCharacters();
        for (const root of this.actorRoots.values()) root.removeFromParent();
        this.actorRoots.clear();
        const selectedId = doc.activeActorId;
        for (const actor of doc.actors.filter(item => item.id !== selectedId)) {
          bindActor(doc, actor.id); this.buildHuman(actor.pose, actor);
          this.viewer.upsertPassiveCharacterFromActive(actor.id, { pose: actor.pose, color: actor.editorColor });
          this.attachActor(actor, this.viewer.passiveCharacters.get(actor.id).mesh);
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        const actor = bindActor(doc, selectedId); this.buildHuman(actor.pose, actor);
        this.baseTarget = Array.isArray(doc.cameraTarget) ? new THREE.Vector3(...doc.cameraTarget) : this.humanBounds().getCenter(new THREE.Vector3());
        if (!Number.isFinite(this.baseTarget.x)) this.baseTarget.set(0, 10, 0);
        doc.cameraTarget = this.baseTarget.toArray();
      } else if (doc.source.kind === 'splat') {
        if (this.splat?.disposed || this.splat?.source?.name !== doc.source.name) {
          const loaded = new SplatScene(this.viewer);
          await loaded.load(doc.source);
          await this.splat?.dispose();
          this.splat = loaded;
          this.viewer.scene.add(this.splat.root);
        }
        this.splat.root.scale.setScalar(doc.scale);
        this.splat.root.rotation.y = radians(doc.front);
        this.splat.root.updateMatrixWorld(true);
        this.baseTarget = this.splat.target;
      } else if (doc.source.kind === 'glb') {
        if (this.glbName !== doc.source.name) {
          const response = await fetch(assetURL(doc.source.name));
          if (!response.ok) throw new Error('GLB 资源缺失，请重新导入');
          const manager = new THREE.LoadingManager();
          manager.setURLModifier(url => {
            if (!url.startsWith('blob:') && !url.startsWith('data:')) throw new Error('GLB 需要内嵌材质，不能加载外部地址');
            return url;
          });
          const gltf = await new GLTFLoader(manager).parseAsync(await response.arrayBuffer(), '');
          const imported = gltf.scene;
          const bounds = worldBounds(imported);
          if (bounds.isEmpty()) throw new Error('GLB 中没有可渲染的几何体');
          const size = bounds.getSize(new THREE.Vector3());
          const center = bounds.getCenter(new THREE.Vector3());
          const longest = Math.max(size.x, size.y, size.z);
          if (!Number.isFinite(longest) || longest <= 0) throw new Error('GLB 几何体范围无效');
          const scale = 20 / longest;
          const normalized = new THREE.Group();
          normalized.add(imported);
          normalized.position.set(-center.x * scale, -bounds.min.y * scale, -center.z * scale);
          normalized.scale.setScalar(scale);
          const group = new THREE.Group();
          group.add(normalized);
          if (this.glb) disposeObject(this.glb);
          this.glb = group;
          this.glbName = doc.source.name;
          this.viewer.scene.add(group);
        }
        this.glb.scale.setScalar(doc.scale);
        this.glb.rotation.y = radians(doc.front);
        this.baseTarget = worldBounds(this.glb).getCenter(new THREE.Vector3());
      } else {
        this.baseTarget = new THREE.Vector3(0, 10, 0);
      }
      this.viewer.setMannequinVisible(doc.source.kind === 'human');
      for (const actor of doc.actors) this.updateActorTransform(actor);
      const bounds = doc.source.kind === 'splat' ? this.splat.bounds
        : doc.source.kind === 'empty' ? new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10))
        : doc.source.kind === 'human' ? this.humanBounds() : worldBounds(this.glb);
      if (bounds.isEmpty()) bounds.set(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10));
      this.grid.position.y = bounds.min.y - 0.03;
      this.ring.position.copy(this.baseTarget);
      this.ring.visible = doc.source.kind !== 'splat' && doc.source.kind !== 'empty';
      this.setMode(this.mode);
      this.updateShot(true);
      await this.waitForCaptureReady();
      // Normalize sparse or older pose documents without treating restoration
      // as a user edit and replacing an explicitly selected photo skeleton.
      this.syncPose();
    } finally { this.restoring = false; }
  }

  pose() {
    const { camera, cameraParams, ...pose } = this.viewer.getPose();
    return pose;
  }

  syncPose() {
    if (this.doc.source.kind !== 'human') return;
    const pose = this.pose();
    if (!this.restoring && JSON.stringify(pose) !== JSON.stringify(this.doc.pose)) this.useRigPose();
    this.doc.pose = pose;
    saveActor(this.doc, pose);
  }

  useRigPose() {
    if (this.doc.openpose) this.doc.openpose.useRig = true;
    const settings = this.doc.conditioning;
    if (settings.guide === 'pose') {
      settings.map = null; settings.mapKind = null; settings.mapOrigin = 'rig';
    }
  }

  updateShot(snap = false) {
    const d = this.doc, c = d.camera;
    if (d.source.kind === 'human' && Array.isArray(d.cameraTarget) && d.cameraTarget.length === 3 && d.cameraTarget.every(Number.isFinite))
      this.baseTarget.set(...d.cameraTarget);
    this.photoFrame.visible = d.source.kind === 'splat';
    if (d.source.kind === 'splat') {
      const v = this.viewer;
      const target = this.splat.configureCamera(v.captureCamera, d, d.width, d.height);
      v.captureFrame.visible = false;
      if (snap || this.mode === 'camera') {
        const aspect = v.camera.aspect;
        v.camera.copy(v.captureCamera);
        v.camera.aspect = aspect;
        const padding = 1.12;
        const sx = Math.min(1, (d.width / d.height) / aspect) / padding;
        const sy = Math.min(1, aspect / (d.width / d.height)) / padding;
        for (let column = 0; column < 4; column++) {
          v.camera.projectionMatrix.elements[column * 4] *= sx;
          v.camera.projectionMatrix.elements[column * 4 + 1] *= sy;
        }
        v.camera.projectionMatrixInverse.copy(v.camera.projectionMatrix).invert();
        v.orbit.target.copy(target);
        const distance = v.camera.position.distanceTo(target);
        const ndcZ = new THREE.Vector3(0, 0, -distance).applyMatrix4(v.captureCamera.projectionMatrix).z;
        this.photoFrame.geometry.dispose();
        this.photoFrame.geometry = new THREE.BufferGeometry().setFromPoints([[-1,-1],[1,-1],[1,1],[-1,1]].map(([x,y]) => new THREE.Vector3(x,y,ndcZ).unproject(v.captureCamera)));
      }
      this.shotHelper.update(); this.shotHelper.visible = this.mode === 'edit';
      v.requestRender(); return;
    }
    this.viewer.sceneCameraTarget = this.baseTarget.clone();
    this.viewer.sceneCameraTarget.z -= c.offsetZ || 0;
    this.configureCapture(d.width, d.height);
    this.viewer.captureFrame.visible = true;
    if (snap || this.mode === 'camera') {
      // Fit the complete output frame inside a differently-shaped editor viewport.
      const framing = 1.12 * Math.max(1, (d.width / d.height) / this.viewer.camera.aspect);
      const v = this.viewer;
      v.camera.fov = degrees(2 * Math.atan(Math.tan(radians(v.captureCamera.fov / 2)) * framing));
      v.camera.position.copy(v.captureCamera.position);
      v.camera.zoom = c.zoom; v.camera.updateProjectionMatrix();
      v.orbit.target.copy(v.sceneCameraTarget).add(new THREE.Vector3(-c.offsetX, -c.offsetY, 0));
      const damping = v.orbit.enableDamping; v.orbit.enableDamping = false;
      v.orbit.update(); v.orbit.enableDamping = damping;
      this.viewer.captureFrame.visible = true;
    }
    this.shotHelper.update();
    this.shotHelper.visible = this.mode === 'edit';
    this.viewer.requestRender();
  }

  configureCapture(width, height) {
    const v = this.viewer, c = this.doc.camera;
    v.updateCaptureCamera(width, height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
    const target = (v.sceneCameraTarget || v.meshCenter || new THREE.Vector3(0, 10, 0)).clone().add(new THREE.Vector3(-c.offsetX, -c.offsetY, 0));
    applyLens(v.captureCamera, target, c.focalLength || 0);
  }

  setMode(mode) {
    if (this.doc.source.kind === 'splat' || this.doc.source.kind === 'empty') mode = 'camera';
    this.mode = mode;
    const human = this.doc.source.kind === 'human';
    const editable = human && !activeActor(this.doc)?.locked && activeActor(this.doc)?.visible !== false;
    this.viewer.setIKMode(mode === 'edit' && editable);
    this.viewer.transform.detach();
    this.viewer.transform.visible = mode === 'edit' && editable;
    this.viewer.skeletonHelper && (this.viewer.skeletonHelper.visible = false);
    this.viewer.jointMarkers.forEach(marker => { marker.visible = mode === 'edit' && editable && this.viewer._shouldMarkerBeVisible(marker); });
    this.viewer.orbit.enabled = mode === 'edit' || mode === 'position';
    this.shotHelper.visible = mode === 'edit';
    this.updateShot(mode === 'camera');
  }

  currentViewAsShot() {
    const v = this.viewer;
    const delta = v.camera.position.clone().sub(v.orbit.target);
    const distance = delta.length();
    this.doc.camera.azimuth = degrees(Math.atan2(delta.x, delta.z));
    this.doc.camera.elevation = degrees(Math.asin(delta.y / distance));
    this.doc.camera.zoom = v.camera.zoom * 45 / distance * Math.tan(radians(15)) / Math.tan(radians(v.camera.fov / 2));
    const target = this.baseTarget;
    this.doc.camera.offsetX = target.x - v.orbit.target.x;
    this.doc.camera.offsetY = target.y - v.orbit.target.y;
    this.doc.camera.offsetZ = target.z - v.orbit.target.z;
    this.updateShot(true);
  }

  async capture(width = this.doc.width, height = this.doc.height, options = {}) {
    if (this.doc.source.kind === 'empty') throw new Error('请先从原图重建主体或导入对应的 3D 场景');
    await this.waitForCaptureReady();
    const v = this.viewer;
    const content = this.splat ? this.splat.root : this.doc.source.kind === 'glb' ? this.glb : v.skinnedMesh;
    if (!content) throw new Error('场景中没有可渲染资产');
    const contents = this.doc.source.kind === 'human' && this.actorRoots?.size
      ? [...(options.actorIds ? this.doc.actors.filter(actor => options.actorIds.includes(actor.id)) : visibleActors(this.doc)).map(actor => this.actorRoots.get(actor.id)),
        ...(!options.actorIds ? (this.doc.props || []).filter(prop=>prop.visible!==false).map(prop=>this.propRoots.get(prop.id)) : [])].filter(Boolean) : [content];
    if (!contents.length) throw new Error('请至少显示一个人物');
    if (options.depth && this.splat) throw new Error('TripoSplat 暂不支持真实场景深度，请使用原图 DA3 深度');
    const visibility = v.scene.children.map(object => [object, object.visible]);
    // VNCCS attaches joint markers below the skinned mesh, not just to the scene.
    const nestedHelpers = this.doc.source.kind === 'human'
      ? [...v.jointMarkers, ...Object.values(v.ikController?.effectors || {}),
        ...Object.values(v.ikController?.poleTargets || {}), ...(v._handRings || [])]
        .filter(Boolean).map(object => [object, object.visible]) : [];
    const background = v.scene.background;
    const overrideMaterial = v.scene.overrideMaterial;
    const actorColors = [];
    let depthMaterial = null, cannyMaterial = null;
    this.capturing = true;
    let restoreSplat = null;
    try {
      if (v._renderFrame) { cancelAnimationFrame(v._renderFrame); v._renderFrame = null; }
      if (this.splat) this.splat.configureCamera(v.captureCamera, this.doc, width, height);
      else this.configureCapture(width, height);
      // Pointer input may update the live cameras while sorting awaits a worker.
      const camera = v.captureCamera.clone();
      if (this.splat) {
        restoreSplat = this.splat.beginOffscreenCapture(width, height);
        await this.splat.prepareCapture(v.renderer, camera);
      }
      // Positive content selection excludes every editor overlay, even newly added helpers.
      for (const [object] of visibility) object.visible = contents.includes(object) || !!object.isLight;
      for (const [object] of nestedHelpers) object.visible = false;
      v.scene.background = new THREE.Color(this.doc.background);
      if (this.doc.source.kind === 'human' && this.doc.conditioning?.colorActors !== true) {
        for (const actor of visibleActors(this.doc)) for (const material of [].concat(this.actorMesh(actor.id)?.material || [])) {
          if (material.color) { actorColors.push([material, material.color.clone()]); material.color.set('#e3e9ee'); }
        }
      }
      if (options.depth) {
        camera.updateMatrixWorld(true);
        const bounds = this.doc.source.kind === 'human' ? this.humanBounds() : worldBounds(content);
        const depths = [];
        for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z])
          depths.push(-new THREE.Vector3(x, y, z).applyMatrix4(camera.matrixWorldInverse).z);
        const near = Math.max(camera.near, Math.min(...depths)), far = Math.max(near + 0.001, Math.max(...depths));
        depthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.BasicDepthPacking });
        depthMaterial.onBeforeCompile = shader => {
          shader.uniforms.sceneNear = { value: near }; shader.uniforms.sceneFar = { value: far };
          shader.uniforms.cameraNear = { value: camera.near }; shader.uniforms.cameraFar = { value: camera.far };
          shader.uniforms.nearWhite = { value: this.doc.conditioning.depthInvert ? 0 : 1 };
          shader.fragmentShader = 'uniform float sceneNear; uniform float sceneFar; uniform float cameraNear; uniform float cameraFar; uniform float nearWhite;\n' + shader.fragmentShader;
          shader.fragmentShader = shader.fragmentShader.replace('gl_FragColor = vec4( vec3( 1.0 - fragCoordZ ), opacity );',
            'float linearDepth = -perspectiveDepthToViewZ(fragCoordZ, cameraNear, cameraFar); float t = clamp((linearDepth-sceneNear)/(sceneFar-sceneNear),0.0,1.0); gl_FragColor = vec4(vec3(mix(t,1.0-t,nearWhite)),1.0);');
        };
        v.scene.overrideMaterial = depthMaterial; v.scene.background = new THREE.Color('#000000');
      } else if (options.canny && !this.splat) {
        // Structure edges must not disappear when an actor color and the user
        // background have similar luminance. Render mesh geometry as lit clay
        // for this offscreen pass only; keep the real camera and depth test.
        cannyMaterial = new THREE.MeshStandardMaterial({ color: '#eeeeee', roughness: 1, metalness: 0, side: THREE.DoubleSide });
        v.scene.overrideMaterial = cannyMaterial;
        v.scene.background = new THREE.Color('#000000');
      }
      // The bundled splat shader writes already encoded RGB, unlike Three's
      // standard mesh materials. Preserve those colors and its background.
      if (this.splat) v.scene.background.convertLinearToSRGB();
      v.scene.updateMatrixWorld(true);
      v.skeleton?.update();
      return capturePNG(v.renderer, v.scene, camera, width, height,
        this.splat || options.depth ? THREE.NoColorSpace : THREE.SRGBColorSpace);
    } finally {
      for (const [object, visible] of visibility) object.visible = visible;
      for (const [object, visible] of nestedHelpers) object.visible = visible;
      v.scene.background = background;
      v.scene.overrideMaterial = overrideMaterial; depthMaterial?.dispose(); cannyMaterial?.dispose();
      for (const [material, color] of actorColors) material.color.copy(color);
      try { restoreSplat?.(); }
      finally { this.capturing = false; this.updateShot(); }
    }
  }

  fit(selected = false) {
    if (this.doc.source.kind === 'splat') {
      this.doc.camera = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      this.updateShot(true); return;
    }
    if (this.doc.source.kind === 'empty') return;
    const content = this.doc.source.kind === 'glb' ? this.glb : this.viewer.skinnedMesh;
    const bounds = this.doc.source.kind === 'human' && this.actorRoots?.size ? this.humanBounds(selected) : worldBounds(content);
    if (bounds.isEmpty()) return;
    this.doc.camera.zoom = 1;
    const center = bounds.getCenter(new THREE.Vector3());
    this.doc.camera.offsetX = this.baseTarget.x - center.x;
    this.doc.camera.offsetY = this.baseTarget.y - center.y;
    this.doc.camera.offsetZ = this.baseTarget.z - center.z;
    this.updateShot();
    this.viewer.captureCamera.updateMatrixWorld(true);
    let extent = 0;
    for (const x of [bounds.min.x, bounds.max.x]) for (const y of [bounds.min.y, bounds.max.y]) for (const z of [bounds.min.z, bounds.max.z]) {
      const point = new THREE.Vector3(x, y, z).project(this.viewer.captureCamera);
      extent = Math.max(extent, Math.abs(point.x), Math.abs(point.y));
    }
    this.doc.camera.zoom = clamp(0.83 / Math.max(extent, 0.01), 0.1, 8);
    this.updateShot(true);
  }

  setPreset(preset) {
    if (!this.restoring && activeActor(this.doc)?.locked) throw new Error('人物已锁定，请先解锁');
    this.viewer.setPose({ bones: preset.bones }, true);
    if (!this.restoring) this.useRigPose();
    this.syncPose();
    this.setMode(this.mode);
  }

  hand(side, preset) { this.viewer.applyHandPreset(side, HAND_PRESETS[preset]); this.syncPose(); }

  applyOpenPose(points, flips = {}, mode = 'estimated') {
    if (activeActor(this.doc)?.locked) throw new Error('人物已锁定，请先解锁');
    const actor = activeActor(this.doc), root = this.actorRoots?.get(actor?.id);
    if (!root) return this._applyOpenPose(points, flips, mode);
    // Lift in an untransformed reference plane, then place that pose in its role's world frame.
    root.position.set(0, 0, 0); root.rotation.set(0, 0, 0); root.scale.setScalar(1); root.updateMatrixWorld(true);
    try { return this._applyOpenPose(points, flips, mode); }
    finally { this.updateActorTransform(actor); this.viewer.updateIKEffectorPositions(); this.viewer.updateMarkers(); }
  }

  _applyOpenPose(points, flips = {}, mode = 'estimated') {
    if (this.doc.source.kind !== 'human') throw new Error('OpenPose 姿势需要先切换到人偶');
    const viewer = this.viewer;
    if (mode === 'estimated') viewer.resetPose();
    viewer.skinnedMesh.updateMatrixWorld(true);
    const worldOf = name => viewer.bones[name].getWorldPosition(new THREE.Vector3()).toArray();
    const joints = { ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r',
      lh: 'thigh_l', lk: 'calf_l', la: 'foot_l', rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r' };
    const rest = Object.fromEntries(Object.entries(joints).map(([key, bone]) => [key, worldOf(bone)]));
    rest.neck = rest.ls.map((value, i) => (value + rest.rs[i]) / 2);
    rest.hipMid = rest.lh.map((value, i) => (value + rest.rh[i]) / 2);
    const head = worldOf('head'), pelvis = worldOf('pelvis');
    if (mode === 'conservative') {
      rest.head = head; rest.pelvis = pelvis;
      const kps = copyVisiblePose(points, rest);
      const worldKps = Object.fromEntries(Object.entries(kps).filter(([key]) => WORLD_KEYPOINT_NAMES[key])
        .map(([key, value]) => [WORLD_KEYPOINT_NAMES[key], new THREE.Vector3(...value)]));
      const applied = viewer.applyWorldKeypointImport(worldKps, { drawFigure: false, placeHipRoots: false,
        alignHead: false, alignHands: false, alignFeet: false, dispatchPoseChange: false });
      if (!applied) throw new Error('复制可见关节失败，请检查人物照片');
      this.useRigPose(); this.syncPose(); this.updateShot(true);
      return false;
    }
    const { kps, facingAway } = liftOpenPose(points, rest, flips);
    const distance = Math.hypot(...head.map((value, i) => value - rest.neck[i]));
    const direction = kps.head.map((value, i) => value - kps.neck[i]);
    const norm = Math.hypot(...direction) || 1;
    kps.head = kps.neck.map((value, i) => value + direction[i] / norm * distance);
    const worldKps = Object.fromEntries(Object.entries(WORLD_KEYPOINT_NAMES).map(([key, name]) =>
      [name, new THREE.Vector3(...kps[key].map((value, i) => value + pelvis[i]))]));
    const applied = viewer.applyWorldKeypointImport(worldKps, { drawFigure: false, placeHipRoots: false, alignHead: false,
      alignHands: false, alignFeet: false, dispatchPoseChange: false });
    if (!applied) throw new Error('无法将 OpenPose 骨架应用到人偶，请检查骨架图');
    this.doc.pose = this.pose();
    this.updateShot(true);
    return facingAway;
  }

  captureOpenPose(width = this.doc.width, height = this.doc.height) {
    if (this.doc.source.kind !== 'human') throw new Error('OpenPose 引导图需要人偶场景');
    const canvas = document.createElement('canvas'); canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.fillStyle = '#000'; context.fillRect(0, 0, width, height);
    this.viewer.captureCamera.updateMatrixWorld(true);
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = Math.max(3, Math.min(width, height) / 120);
    for (const { positions, hands, features } of this.projectPeople(width, height)) {
    context.lineWidth = Math.max(3, Math.min(width, height) / 120);
    LIMBS.forEach(([from, to], index) => {
      if (!positions[ORDER[from]] || !positions[ORDER[to]]) return;
      context.strokeStyle = COLORS[index]; context.beginPath(); context.moveTo(...positions[ORDER[from]]);
      context.lineTo(...positions[ORDER[to]]); context.stroke();
    });
    ORDER.forEach((name, index) => {
      if (!positions[name]) return;
      context.fillStyle = COLORS[index]; context.beginPath();
      context.arc(...positions[name], Math.max(3, Math.min(width, height) / 85), 0, Math.PI * 2); context.fill();
    });
    for (const [name, color] of [['reye', '#ff00ff'], ['leye', '#aa00ff']]) if (features.nose && features[name]) {
      context.strokeStyle = color; context.beginPath(); context.moveTo(...features.nose); context.lineTo(...features[name]); context.stroke();
      context.fillStyle = color; context.beginPath(); context.arc(...features[name], Math.max(2, Math.min(width,height)/180), 0, Math.PI*2); context.fill();
    }
    for (const side of ['l', 'r']) if (hands?.[side]) {
      const points = hands[side];
      for (let finger = 0; finger < 5; finger++) for (let joint = 0; joint < 4; joint++) {
        const from = joint ? points[1+finger*4+joint-1] : points[0], to = points[1+finger*4+joint];
        if (!from || !to) continue;
        context.strokeStyle = `hsl(${finger*72+joint*12},100%,50%)`; context.lineWidth = Math.max(1, Math.min(width,height)/350);
        context.beginPath(); context.moveTo(...from); context.lineTo(...to); context.stroke();
      }
    }
    }
    return canvas.toDataURL('image/png');
  }

  projectPeople(width = this.doc.width, height = this.doc.height) {
    this.configureCapture(width, height); this.viewer.captureCamera.updateMatrixWorld(true);
    const camera = this.viewer.captureCamera;
    const actors = this.doc.actors?.length ? visibleActors(this.doc) : [{ id: null }];
    const names = { head: 'head', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r', ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l',
      rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r', lh: 'thigh_l', lk: 'calf_l', la: 'foot_l' };
    const meshes = actors.map(actor => actor.id ? this.actorMesh(actor.id) : this.viewer.skinnedMesh).filter(Boolean);
    meshes.forEach(mesh => { mesh.updateMatrixWorld(true); mesh.skeleton?.update(); mesh.computeBoundingSphere?.(); });
    const propMeshes = [];
    if (this.doc.conditioning?.poseOcclusion === 'visible') for (const prop of this.doc.props || []) {
      const root = prop.visible !== false && this.propRoots?.get(prop.id); if (!root) continue;
      root.updateMatrixWorld(true); root.traverseVisible(object => { if (object.isMesh) propMeshes.push(object); });
    }
    const raycaster = new THREE.Raycaster();
    return actors.map(actor => {
      const bones = actor.id ? this.actorBones(actor.id) : this.viewer.bones, positions = {}, visibility = {}, hands = {};
      const mesh = actor.id ? this.actorMesh(actor.id) : this.viewer.skinnedMesh;
      // Joint centers lie inside their own skin; only other actors and visible props occlude them.
      const occluders = this.doc.conditioning?.poseOcclusion === 'visible' ? [...meshes.filter(item => item !== mesh), ...propMeshes] : [];
      const projectWorld = world => {
        const point = world.clone().project(camera);
        if (point.z < -1 || point.z > 1) return null;
        if (this.doc.conditioning?.poseOcclusion === 'visible') {
          const vector = world.clone().sub(camera.position), distance = vector.length();
          raycaster.set(camera.position, vector.normalize()); raycaster.far = Math.max(0, distance - 0.01);
          if (raycaster.intersectObjects(occluders, false).length) return null;
        }
        return [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
      };
      const landmarks = actor.id && actor.id !== this.doc.activeActorId ? this.viewer.passiveCharacters.get(actor.id)?.modelLandmarkIndices : this.viewer.modelLandmarkIndices;
      const features = {};
      for (const [key, name] of [['nose','nose'], ['left_eye','leye'], ['right_eye','reye']]) if (landmarks?.[key]?.length && mesh?.getVertexPosition) {
        const center = new THREE.Vector3();
        for (const index of landmarks[key]) center.add(mesh.getVertexPosition(index, new THREE.Vector3()));
        features[name] = projectWorld(mesh.localToWorld(center.divideScalar(landmarks[key].length)));
      }
      for (const [name, bone] of Object.entries(names)) if (bones?.[bone]) {
        const world = bones[bone].getWorldPosition(new THREE.Vector3()), point = world.clone().project(camera);
        positions[name] = [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
        visibility[name] = point.z >= -1 && point.z <= 1;
        if (this.doc.conditioning?.poseOcclusion === 'visible') {
          const vector = world.clone().sub(camera.position), distance = vector.length();
          raycaster.set(camera.position, vector.normalize()); raycaster.far = Math.max(0, distance - 0.01);
          visibility[name] &&= raycaster.intersectObjects(occluders, false).length === 0;
        }
      }
      if (positions.ls && positions.rs) { positions.neck = positions.ls.map((value, i) => (value + positions.rs[i]) / 2); visibility.neck = visibility.ls || visibility.rs; }
      for (const name of Object.keys(positions)) if (!visibility[name]) delete positions[name];
      if (features.nose) positions.head = features.nose;
      if (this.doc.conditioning?.poseHands) for (const side of ['l', 'r']) {
        const hand = bones?.[`hand_${side}`]; if (!hand) continue;
        hands[side] = [projectWorld(hand.getWorldPosition(new THREE.Vector3()))];
        for (const finger of ['thumb', 'index', 'middle', 'ring', 'pinky']) {
          for (const index of ['01', '02', '03']) {
            const bone = bones[`${finger}_${index}_${side}`]; hands[side].push(bone ? projectWorld(bone.getWorldPosition(new THREE.Vector3())) : null);
          }
          const tip = bones[`${finger}_03_${side}`], head = tip?.userData.headPos, tail = tip?.userData.tailPos;
          hands[side].push(head && tail ? projectWorld(tip.localToWorld(new THREE.Vector3(...tail).sub(new THREE.Vector3(...head)))) : null);
        }
      }
      return { id: actor.id, positions, bones, hands, features };
    });
  }

  poseJSON(width = this.doc.width, height = this.doc.height) {
    return { version: '1.3', canvas_width: width, canvas_height: height,
      people: this.projectPeople(width, height).map(({ id, positions, features, hands }) => ({ actor_id: id,
        pose_keypoints_2d: Array.from({ length: 18 }, (_, i) => {
          // Head-bone location is not a measured nose landmark.
          const point = i === 0 ? features.nose : i === 14 ? features.reye : i === 15 ? features.leye : i < ORDER.length ? positions[ORDER[i]] : null;
          return point ? [...point, 1] : [0, 0, 0];
        }).flat(), face_keypoints_2d: [], hand_left_keypoints_2d: (hands.l || []).flatMap(point => point ? [...point,1] : [0,0,0]),
        hand_right_keypoints_2d: (hands.r || []).flatMap(point => point ? [...point,1] : [0,0,0]) })) };
  }

  groundActors(ids = [this.doc.activeActorId]) {
    const floor = this.grid?.position ? this.grid.position.y + 0.03 : 0;
    for (const actor of this.doc.actors || []) if (ids.includes(actor.id) && !actor.locked) {
      const mesh = this.actorMesh(actor.id); if (!mesh) continue;
      actor.transform.y += floor - worldBounds(mesh).min.y;
      this.updateActorTransform(actor);
    }
  }

  async alignHands(idA, sideA, idB, sideB) {
    const actors = [idA,idB].map(id=>this.doc.actors.find(actor=>actor.id===id));
    if (actors.some(actor=>!actor||actor.locked)) throw new Error('手部对齐需要两位未锁定人物');
    const handA=this.actorBones(idA)?.[`hand_${sideA}`], handB=this.actorBones(idB)?.[`hand_${sideB}`];
    if(!handA||!handB) throw new Error('人物缺少手部骨架');
    this.viewer.scene.updateMatrixWorld(true);
    const anchor=handA.getWorldPosition(new THREE.Vector3()).add(handB.getWorldPosition(new THREE.Vector3())).multiplyScalar(.5);
    const active=this.doc.activeActorId;
    for(const[id,side]of [[idA,sideA],[idB,sideB]]){
      await this.selectActor(id);const controller=this.viewer.ikController,key=controller.getChainForEffector(`hand_${side}`),old=controller.getMode(key);
      controller.setMode(key,'ik');try { for(let i=0;i<8;i++)controller.solve(this.viewer.bones,new Map([[`hand_${side}`,anchor]])); }
      finally{controller.setMode(key,old);}
      this.viewer.updateIKEffectorPositions();this.viewer.updateMarkers();this.syncPose();
    }
    await this.selectActor(active);this.doc.contacts=[{id:crypto.randomUUID(),actors:[idA,idB],sides:[sideA,sideB],anchor:anchor.toArray(),mode:'align-once'}];
    this.useRigPose();this.viewer.requestRender();
  }

  async morph() {
    const pose = { bones: this.pose().bones, modelRotation: this.pose().modelRotation };
    this.restoring = true;
    try {
      this.buildHuman(pose);
      // Body changes preserve the common scene target and every camera setting.
      this.setMode(this.mode);
      this.syncPose();
      await this.waitForCaptureReady();
    } finally { this.restoring = false; }
  }

  bindCamera() {
    const canvas = this.canvas;
    let drag = null;
    const beginChange = () => {
      if (!drag.changed) { drag.rollback = this.callbacks.begin(); drag.changed = true; }
    };
    const end = () => {
      if (!drag) return;
      const changed = drag.changed; drag = null;
      if (changed) this.callbacks.change();
    };
    canvas.addEventListener('pointerdown', event => {
      if (event.button !== 0 && event.button !== 1) return;
      if (drag) { event.stopImmediatePropagation(); event.preventDefault(); return; }
      const ray = () => {
        const rect = canvas.getBoundingClientRect(), raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.viewer.camera);
        return raycaster;
      };
      if (this.mode !== 'camera' && event.button === 0 && !event.shiftKey && this.doc.source.kind === 'human') {
        const mesh = visibleActors(this.doc).map(actor => this.actorMesh(actor.id)).filter(Boolean);
        for (const item of mesh) { item.updateMatrixWorld(true); item.skeleton.update(); item.computeBoundingBox(); item.computeBoundingSphere(); }
        const raycaster = ray(), hit = raycaster.intersectObjects(mesh, false)[0];
        const id = hit?.object.userData.actorId;
        if (id && (id !== this.doc.activeActorId || event.ctrlKey || event.metaKey)) {
          event.stopImmediatePropagation(); event.preventDefault(); this.callbacks.pick?.(id, event.ctrlKey || event.metaKey); return;
        }
        if (this.mode === 'position') {
          event.stopImmediatePropagation(); event.preventDefault();
          const actor = activeActor(this.doc);
          if (!hit || !actor || actor.locked) return;
          const normal = this.doc.interaction?.movePlane === 'ground' ? new THREE.Vector3(0, 1, 0) : this.viewer.camera.getWorldDirection(new THREE.Vector3());
          const root = this.actorRoots.get(actor.id), plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, root.position);
          const point = raycaster.ray.intersectPlane(plane, new THREE.Vector3()); if (!point) return;
          drag = { pointerId: event.pointerId, actor: actor.id, plane, point, transform: { ...actor.transform } };
          canvas.setPointerCapture(event.pointerId); return;
        }
        return;
      }
      // Non-photo view navigation belongs to OrbitControls; it leaves the shot intact.
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      drag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, camera: { ...this.doc.camera }, pan: event.button === 1 || event.shiftKey };
      if (drag.pan && this.doc.source.kind !== 'splat') drag.panQuaternion = this.viewer.captureCamera.quaternion.clone();
      canvas.setPointerCapture(event.pointerId);
    }, true);
    canvas.addEventListener('auxclick', event => { if (this.mode === 'camera' && event.button === 1) event.preventDefault(); });
    canvas.addEventListener('pointermove', event => {
      if (this.mode === 'camera' || drag) event.stopImmediatePropagation();
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (drag.actor) {
        const actor = this.doc.actors.find(item => item.id === drag.actor); if (!actor || actor.locked) return;
        const rect = canvas.getBoundingClientRect(), raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, 1 - (event.clientY - rect.top) / rect.height * 2), this.viewer.camera);
        const point = raycaster.ray.intersectPlane(drag.plane, new THREE.Vector3()); if (!point) return;
        const delta = point.sub(drag.point);
        const next = { x: drag.transform.x + delta.x, y: drag.transform.y + delta.y, z: drag.transform.z + delta.z };
        if (Object.entries(next).every(([key, value]) => actor.transform[key] === value)) return;
        beginChange(); Object.assign(actor.transform, next);
        this.updateActorTransform(actor); this.callbacks.camera(); return;
      }
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      const next = { ...drag.camera };
      if (drag.pan) {
        const delta = new THREE.Vector3(dx * 0.025, -dy * 0.025, 0);
        // Human/GLB offsets are stored in world axes; splat offsets are camera-local.
        if (drag.panQuaternion) delta.applyQuaternion(drag.panQuaternion);
        next.offsetX = drag.camera.offsetX + delta.x;
        next.offsetY = drag.camera.offsetY + delta.y;
        next.offsetZ = (drag.camera.offsetZ || 0) + delta.z;
      } else {
        if (dx) next.azimuth = ((drag.camera.azimuth - dx * 0.35 + 540) % 360) - 180;
        if (dy && this.doc.interaction?.mousePitch !== false)
          next.elevation = clamp(drag.camera.elevation + dy * 0.25, -89, 89);
      }
      if (Object.entries(next).every(([key, value]) => this.doc.camera[key] === value)) return;
      beginChange(); Object.assign(this.doc.camera, next);
      this.updateShot(); this.callbacks.camera();
    }, true);
    canvas.addEventListener('pointerup', event => { if (drag && event.pointerId === drag.pointerId) { event.stopImmediatePropagation(); end(); } }, true);
    const cancel = event => { if (drag && event.pointerId === drag.pointerId) this.cancelDrag(); };
    canvas.addEventListener('pointercancel', cancel, true);
    canvas.addEventListener('lostpointercapture', cancel, true);
    canvas.addEventListener('wheel', event => {
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      const zoom = clamp(this.doc.camera.zoom * Math.exp(-event.deltaY * 0.001), 0.1, 8);
      if (zoom === this.doc.camera.zoom) return;
      this.callbacks.begin(); this.doc.camera.zoom = zoom;
      this.updateShot(); this.callbacks.change();
    }, { capture: true, passive: false });
    this.cancelDrag = () => {
      if (!drag) return false;
      const cancelled = drag; drag = null;
      if (!cancelled.changed) return true;
      if (cancelled.actor) {
        const actor = this.doc.actors.find(item => item.id === cancelled.actor);
        if (actor) { actor.transform = cancelled.transform; this.updateActorTransform(actor); }
      } else this.doc.camera = cancelled.camera;
      cancelled.rollback?.();
      this.updateShot(); this.callbacks.camera(); return true;
    };
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.splat?.dispose();
    this.actorRoots?.clear();
    this.morphCache?.clear(); this.morphCacheBytes = 0; this.humanStatic = null; this.cachedPack = null; this.pack = null;
    // GLB props, the main GLB and line helpers remain attached: the viewer owns
    // their final disposal and deduplicates shared geometry/material/texture.
    this.propRoots?.clear();
    this.viewer.dispose();
    this.glb = null; this.glbName = null;
    this.grid = this.ring = this.photoFrame = this.shotHelper = null;
  }
}
