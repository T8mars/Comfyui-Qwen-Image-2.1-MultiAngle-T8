import * as THREE from '../vendor/three.module.mjs';
import { GLTFLoader } from '../vendor/GLTFLoader.mjs';
import { PoseViewerCore } from '../vendor/vnccs_pose_studio_core.mjs';
import { loadMorphPack, solveMorph, buildStaticModelData } from '../vendor/vnccs_pose_morph_runtime.mjs';
import { HAND_PRESETS } from '../vendor/vnccs_hand_presets.mjs';
import { SplatScene } from './splat.mjs';
import { capturePNG } from './capture.mjs?v=20261002a';
import { liftOpenPose, WORLD_KEYPOINT_NAMES, ORDER, LIMBS, COLORS } from './openpose.mjs';

export const PRESETS = [
  { name: '自然站立', bones: { upperarm_l: [0, 0, -8], upperarm_r: [0, 0, 8] } },
  { name: '迈步', bones: { thigh_l: [-25, 0, 0], calf_l: [16, 0, 0], thigh_r: [20, 0, 0], calf_r: [9, 0, 0], upperarm_l: [20, 0, -8], upperarm_r: [-20, 0, 8] } },
  { name: '坐姿', bones: { thigh_l: [-85, 0, -5], thigh_r: [-85, 0, 5], calf_l: [85, 0, 0], calf_r: [85, 0, 0], lowerarm_l: [-45, 0, 0], lowerarm_r: [-45, 0, 0] } },
  { name: '举手', bones: { upperarm_l: [0, 0, 100], lowerarm_l: [0, 0, 20], upperarm_r: [0, 0, 10] } },
];
export const defaultScene = () => ({
  version: 1, width: 1024, height: 1024,
  source: { kind: 'empty' }, reference: null,
  reconstruction: { keepBackground: false },
  camera: { azimuth: 35, elevation: 8, zoom: 1.3, offsetX: 0, offsetY: 0, offsetZ: 0 },
  mesh: { age: 25, gender: 0.5, weight: 0.5, muscle: 0.5, height: 0.5, breast_size: 0, firmness: 0.5, show_genitals: false },
  pose: { bones: PRESETS[0].bones }, shots: [], front: 0, scale: 1,
  background: '#69717b',
  conditioning: { model: 'anyangle', guide: 'coarse', map: null, cannyLow: 50, cannyHigh: 150 },
  openpose: null,
});
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
    const animateSplat = () => {
      if (this.disposed) return;
      if (this.doc.source.kind === 'splat') this.viewer.requestRender();
      this.splatFrame = requestAnimationFrame(animateSplat);
    };
    animateSplat();
  }

  resize() {
    const { width, height } = this.canvas.parentElement.getBoundingClientRect();
    this.viewer.resize(Math.max(1, width), Math.max(1, height));
    if (this.mode === 'camera' && this.baseTarget) this.updateShot();
  }

  buildHuman(pose) {
    const morph = solveMorph(this.pack, this.doc.mesh);
    this.viewer.setSkinTexture('naked');
    this.viewer.loadData(modelData(morph, buildStaticModelData(this.pack, false)), true);
    this.viewer.setPose(pose || { bones: {} }, true);
    this.viewer.setActiveCharacterAppearance({ color: '#e3e9ee', transform: { x: 0, y: 0, z: 0, zoom: this.doc.scale } });
  }

  async restore(doc) {
    this.restoring = true;
    try {
      this.doc = doc;
      if (doc.source.kind !== 'splat') [this.viewer.camera, this.viewer.captureCamera].forEach((camera, i) => {
        camera.clearViewOffset(); camera.near = this.cameraClips[i].near; camera.far = this.cameraClips[i].far;
        camera.up.set(0, 1, 0); camera.updateProjectionMatrix();
      });
      if (this.splat && doc.source.kind !== 'splat') { await this.splat.dispose(); this.splat = null; }
      if (this.glb && doc.source.kind !== 'glb') { disposeObject(this.glb); this.glb = null; this.glbName = null; }
      if (doc.source.kind === 'human') {
        if (!this.pack) {
          try { this.pack = await loadMorphPack(new URL('../vendor/assets/pose_studio_makehuman.v2.bin', import.meta.url)); }
          catch (error) { throw new Error(`MakeHuman 编辑资源缺失或损坏。请更新节点，或在节点目录运行 python install_assets.py。${error.message}`); }
        }
        this.buildHuman(doc.pose);
        this.baseTarget = this.viewer.meshCenter.clone().multiplyScalar(doc.scale);
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
      const bounds = doc.source.kind === 'splat' ? this.splat.bounds
        : doc.source.kind === 'empty' ? new THREE.Box3(new THREE.Vector3(-10, 0, -10), new THREE.Vector3(10, 20, 10))
        : worldBounds(doc.source.kind === 'human' ? this.viewer.skinnedMesh : this.glb);
      this.grid.position.y = bounds.min.y - 0.03;
      this.ring.position.copy(this.baseTarget);
      this.ring.visible = doc.source.kind !== 'splat' && doc.source.kind !== 'empty';
      this.setMode(this.mode);
      this.updateShot(true);
      await this.viewer.waitForCaptureReady();
    } finally { this.restoring = false; }
  }

  pose() {
    const { camera, cameraParams, ...pose } = this.viewer.getPose();
    return pose;
  }

  syncPose() { if (this.doc.source.kind === 'human') this.doc.pose = this.pose(); }

  updateShot(snap = false) {
    const d = this.doc, c = d.camera;
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
    this.viewer.updateCaptureCamera(d.width, d.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
    this.viewer.captureFrame.visible = true;
    if (snap || this.mode === 'camera') {
      // Fit the complete output frame inside a differently-shaped editor viewport.
      const framing = 1.12 * Math.max(1, (d.width / d.height) / this.viewer.camera.aspect);
      this.viewer.camera.fov = degrees(2 * Math.atan(Math.tan(radians(15)) * framing));
      this.viewer.snapToCaptureCamera(d.width, d.height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
      this.viewer.captureFrame.visible = true;
    }
    this.shotHelper.update();
    this.shotHelper.visible = this.mode === 'edit';
    this.viewer.requestRender();
  }

  setMode(mode) {
    if (this.doc.source.kind === 'splat' || this.doc.source.kind === 'empty') mode = 'camera';
    this.mode = mode;
    const human = this.doc.source.kind === 'human';
    this.viewer.setIKMode(mode === 'edit' && human);
    this.viewer.transform.detach();
    this.viewer.transform.visible = mode === 'edit' && human;
    this.viewer.skeletonHelper && (this.viewer.skeletonHelper.visible = false);
    this.viewer.jointMarkers.forEach(marker => { marker.visible = mode === 'edit' && human && this.viewer._shouldMarkerBeVisible(marker); });
    this.viewer.orbit.enabled = mode === 'edit';
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

  async capture(width = this.doc.width, height = this.doc.height) {
    if (this.doc.source.kind === 'empty') throw new Error('请先从原图重建主体或导入对应的 3D 场景');
    await this.viewer.waitForCaptureReady();
    const v = this.viewer, c = this.doc.camera;
    const content = this.splat ? this.splat.root : this.doc.source.kind === 'glb' ? this.glb : v.skinnedMesh;
    if (!content) throw new Error('场景中没有可渲染资产');
    const visibility = v.scene.children.map(object => [object, object.visible]);
    // VNCCS attaches joint markers below the skinned mesh, not just to the scene.
    const nestedHelpers = this.doc.source.kind === 'human'
      ? [...v.jointMarkers, ...Object.values(v.ikController?.effectors || {}),
        ...Object.values(v.ikController?.poleTargets || {}), ...(v._handRings || [])]
        .filter(Boolean).map(object => [object, object.visible]) : [];
    const background = v.scene.background;
    this.capturing = true;
    let restoreSplat = null;
    try {
      if (v._renderFrame) { cancelAnimationFrame(v._renderFrame); v._renderFrame = null; }
      if (this.splat) this.splat.configureCamera(v.captureCamera, this.doc, width, height);
      else v.updateCaptureCamera(width, height, c.zoom, c.offsetX, c.offsetY, c.azimuth, -c.elevation);
      // Pointer input may update the live cameras while sorting awaits a worker.
      const camera = v.captureCamera.clone();
      if (this.splat) {
        restoreSplat = this.splat.beginOffscreenCapture(width, height);
        await this.splat.prepareCapture(v.renderer, camera);
      }
      // Positive content selection excludes every editor overlay, even newly added helpers.
      for (const [object] of visibility) object.visible = object === content || !!object.isLight;
      for (const [object] of nestedHelpers) object.visible = false;
      v.scene.background = new THREE.Color(this.doc.background);
      // The bundled splat shader writes already encoded RGB, unlike Three's
      // standard mesh materials. Preserve those colors and its background.
      if (this.splat) v.scene.background.convertLinearToSRGB();
      v.scene.updateMatrixWorld(true);
      v.skeleton?.update();
      return capturePNG(v.renderer, v.scene, camera, width, height,
        this.splat ? THREE.NoColorSpace : THREE.SRGBColorSpace);
    } finally {
      for (const [object, visible] of visibility) object.visible = visible;
      for (const [object, visible] of nestedHelpers) object.visible = visible;
      v.scene.background = background;
      try { restoreSplat?.(); }
      finally { this.capturing = false; this.updateShot(); }
    }
  }

  fit() {
    if (this.doc.source.kind === 'splat') {
      this.doc.camera = { azimuth: 0, elevation: 0, zoom: 1, offsetX: 0, offsetY: 0, offsetZ: 0 };
      this.updateShot(true); return;
    }
    if (this.doc.source.kind === 'empty') return;
    const content = this.doc.source.kind === 'glb' ? this.glb : this.viewer.skinnedMesh;
    const bounds = worldBounds(content);
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
    this.viewer.setPose({ bones: preset.bones }, true);
    this.syncPose();
    this.setMode(this.mode);
  }

  hand(side, preset) { this.viewer.applyHandPreset(side, HAND_PRESETS[preset]); this.syncPose(); }

  applyOpenPose(points, flips = {}) {
    if (this.doc.source.kind !== 'human') throw new Error('OpenPose 姿势需要先切换到人偶');
    const viewer = this.viewer;
    viewer.resetPose();
    viewer.skinnedMesh.updateMatrixWorld(true);
    const worldOf = name => viewer.bones[name].getWorldPosition(new THREE.Vector3()).toArray();
    const joints = { ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r',
      lh: 'thigh_l', lk: 'calf_l', la: 'foot_l', rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r' };
    const rest = Object.fromEntries(Object.entries(joints).map(([key, bone]) => [key, worldOf(bone)]));
    rest.neck = rest.ls.map((value, i) => (value + rest.rs[i]) / 2);
    rest.hipMid = rest.lh.map((value, i) => (value + rest.rh[i]) / 2);
    const head = worldOf('head'), pelvis = worldOf('pelvis');
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
    const project = bone => {
      const point = this.viewer.bones[bone].getWorldPosition(new THREE.Vector3()).project(this.viewer.captureCamera);
      return [(point.x + 1) * width / 2, (1 - point.y) * height / 2];
    };
    const bones = { head: 'head', rs: 'upperarm_r', re: 'lowerarm_r', rw: 'hand_r', ls: 'upperarm_l', le: 'lowerarm_l', lw: 'hand_l',
      rh: 'thigh_r', rk: 'calf_r', ra: 'foot_r', lh: 'thigh_l', lk: 'calf_l', la: 'foot_l' };
    const positions = Object.fromEntries(Object.entries(bones).map(([name, bone]) => [name, project(bone)]));
    positions.neck = positions.ls.map((value, i) => (value + positions.rs[i]) / 2);
    context.lineCap = 'round'; context.lineJoin = 'round'; context.lineWidth = Math.max(3, Math.min(width, height) / 120);
    LIMBS.forEach(([from, to], index) => {
      context.strokeStyle = COLORS[index]; context.beginPath(); context.moveTo(...positions[ORDER[from]]);
      context.lineTo(...positions[ORDER[to]]); context.stroke();
    });
    ORDER.forEach((name, index) => {
      context.fillStyle = COLORS[index]; context.beginPath();
      context.arc(...positions[name], Math.max(3, Math.min(width, height) / 85), 0, Math.PI * 2); context.fill();
    });
    return canvas.toDataURL('image/png');
  }

  async morph() {
    const pose = { bones: this.pose().bones, modelRotation: this.pose().modelRotation };
    this.restoring = true;
    try {
      this.buildHuman(pose);
      this.baseTarget = this.viewer.meshCenter.clone().multiplyScalar(this.doc.scale);
      this.setMode(this.mode);
      this.syncPose();
      await this.viewer.waitForCaptureReady();
    } finally { this.restoring = false; }
  }

  bindCamera() {
    const canvas = this.canvas;
    let drag = null;
    const end = () => { if (drag) { drag = null; this.callbacks.change(); } };
    canvas.addEventListener('pointerdown', event => {
      if (this.mode !== 'camera' || (event.button !== 0 && event.button !== 1)) return;
      event.stopImmediatePropagation(); event.preventDefault();
      this.callbacks.begin();
      drag = { x: event.clientX, y: event.clientY, camera: { ...this.doc.camera }, pan: event.button === 1 || event.shiftKey };
      canvas.setPointerCapture(event.pointerId);
    }, true);
    canvas.addEventListener('auxclick', event => { if (this.mode === 'camera' && event.button === 1) event.preventDefault(); });
    canvas.addEventListener('pointermove', event => {
      if (this.mode === 'camera') event.stopImmediatePropagation();
      if (!drag) return;
      const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
      if (drag.pan) {
        this.doc.camera.offsetX = drag.camera.offsetX + dx * 0.025;
        this.doc.camera.offsetY = drag.camera.offsetY - dy * 0.025;
      } else {
        this.doc.camera.azimuth = ((drag.camera.azimuth - dx * 0.35 + 540) % 360) - 180;
        this.doc.camera.elevation = clamp(drag.camera.elevation + dy * 0.25, -89, 89);
      }
      this.updateShot(); this.callbacks.camera();
    }, true);
    canvas.addEventListener('pointerup', event => { if (drag) { event.stopImmediatePropagation(); end(); } }, true);
    canvas.addEventListener('pointercancel', end, true);
    canvas.addEventListener('wheel', event => {
      if (this.mode !== 'camera') return;
      event.stopImmediatePropagation(); event.preventDefault();
      this.callbacks.begin();
      this.doc.camera.zoom = clamp(this.doc.camera.zoom * Math.exp(-event.deltaY * 0.001), 0.1, 8);
      this.updateShot(); this.callbacks.change();
    }, { capture: true, passive: false });
    this.cancelDrag = () => {
      if (!drag) return false;
      this.doc.camera = drag.camera; drag = null;
      this.updateShot(); this.callbacks.change(); return true;
    };
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.splatFrame);
    this.resizeObserver?.disconnect();
    this.splat?.dispose();
    this.viewer.dispose();
  }
}
