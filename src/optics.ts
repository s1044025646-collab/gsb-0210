// 核心物理：平面多层各向同性、非磁性（μ=μ0）薄膜的相干传输矩阵求解。
//
// 时谐约定：场量按 exp(-iωt) 演化。
//   沿 +z 传播的平面波相位因子为 exp(i k z)。
// 折射率约定：N = n + iκ，无源介质要求 κ >= 0（振幅随传播衰减：exp(i N k0 z)
//   的包络为 exp(-κ k0 z)）。吸收系数 α = 2 k0 κ（强度，1/m，α>=0）。
// 单位：波长与厚度内部统一为纳米 nm；入射角/折射角为度（°）。
//
// 能量守恒（入射介质与基底均为无吸收实折射率时）：R + T + A = 1。
// T 使用法向能流（坡印廷矢量 z 分量）比值，而非透射振幅模平方。

import { C, c, add, sub, mul, div, abs2, exp, sqrt, isFiniteC, scale } from "./complex.js";

export type Pol = "s" | "p";

export interface Layer {
  name?: string;
  // 厚度，nm；允许 0。
  thickness: number;
  // 折射率。常量复折射率 [re, im]，或色散函数（按波长 nm 返回 [re, im]）。
  n: [number, number] | ((wavelengthNm: number) => [number, number]);
}

export interface Stack {
  // 入射介质：必须为正实数折射率（无吸收半无限介质）。
  nIncident: number;
  // 膜层（按光传播顺序排列，可为空）。
  layers: Layer[];
  // 基底：必须为正实数折射率（无吸收半无限介质）。
  nSubstrate: number;
}

export interface PointResult {
  wavelengthNm: number;
  angleDeg: number;
  pol: Pol;
  // 电场复振幅系数（总场，非切向）。
  r: C;
  t: C;
  R: number;
  T: number;
  A: number;
  // 守恒残差 |R+T+A-1|；不可靠时为 null。
  balanceResidual: number | null;
  converged: boolean;
  warnings: string[];
}

export const LIMITS = {
  maxLayers: 200,
  // 单层允许的最大光学衰减（往返）。exp 下溢前 709 已是双精度极限，
  // 这里取保守阈值；超过即标记未收敛，拒绝给出伪造的合法结果。
  maxRoundTripOpticalDepth: 600,
};

export class ValidationError extends Error {
  constructor(
    message: string,
    public path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
  }
}

function evalN(layer: Layer, wl: number): C {
  const v = typeof layer.n === "function" ? layer.n(wl) : layer.n;
  return c(v[0], v[1]);
}

export function validateStack(stack: Stack): void {
  if (!stack || typeof stack !== "object") throw new ValidationError("膜系缺失或格式错误", "stack");
  if (!(stack.nIncident > 0) || !Number.isFinite(stack.nIncident))
    throw new ValidationError("入射介质折射率必须为正实数", "stack.nIncident");
  if (!(stack.nSubstrate > 0) || !Number.isFinite(stack.nSubstrate))
    throw new ValidationError("基底折射率必须为正实数", "stack.nSubstrate");
  if (!Array.isArray(stack.layers)) throw new ValidationError("layers 必须为数组", "stack.layers");
  if (stack.layers.length > LIMITS.maxLayers)
    throw new ValidationError(`膜层数量超过上限 ${LIMITS.maxLayers}`, "stack.layers");
  stack.layers.forEach((l, i) => {
    const p = `stack.layers[${i}]`;
    if (!(Number.isFinite(l.thickness) && l.thickness >= 0))
      throw new ValidationError("厚度必须为非负有限数（nm）", `${p}.thickness`);
    let nv: [number, number];
    try {
      nv = typeof l.n === "function" ? l.n(550) : l.n;
    } catch (e) {
      throw new ValidationError(`色散函数求值失败: ${(e as Error).message}`, `${p}.n`);
    }
    if (!Array.isArray(nv) || nv.length !== 2 || !Number.isFinite(nv[0]) || !Number.isFinite(nv[1]))
      throw new ValidationError("折射率必须为 [实部, 虚部] 有限数", `${p}.n`);
    if (nv[0] <= 0) throw new ValidationError("折射率实部必须为正", `${p}.n[0]`);
    if (nv[1] < -1e-12)
      throw new ValidationError("虚部 κ<0 违反无源（吸收）假设，本服务不接受增益介质", `${p}.n[1]`);
  });
}

