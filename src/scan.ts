// 波长扫描、角度扫描、双膜系谱差异比较、极小反射点查询。
import { computePoint, PointResult, Pol, Stack } from "./optics.js";

export interface WavelengthScan {
  startNm: number;
  stopNm: number;
  stepNm: number;
}
export interface AngleScan {
  startDeg: number;
  stopDeg: number;
  stepDeg: number;
}

export function linspace(start: number, stop: number, step: number): number[] {
  if (!(step > 0)) throw new Error("步长必须为正数");
  if (stop < start) throw new Error("终止值不能小于起始值");
  const n = Math.round((stop - start) / step);
  const out: number[] = [];
  for (let i = 0; i <= n; i++) out.push(start + i * step);
  // 保证包含终点（若步长不整除）
  if (Math.abs(out[out.length - 1] - stop) > 1e-9) out.push(stop);
  return out;
}

export function wavelengthScan(
  stack: Stack,
  scan: WavelengthScan,
  angleDeg: number,
  pols: Pol[],
): PointResult[] {
  const out: PointResult[] = [];
  for (const wl of linspace(scan.startNm, scan.stopNm, scan.stepNm))
    for (const pol of pols) out.push(computePoint(stack, wl, angleDeg, pol));
  return out;
}

export function angleScan(
  stack: Stack,
  scan: AngleScan,
  wavelengthNm: number,
  pols: Pol[],
): PointResult[] {
  const out: PointResult[] = [];
  for (const ang of linspace(scan.startDeg, scan.stopDeg, scan.stepDeg))
    for (const pol of pols) out.push(computePoint(stack, wavelengthNm, ang, pol));
  return out;
}

export interface DiffPoint {
  wavelengthNm?: number;
  angleDeg?: number;
  pol: Pol;
  R1: number;
  R2: number;
  T1: number;
  T2: number;
  dR: number;
  dT: number;
}

// 两套膜系（例如两个折射率版本）的谱差异。
export function diffSpectra(a: PointResult[], b: PointResult[]): DiffPoint[] {
  const key = (r: PointResult) => `${r.wavelengthNm}|${r.angleDeg}|${r.pol}`;
  const mapB = new Map(a.length === b.length ? b.map((r) => [key(r), r]) : []);
  return a.map((ra) => {
    const rb = mapB.get(key(ra));
    if (!rb) throw new Error("两套扫描结果网格不一致，无法比较");
    return {
      wavelengthNm: ra.wavelengthNm,
      angleDeg: ra.angleDeg,
      pol: ra.pol,
      R1: ra.R,
      R2: rb.R,
      T1: ra.T,
      T2: rb.T,
      dR: rb.R - ra.R,
      dT: rb.T - ra.T,
    };
  });

}

export interface ReflectanceMinimum {
  wavelengthNm?: number;
  angleDeg?: number;
  pol: Pol;
  R: number;
}

// 在离散采样网格上寻找局部/全局最小 R。
// 重要限制：仅在给定采样点上有效，采样步长即位置不确定度；
// 不宣称找到连续全局最优，窄于一个步长的谷可能被漏检。
export function findReflectanceMinima(
  results: PointResult[],
): { minima: ReflectanceMinimum[]; resolution: { wavelengthNm?: number; angleDeg?: number }; note: string } {
  const byPol = new Map<Pol, PointResult[]>();
  for (const r of results) {
    if (!r.converged) continue;
    const arr = byPol.get(r.pol) ?? [];
    arr.push(r);
    byPol.set(r.pol, arr);
  }
  const minima: ReflectanceMinimum[] = [];
  let wlStep: number | undefined;
  let angStep: number | undefined;
  for (const [pol, arr] of byPol) {
    arr.sort((x, y) => (x.wavelengthNm ?? x.angleDeg) - (y.wavelengthNm ?? y.angleDeg));
    let best: PointResult | undefined;
    for (const r of arr) if (!best || r.R < best.R) best = r;
    if (best)
      minima.push({
        wavelengthNm: best.wavelengthNm,
        angleDeg: best.angleDeg,
        pol,
        R: best.R,
      });
    const wls = Array.from(new Set(arr.map((r) => r.wavelengthNm))).sort((x, y) => x - y);
    const angs = Array.from(new Set(arr.map((r) => r.angleDeg))).sort((x, y) => x - y);
    if (wls.length > 1) wlStep = minDelta(wls);
    if (angs.length > 1) angStep = minDelta(angs);
  }
  return {
    minima,
    resolution: { wavelengthNm: wlStep, angleDeg: angStep },
    note:
      "极小值仅在离散采样点上成立，真实极值位置的不确定度不超过一个采样步长；" +
      "本函数不保证找到连续全局最优，宽度小于采样步长的反射谷可能被遗漏。需要精确定位应在谷附近加密扫描。",
  };
}

function minDelta(sorted: number[]): number {
  let m = Infinity;
  for (let i = 1; i < sorted.length; i++) m = Math.min(m, sorted[i] - sorted[i - 1]);
  return m;
}
