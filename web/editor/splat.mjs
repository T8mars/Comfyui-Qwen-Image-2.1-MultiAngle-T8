import * as THREE from '../vendor/three.module.mjs';
import { DropInViewer, SceneFormat, SceneRevealMode } from '../vendor/gaussian-splats-3d.mjs';
import { lensSettings } from './lens.mjs?v=20261004c';

const radians = THREE.MathUtils.degToRad;

export function decodeCameraToken(token) {
  if (!Array.isArray(token) || token.length !== 5 || !token.every(Number.isFinite)) {
    throw new Error('重建结果缺少有效的 5 维相机参数');
  }
  const direction = new THREE.Vector3(token[0], token[2], -token[1]);
  if (direction.lengthSq() < 1e-12 || token[4] <= 0) throw new Error('重建相机方向或视野无效');
  direction.normalize();
  const orthographic = token[3] < 0.001;
  const radius = orthographic ? 1000 : 1 / token[3];
  return { direction, radius, fov: THREE.MathUtils.radToDeg(2 * Math.atan(token[4] / radius)), orthographic };
}

function normalization(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 2 || bounds.some(v => !Array.isArray(v) || v.length !== 3 || !v.every(Number.isFinite))) {
    throw new Error('重建结果缺少有效的场景范围');
  }
  const box = new THREE.Box3(new THREE.Vector3(...bounds[0]), new THREE.Vector3(...bounds[1]));
  const size = box.getSize(new THREE.Vector3());
  const longest = Math.max(size.x, size.y, size.z);
  if (box.isEmpty() || longest <= 0) throw new Error('重建场景范围为空');
  const scale = 20 / longest;
  const center = box.getCenter(new THREE.Vector3());
  const offset = new THREE.Vector3(-center.x, -box.min.y, -center.z).multiplyScalar(scale);
  box.min.multiplyScalar(scale).add(offset);
  box.max.multiplyScalar(scale).add(offset);
  return { box, scale, offset };
}

// The predicted camera is approximate; this reverses the known preprocessing crop,
// not an assertion that the model recovered the physical camera of the photograph.
export function configureSplatCamera(camera, source, controls, width, height, matrixWorld = new THREE.Matrix4()) {
  if (!camera.isPerspectiveCamera) throw new Error('高斯机位需要透视相机');
  const predicted = decodeCameraToken(source.camera_token);
  const lens = lensSettings(predicted.fov, controls.focalLength || 0);
  const normalized = normalization(source.bounds);
  const reference = source.reference;
  const crop = source.crop;
  if (!reference || !(reference.width > 0 && reference.height > 0) ||
      !Array.isArray(crop) || crop.length !== 4 || !crop.every(Number.isFinite) ||
      crop[2] <= crop[0] || crop[3] <= crop[1] || !(width > 0 && height > 0)) {
    throw new Error('重建结果缺少原图尺寸或裁切参数');
  }
  if (!Number.isFinite(controls.zoom) || controls.zoom <= 0) throw new Error('构图缩放必须大于零');

  const azimuth = Math.atan2(predicted.direction.x, predicted.direction.z) + radians(controls.azimuth || 0);
  const elevation = THREE.MathUtils.clamp(Math.asin(predicted.direction.y) + radians(controls.elevation || 0), -Math.PI / 2 + 1e-5, Math.PI / 2 - 1e-5);
  const direction = new THREE.Vector3(Math.sin(azimuth) * Math.cos(elevation), Math.sin(elevation), Math.cos(azimuth) * Math.cos(elevation));
  const target = normalized.offset.clone().applyMatrix4(matrixWorld);
  camera.position.copy(direction).multiplyScalar(predicted.radius * normalized.scale * lens.distanceScale).add(normalized.offset).applyMatrix4(matrixWorld);
  camera.up.set(0, 1, 0).transformDirection(matrixWorld);
  camera.lookAt(target);

  const backward = camera.position.clone().sub(target).normalize();
  const right = new THREE.Vector3().crossVectors(camera.up, backward).normalize();
  const up = new THREE.Vector3().crossVectors(backward, right).normalize();
  const pan = right.multiplyScalar(-(controls.offsetX || 0)).addScaledVector(up, -(controls.offsetY || 0)).addScaledVector(backward, -(controls.offsetZ || 0));
  camera.position.add(pan);
  target.add(pan);

  const worldScale = new THREE.Vector3().setFromMatrixScale(matrixWorld).length() / Math.sqrt(3);
  const extent = normalized.box.getSize(new THREE.Vector3()).length() * worldScale;
  const distance = camera.position.distanceTo(target);
  camera.near = Math.max(0.01, distance - extent * 2);
  camera.far = Math.max(camera.near + 1, distance + extent * 2);
  camera.fov = lens.fov;
  camera.zoom = controls.zoom;
  camera.filmOffset = 0;

  // A square prepared image is the full sensor. Expand its off-axis viewport back
  // into the source image, containing that frame if the requested aspect changes.
  const aspect = width / height;
  const frameWidth = Math.max(reference.width, reference.height * aspect);
  const frameHeight = Math.max(reference.height, reference.width / aspect);
  const cropWidth = crop[2] - crop[0], cropHeight = crop[3] - crop[1];
  camera.setViewOffset(1, 1,
    (-(frameWidth - reference.width) / 2 - crop[0]) / cropWidth,
    (-(frameHeight - reference.height) / 2 - crop[1]) / cropHeight,
    frameWidth / cropWidth, frameHeight / cropHeight);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  return target;
}

