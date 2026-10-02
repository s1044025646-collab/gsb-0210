import { Coefficients, Polarization, StackInput, calculatePoint } from "./optics.js";

export interface ScanPoint {
  wavelengthNm: number;
  angleDeg: number;
  s: Coefficients;
  p: Coefficients;
}

export interface ScanRequest {
  stack: StackInput;
  wavelengthStartNm?: number;
  wavelengthStopNm?: number;
  wavelengthStepNm?: number;
  wavelengthNm?: number;
  angleStartDeg?: number;
  angleStopDeg?: number;
  angleStepDeg?: number;
  angleDeg?: number;
}

export interface Minimum {
  wavelengthNm: number;
  angleDeg: number;
  polarization: Polarization;
  R: number;
  T: number;
  A: number;
}

function requireRange(start: unknown, stop: unknown, step: unknown, names: { start: string; stop: string; step: string }) {
  const values = [start, stop, step].map((value) => (value === undefined ? Number.NaN : Number(value)));
  if (!values.every(Number.isFinite)) throw new Error(`${names.start}、${names.stop}、${names.step} 必须同时提供有限数值`);
  const [s, e, d] = values as [number, number, number];
  if (d <= 0) throw new Error(`${names.step} 必须为正`);
  if (e < s) throw new Error(`${names.stop} 不能小于 ${names.start}`);
  const count = Math.floor((e - s) / d + 1e-9) + 1;
  if (count > 100001) throw new Error("扫描点数超过 100001，请缩小范围或增大步长");
  return Array.from({ length: count }, (_, index) => s + index * d);
}

export function runScan(request: ScanRequest): { points: ScanPoint[]; sampleResolution: { wavelengthStepNm: number | null; angleStepDeg: number | null } } {
  const wavelengths = request.wavelengthStartNm !== undefined || request.wavelengthStopNm !== undefined || request.wavelengthStepNm !== undefined
    ? requireRange(request.wavelengthStartNm, request.wavelengthStopNm, request.wavelengthStepNm, {
        start: "wavelengthStartNm",
        stop: "wavelengthStopNm",
        step: "wavelengthStepNm"
      })
    : [Number(request.wavelengthNm)];
  const angles = request.angleStartDeg !== undefined || request.angleStopDeg !== undefined || request.angleStepDeg !== undefined
    ? requireRange(request.angleStartDeg, request.angleStopDeg, request.angleStepDeg, {
        start: "angleStartDeg",
        stop: "angleStopDeg",
        step: "angleStepDeg"
      })
    : [Number(request.angleDeg ?? 0)];

  const points: ScanPoint[] = [];
  for (const wavelengthNm of wavelengths) {
    for (const angleDeg of angles) {
      const point = calculatePoint({ stack: request.stack, wavelengthNm, angleDeg, polarization: "both" }) as Record<Polarization, Coefficients>;
      points.push({ wavelengthNm, angleDeg, s: point.s, p: point.p });
    }
  }
  return {
    points,
    sampleResolution: {
      wavelengthStepNm: request.wavelengthStepNm ? Number(request.wavelengthStepNm) : null,
      angleStepDeg: request.angleStepDeg ? Number(request.angleStepDeg) : null
    }
  };
}

export function findMinima(points: ScanPoint[], polarization: Polarization | "both" = "both"): Minimum[] {
  const pols: Polarization[] = polarization === "both" ? ["s", "p"] : [polarization];
  return pols.flatMap((pol) =>
    points
      .map((point) => {
        const value = point[pol];
        return { wavelengthNm: point.wavelengthNm, angleDeg: point.angleDeg, polarization: pol, R: value.R, T: value.T, A: value.A };
      })
      .filter((point, index, array) => {
        const prev = array[index - 1];
        const next = array[index + 1];
        return (!prev || point.R <= prev.R) && (!next || point.R < next.R);
      })
      .sort((a, b) => a.R - b.R)
  );
}

export function compareScans(left: ScanPoint[], right: ScanPoint[]): ScanPoint[] {
  const rightMap = new Map<string, ScanPoint>();
  for (const point of right) rightMap.set(`${point.wavelengthNm}/${point.angleDeg}`, point);
  return left.flatMap((point) => {
    const other = rightMap.get(`${point.wavelengthNm}/${point.angleDeg}`);
    if (!other) return [];
    return [
      {
        wavelengthNm: point.wavelengthNm,
        angleDeg: point.angleDeg,
        s: { ...point.s, R: point.s.R - other.s.R, T: point.s.T - other.s.T, A: point.s.A - other.s.A },
        p: { ...point.p, R: point.p.R - other.p.R, T: point.p.T - other.p.T, A: point.p.A - other.p.A }
      }
    ];
  });
}

export function flattenCsv(points: ScanPoint[]): string {
  const header = "wavelengthNm,angleDeg,polarization,rRe,rIm,tRe,tIm,R,T,A,converged";
  const rows = points.flatMap((point) =>
    (["s", "p"] as Polarization[]).map((pol) => {
      const x = point[pol];
      return [point.wavelengthNm, point.angleDeg, pol, x.r.re, x.r.im, x.t.re, x.t.im, x.R, x.T, x.A, x.converged].join(",");
    })
  );
  return [header, ...rows].join("\n");
}