export function validateScanParams(wl: number, angleDeg: number): void {
  if (!(wl > 0) || !Number.isFinite(wl)) throw new ValidationError("波长必须为正（nm）", "wavelengthNm");
  if (!(angleDeg >= 0 && angleDeg < 90) || !Number.isFinite(angleDeg))
    throw new ValidationError("入射角必须在 [0,90) 度内", "angleDeg");
}

// 光学导纳（切向场意义）。
// s 偏振: η = N cosθ ; p 偏振: η = N / cosθ
function admittance(N: C, cosTheta: C, pol: Pol): C {
  return pol === "s" ? mul(N, cosTheta) : div(N, cosTheta);
}

// 折射角余弦的物理分支：cosθ = sqrt(1 - (n0 sinθ0 / N)^2)。
// 对吸收膜层取 Im(cosθ)>=0 的分支，使 exp(i N cosθ k0 z) 沿 +z 衰减；
// 对无吸收介质（实 N）取 Re(cosθ)>=0 的向前传播分支，
// 全反射时退化为正虚数（倏逝波）。
function cosThetaSnell(N: C, n0SinTheta0: number): C {
  const ratio = div(c(n0SinTheta0), N);
  let cs = sqrt(sub(c(1), mul(ratio, ratio)));
  if (cs.im < 0) cs = { re: cs.re, im: -cs.im };
  if (cs.re < 0) cs = { re: -cs.re, im: cs.im };
  return cs;
}

// 单界面 Fresnel（总电场振幅，切向在界面连续故与切向系数一致用于 s；
// p 的 E 总场在界面不连续，这里返回标准总场 E 系数，内部矩阵统一用导纳）。
export function fresnel(n1: C, n2: C, cos1: C, cos2: C, pol: Pol): { r: C; t: C } {
  const e1 = admittance(n1, cos1, pol);
  const e2 = admittance(n2, cos2, pol);
  const r = div(sub(e1, e2), add(e1, e2));
  // 切向 E 系数。
  const tTan = div(scale(e1, 2), add(e1, e2));
  // s：切向即总场。p：E_tan=E·cosθ，总场 t = t_tan·cosθ1/cosθ2。
  const t = pol === "s" ? tTan : mul(tTan, div(cos1, cos2));
  return { r, t };
}

