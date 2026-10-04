// A fixed 24 mm vertical sensor keeps lens values consistent across output ratios.
export function lensSettings(originalFov, focalLength = 0) {
  const originalFocal = 12 / Math.tan(originalFov * Math.PI / 360);
  if (!focalLength) return { fov: originalFov, distanceScale: 1 };
  if (!Number.isFinite(focalLength) || focalLength <= 0) throw new Error('焦距必须是大于零的数值');
  return { fov: 2 * Math.atan(12 / focalLength) * 180 / Math.PI, distanceScale: focalLength / originalFocal };
}

export function applyLens(camera, target, focalLength) {
  const lens = lensSettings(camera.fov, focalLength);
  camera.position.sub(target).multiplyScalar(lens.distanceScale).add(target);
  camera.fov = lens.fov;
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
}
