export function randomPose(seed, category = 'mixed') {
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error('姿势种子应为 0–4294967295 的整数');
  if (!['mixed', 'standing', 'action', 'seated'].includes(category)) throw new Error('未知的随机姿势类型');
  let state = seed >>> 0;
  const sample = (min, max) => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ state >>> 15, 1 | state);
    value ^= value + Math.imul(value ^ value >>> 7, 61 | value);
    return min + (((value ^ value >>> 14) >>> 0) / 4294967296) * (max - min);
  };
  if (category === 'mixed') category = ['standing', 'action', 'seated'][Math.floor(sample(0, 3))];
  const bones = { head: [sample(-8, 8), sample(-20, 20), sample(-8, 8)], spine_03: [sample(-5, 8), sample(-12, 12), sample(-5, 5)] };
  for (const [side, sign] of [['l', 1], ['r', -1]]) {
    const active = category === 'action';
    bones[`upperarm_${side}`] = [sample(-20, 30), sample(-12, 12), sign * sample(-12, active ? 125 : 35)];
    bones[`lowerarm_${side}`] = [sample(-75, -5), 0, sign * sample(0, 20)];
    bones[`thigh_${side}`] = category === 'seated' ? [sample(-95, -75), 0, sign * sample(-12, 2)]
      : [sample(active ? -30 : -6, active ? 20 : 6), 0, sign * sample(-9, 0)];
    bones[`calf_${side}`] = [sample(category === 'seated' ? 75 : 2, category === 'seated' ? 105 : active ? 45 : 12), 0, 0];
  }
  return { bones };
}