export function computePoint(stack: Stack, wavelengthNm: number, angleDeg: number, pol: Pol): PointResult {
  validateStack(stack);
  validateScanParams(wavelengthNm, angleDeg);
  const warnings: string[] = [];
  const k0 = (2 * Math.PI) / wavelengthNm;
  const theta0 = (angleDeg * Math.PI) / 180;
  const n0Sin = stack.nIncident * Math.sin(theta0);

  const N0 = c(stack.nIncident);
  const Ns = c(stack.nSubstrate);
  const cos0 = c(Math.cos(theta0));
  const cosS = cosThetaSnell(Ns, n0Sin);
  const e0 = admittance(N0, cos0, pol);
  const eS = admittance(Ns, cosS, pol);

  // 总特征矩阵 M（切向场 [E; H_tan]，H 以自由空间导纳归一）。
  let M11: C = c(1);
  let M12: C = c(0);
  let M21: C = c(0);
  let M22: C = c(1);
  let converged = true;

  for (const layer of stack.layers) {
    if (layer.thickness === 0) continue;
    const N = evalN(layer, wavelengthNm);
    const ct = cosThetaSnell(N, n0Sin);
    // 相位厚度 δ = -N cosθ k0 d。取负号后，无源介质 Im(N cosθ)>0 时
    // exp(+iδ)=exp(-i N cosθ k0 d) 的包络 exp(+Imδ)=exp(-κ_eff k0 d) 衰减，
    // 与 exp(-iωt)、N=n+iκ（κ>=0）约定自洽。
    const delta = mul(mul(N, ct), c(-k0 * layer.thickness));
    const e = admittance(N, ct, pol);

    // 稳定性：单层往返光学衰减过大会使双曲函数下溢/上溢。
    const betaIm = delta.im; // β 的虚部 = κ_eff k0 d，单程奈培衰减
    if (Math.abs(betaIm) > LIMITS.maxRoundTripOpticalDepth / 2) {
      converged = false;
      warnings.push(
        `层${layer.name ? `「${layer.name}」` : ""}单程光学衰减 ${Math.abs(betaIm).toExponential(2)} 超过稳定阈值，结果不可靠`,
      );
    }

    const cosph = cosC(delta);
    const sinph = sinC(delta);
    // L = [[cosδ, i sinδ/η],[i η sinδ, cosδ]]
    const L11 = cosph;
    const L12 = div(mul(c(0, 1), sinph), e);
    const L21 = mul(mul(c(0, 1), e), sinph);
    const L22 = cosph;

    const P11 = add(mul(M11, L11), mul(M12, L21));
    const P12 = add(mul(M11, L12), mul(M12, L22));
    const P21 = add(mul(M21, L11), mul(M22, L21));
    const P22 = add(mul(M21, L12), mul(M22, L22));
    M11 = P11; M12 = P12; M21 = P21; M22 = P22;
  }

  // 标准特征矩阵边界关系（切向场，B=M11, C=M12, D=M21, E=M22=1/det 对称结构下）：
  //   r = (η0 B + η0 ηs C - D - ηs E) / (η0 B + η0 ηs C + D + ηs E)
  //   t_tan = 2η0 / (η0 B + η0 ηs C + D + ηs E)
  const Bmat = M11;
  const Cmat = M12;
  const Dmat = M21;
  const Emat = M22;
  const e0eS = mul(e0, eS);
  const num = sub(sub(add(mul(e0, Bmat), mul(e0eS, Cmat)), Dmat), mul(eS, Emat));
  const den = add(add(add(mul(e0, Bmat), mul(e0eS, Cmat)), Dmat), mul(eS, Emat));
  const r = div(num, den);
  // 切向 E 系数。
  const tTan = div(scale(e0, 2), den);
  // s：切向即总场。p：E_tan=E·cosθ，总场 t = t_tan·cosθ0/cosθs。
  const t = pol === "s" ? tTan : mul(tTan, div(cos0, cosS));

  // 功率：R=|r|²（入射侧同介质）。
  const R = abs2(r);
  // T = Re(Ns cosθs)/(N0 cosθ0) |t|²，t 为总场 E 透射系数。
  // s 与 p 均适用此式（坡印廷 z 分量比；基底无吸收故取实部）。
  const fluxRatio = realAdmittanceS(Ns, cosS) / (stack.nIncident * cos0.re);
  const T = fluxRatio * abs2(t);
  const A = 1 - R - T;

  if (!isFiniteC(r) || !isFiniteC(t) || !Number.isFinite(R) || !Number.isFinite(T)) {
    converged = false;
    warnings.push("计算出现非有限数值");
  }
  if (A < -1e-6) {
    converged = false;
    warnings.push(`能量核验异常：A=${A.toExponential(2)} < 0（可能违反无源假设或数值不稳定），结果拒绝采信`);
  }
  if (R < -1e-9 || T < -1e-9 || R > 1 + 1e-6 || T > 1 + 1e-6) {
    warnings.push("R/T 超出 [0,1] 物理范围，结果仅供排查");
  }

  return {
    wavelengthNm,
    angleDeg,
    pol,
    r: cleanC(r),
    t: cleanC(t),
    R: clamp01(R),
    T: clamp01(T),
    A: Math.max(0, A),
    balanceResidual: Math.abs((clamp01(R) + clamp01(T) + Math.max(0, A)) - 1),
    converged,
    warnings,
  };
}

function negC(a: C): C {
  return { re: -a.re, im: -a.im };
}
function realAdmittanceS(N: C, cosTheta: C): number {
  // Re(N cosθ)，用于总场 E 的法向能流（s/p 通用，TIR 时为 0）。
  return N.re * cosTheta.re - N.im * cosTheta.im;
}
function cosC(z: C): C {
  return { re: Math.cos(z.re) * Math.cosh(z.im), im: -Math.sin(z.re) * Math.sinh(z.im) };
}
function sinC(z: C): C {
  return { re: Math.sin(z.re) * Math.cosh(z.im), im: Math.cos(z.re) * Math.sinh(z.im) };
}
function clamp01(x: number): number {
  if (!Number.isFinite(x)) return x;
  return Math.min(1, Math.max(0, x));
}
function cleanC(a: C): C {
  return { re: roundSmall(a.re), im: roundSmall(a.im) };
}
function roundSmall(x: number): number {
  return Math.abs(x) < 1e-14 ? 0 : x;
}
