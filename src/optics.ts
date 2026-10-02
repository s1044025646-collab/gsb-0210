import { C, c, abs2, add, div, mul, sqrt, sub, NumericalError } from "./complex.js";
export { NumericalError };

export type Polarization = "s" | "p";

export interface LayerInput {
  name?: string;
  refractiveIndex: number | C;
  thicknessNm: number;
}

export interface StackInput {
  incident: { name?: string; refractiveIndex: number | C };
  layers: LayerInput[];
  substrate: { name?: string; refractiveIndex: number | C };
}

export interface ValidatedLayer {
  name: string;
  n: C;
  thicknessNm: number;
}

export interface ValidatedStack {
  incident: { name: string; n: C };
  layers: ValidatedLayer[];
  substrate: { name: string; n: C };
}

export interface PointRequest {
  stack: StackInput;
  wavelengthNm: number;
  angleDeg: number;
  polarization?: Polarization | "both";
}

export interface Coefficients {
  polarization: Polarization;
  wavelengthNm: number;
  angleDeg: number;
  r: C;
  t: C;
  R: number;
  T: number;
  A: number;
  energyResidual: number;
  converged: boolean;
}

export const MAX_LAYERS = 100;
export const MAX_ABSORPTION_OPTICAL_DEPTH = 650;
export const SUPPORTED_WAVELENGTH_NM = [100, 1_000_000] as const;
export const SUPPORTED_ANGLE_DEG = [0, 89.999999] as const;

export class ValidationError extends Error {
  field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = "ValidationError";
    this.field = field;
  }
}

function asComplex(value: number | C | undefined, field: string): C {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ValidationError(field, "折射率必须是有限数值");
    return c(value, 0);
  }
  if (!value || typeof value !== "object") {
    throw new ValidationError(field, "折射率必须是数值或 {re, im} 对象");
  }
  const { re, im } = value;
  if (!Number.isFinite(re) || !Number.isFinite(im ?? 0)) {
    throw new ValidationError(field, "折射率实部和虚部必须有限");
  }
  return c(re, im ?? 0);
}

function requirePositiveReal(n: C, field: string): void {
  if (n.im < -1e-12) throw new ValidationError(field, "入射介质和基底必须为正实折射率，不能含吸收");
  if (n.re <= 0) throw new ValidationError(field, "入射介质和基底必须为正实折射率");
}

export function validateStack(stack: StackInput | undefined): ValidatedStack {
  if (!stack || typeof stack !== "object") throw new ValidationError("stack", "膜系对象缺失");
  if (!Array.isArray(stack.layers)) throw new ValidationError("stack.layers", "必须是按入射到基底顺序排列的数组");
  if (stack.layers.length > MAX_LAYERS) {
    throw new ValidationError("stack.layers", `膜层数量超过 ${MAX_LAYERS} 层限制`);
  }
  const incidentN = asComplex(stack.incident?.refractiveIndex, "stack.incident.refractiveIndex");
  const substrateN = asComplex(stack.substrate?.refractiveIndex, "stack.substrate.refractiveIndex");
  requirePositiveReal(incidentN, "stack.incident.refractiveIndex");
  requirePositiveReal(substrateN, "stack.substrate.refractiveIndex");

  const layers = stack.layers.map((layer, index) => {
    const field = `stack.layers[${index}]`;
    if (!layer || typeof layer !== "object") throw new ValidationError(field, "膜层对象缺失");
    if (!Number.isFinite(layer.thicknessNm)) throw new ValidationError(`${field}.thicknessNm`, "厚度必须是有限数值");
    if (layer.thicknessNm < 0) throw new ValidationError(`${field}.thicknessNm`, "厚度不能为负");
    const n = asComplex(layer.refractiveIndex, `${field}.refractiveIndex`);
    if (n.im < -1e-12) {
      throw new ValidationError(`${field}.refractiveIndex.im`, "在 n=n'+iκ、exp(-iωt) 约定下，无源膜层必须 κ>=0");
    }
    if (Math.hypot(n.re, n.im) > 100) {
      throw new ValidationError(`${field}.refractiveIndex`, "折射率模超过公开稳定范围 |n|<=100");
    }
    return { name: layer.name ?? `layer-${index + 1}`, n, thicknessNm: layer.thicknessNm };
  });

  return {
    incident: { name: stack.incident?.name ?? "incident", n: incidentN },
    layers,
    substrate: { name: stack.substrate?.name ?? "substrate", n: substrateN }
  };
}