export class SplatScene {
  constructor(viewerCore) {
    this.core = viewerCore;
    this.root = new THREE.Group();
    this.root.name = 'AnyAngleSplat';
    this._bounds = new THREE.Box3();
    this._target = new THREE.Vector3();
    this.dropIn = null;
    this.source = null;
    this.disposed = false;
  }

  get bounds() {
    this.root.updateWorldMatrix(true, false);
    return this._bounds.clone().applyMatrix4(this.root.matrixWorld);
  }

  get target() {
    this.root.updateWorldMatrix(true, false);
    return this._target.clone().applyMatrix4(this.root.matrixWorld);
  }

  async load(source) {
    if (this.disposed || this.dropIn) throw new Error('请为新的重建资产创建独立场景');
    decodeCameraToken(source.camera_token);
    const normalized = normalization(source.bounds);
    this.source = source;
    this._bounds.copy(normalized.box);
    this._target.copy(normalized.offset);
    const dropIn = new DropInViewer({
      sharedMemoryForWorkers: false, gpuAcceleratedSort: false, integerBasedSort: false,
      sphericalHarmonicsDegree: 0, sceneRevealMode: SceneRevealMode.Instant,
      dynamicScene: false,
    });
    this.dropIn = dropIn;
    this.root.add(dropIn);
    const viewer = dropIn.viewer;
    this.watchSort(viewer);
    // 0.4.7's tree culling ignores off-axis projection. Keep all nodes available
    // for the uncropped reference frame; sorting still runs in its local worker.
    const gather = viewer.gatherSceneNodesForSort.bind(viewer);
    viewer.gatherSceneNodesForSort = () => gather(true);
    try {
      viewer.updateForDropInMode(this.core.renderer, this.core.camera);
      await dropIn.addSplatScene(`/anyangle-studio/assets/${encodeURIComponent(source.name)}`, {
        format: SceneFormat.Ply, showLoadingUI: false, progressiveLoad: false,
        rotation: [1, 0, 0, 0], scale: [normalized.scale, normalized.scale, normalized.scale],
        position: normalized.offset.toArray(),
      });
      if (this.disposed) throw new Error('重建场景已关闭');
      this.root.updateMatrixWorld(true);
    } catch (error) {
      await this.dispose();
      throw error;
    }
  }

  configureCamera(camera, doc, width, height) {
    this.root.updateWorldMatrix(true, false);
    return configureSplatCamera(camera, this.source, doc.camera, width, height, this.root.matrixWorld);
  }

  watchSort(viewer) {
    const runSort = viewer.runSplatSort.bind(viewer);
    viewer.runSplatSort = (...args) => {
      const started = runSort(...args);
      started.then(() => {
        const completion = viewer.sortPromise;
        if (!completion || completion === this.pendingSort || this.disposed) return;
        this.pendingSort = completion;
        completion.then(() => { if (!this.disposed) this.core.requestRender(); });
      });
      return started;
    };
  }

  async prepareCapture(renderer, camera) {
    if (this.disposed || !this.dropIn?.viewer.splatRenderReady) throw new Error('高斯场景尚未准备完成');
    const viewer = this.dropIn.viewer;
    await viewer.sortPromise;
    this.root.updateWorldMatrix(true, true);
    camera.updateMatrixWorld(true);
    viewer.updateForDropInMode(renderer, camera);
    // runSplatSort resolves after dispatch, while sortPromise resolves on sortDone.
    // Drain any partial sorts left by the interactive camera before the full sort.
    for (let i = 0; i < 5; i++) {
      await viewer.runSplatSort(true, true);
      await viewer.sortPromise;
      if (this.disposed) throw new Error('高斯场景已关闭');
      if (viewer.lastSplatSortCount === viewer.splatRenderCount) {
        viewer.updateSplatMesh();
        return;
      }
    }
    throw new Error('高斯排序尚未完成，请重试导出');
  }

  beginOffscreenCapture(width, height) {
    const viewer = this.dropIn.viewer;
    const dimensions = viewer.getRenderDimensions;
    const pixelRatio = viewer.devicePixelRatio;
    const meshPixelRatio = viewer.splatMesh.devicePixelRatio;
    viewer.getRenderDimensions = out => { out.set(width, height); };
    viewer.devicePixelRatio = 1;
    viewer.splatMesh.devicePixelRatio = 1;
    return () => {
      viewer.getRenderDimensions = dimensions;
      viewer.devicePixelRatio = pixelRatio;
      viewer.splatMesh.devicePixelRatio = meshPixelRatio;
      viewer.updateForDropInMode(this.core.renderer, this.core.camera);
      viewer.updateSplatMesh();
    };
  }

  async dispose() {
    if (this.disposed) return this.disposePromise;
    this.disposed = true;
    this.root.removeFromParent();
    const dropIn = this.dropIn;
    this.disposePromise = (async () => {
      if (!dropIn) return;
      try { await dropIn.dispose(); }
      finally {
        // DropInViewer.dispose releases its viewer, but not this callback mesh.
        dropIn.callbackMesh.geometry.dispose();
        dropIn.callbackMesh.material.dispose();
        this.root.clear();
        this.dropIn = null;
      }
    })();
    return this.disposePromise;
  }
}