function validatePointInputs(stack: ValidatedStack, wavelengthNm: number, angleDeg: number): void {
  if (!Number.isFinite(wavelengthNm) || wavelengthNm <= 0) {
    throw new ValidationError("wavelengthNm", "波长必须为正数，单位 nm");
  }
  if (wavelengthNm < SUPPORTED_WAVELENGTH_NM[0] || wavelengthNm > SUPPORTED_WAVELENGTH_NM[1]) {
    throw new ValidationError("wavelengthNm", `公开稳定范围为 ${SUPPORTED_WAVELENGTH_NM[0]}..${SUPPORTED_WAVELENGTH_NM[1]} nm`);
  }
  if (!Number.isFinite(angleDeg) || angleDeg < SUPPORTED_ANGLE_DEG[0] || angleDeg > SUPPORTED_ANGLE_DEG[1]) {
    throw new ValidationError("angleDeg", "入射角必须位于 [0, 89.999999] 度");
  }
  const sin2 = Math.pow(stack.incident.n.re * Math.sin((angleDeg * Math.PI) / 180), 2);
  for (const layer of stack.layers) {
    const n2 = mul(layer.n, layer.n);
    const q = sqrt(sub(n2, c(sin2, 0)));
    const opticalDepth = (2 * Math.PI * q.im * layer.thicknessNm) / wavelengthNm;
    if (opticalDepth > MAX_ABSORPTION_OPTICAL_DEPTH) {
      throw new NumericalError(`${layer.name}: 吸收光学深度 ${opticalDepth.toExponential(3)} 超过 ${MAX_ABSORPTION_OPTICAL_DEPTH}，传播矩阵可能溢出，拒绝返回结果`);
    }
  }
}

function normalWaveVector(n: C, incidentN: C, angleDeg: number): C {
  const sin2 = Math.pow(incidentN.re * Math.sin((angleDeg * Math.PI) / 180), 2);
  const q = sqrt(sub(mul(n, n), c(sin2, 0)));
  if (q.re < -1e-14 || q.im < -1e-14) throw new NumericalError("法向波矢分支选择失败");
  return q;
}

interface Mat2 {
  a: C;
  b: C;
  d: C;
  e: C;
}

function matVec(m: Mat2, v: { x: C; y: C }): { x: C; y: C } {
  return { x: add(mul(m.a, v.x), mul(m.b, v.y)), y: add(mul(m.d, v.x), mul(m.e, v.y)) };
}

function admittance(n: C, q: C, pol: Polarization): C {
  return pol === "s" ? q : div(mul(n, n), q);
}

function characteristicLayerMatrix(delta: C, admittanceValue: C): Mat2 {
  const sin = c(Math.sin(delta.re) * Math.cosh(delta.im), Math.cos(delta.re) * Math.sinh(delta.im));
  const cos = c(Math.cos(delta.re) * Math.cosh(delta.im), -Math.sin(delta.re) * Math.sinh(delta.im));
  return {
    a: cos,
    b: div(mul(c(0, -1), sin), admittanceValue),
    d: mul(mul(c(0, -1), admittanceValue), sin),
    e: cos
  };
}

export function calculatePoint(input: PointRequest): Record<Polarization, Coefficients> | Coefficients {
  const stack = validateStack(input.stack);
  validatePointInputs(stack, input.wavelengthNm, input.angleDeg);
  const pols: Polarization[] = input.polarization === "s" || input.polarization === "p" ? [input.polarization] : ["s", "p"];
  const result = {} as Record<Polarization, Coefficients>;
  for (const pol of pols) result[pol] = calculateOne(stack, input.wavelengthNm, input.angleDeg, pol);
  return pols.length === 1 ? result[pols[0]!] : result;
}

function calculateOne(stack: ValidatedStack, wavelengthNm: number, angleDeg: number, pol: Polarization): Coefficients {
  const q0 = normalWaveVector(stack.incident.n, stack.incident.n, angleDeg);
  const qs = normalWaveVector(stack.substrate.n, stack.incident.n, angleDeg);
  const y0 = admittance(stack.incident.n, q0, pol);
  const ys = admittance(stack.substrate.n, qs, pol);
  let vector = { x: c(1), y: ys };

  for (let index = stack.layers.length - 1; index >= 0; index -= 1) {
    const layer = stack.layers[index]!;
    const q = normalWaveVector(layer.n, stack.incident.n, angleDeg);
    const y = admittance(layer.n, q, pol);
    const delta = mul(c((2 * Math.PI * layer.thicknessNm) / wavelengthNm), q);
    vector = matVec(characteristicLayerMatrix(delta, y), vector);
  }

  const tTangential = div(mul(c(2), y0), add(mul(y0, vector.x), vector.y));
  const rTangential = div(sub(mul(y0, vector.x), vector.y), add(mul(y0, vector.x), vector.y));
  const t = pol === "s" ? tTangential : div(mul(tTangential, div(q0, stack.incident.n)), div(qs, stack.substrate.n));
  const r = rTangential;
  if (![r.re, r.im, t.re, t.im].every(Number.isFinite)) {
    throw new NumericalError("多层传播矩阵未收敛：系数包含非有限值");
  }

  const R = abs2(r);
  const fluxRatio = qs.re / q0.re;
  const T = Math.max(0, fluxRatio) * abs2(t);
  const rawA = 1 - R - T;
  const energyResidual = rawA < -1e-8 ? rawA : 0;
  if (rawA < -1e-8) {
    throw new NumericalError(`能量核验失败：R+T=${(R + T).toFixed(12)}，不能将负吸收裁剪为合法结果`);
  }
  const A = Math.max(0, rawA);
  return {
    polarization: pol,
    wavelengthNm,
    angleDeg,
    r,
    t,
    R,
    T,
    A,
    energyResidual,
    converged: true
  };
}

export function absorptionCoefficientPerNm(kappa: number, wavelengthNm: number): number {
  if (kappa < 0) throw new ValidationError("kappa", "无源材料消光系数不能为负");
  return (4 * Math.PI * kappa) / wavelengthNm;
}
