// JSON / CSV 导出。
import { PointResult } from "./optics.js";

export function toJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function resultsToCsv(results: PointResult[]): string {
  const header = [
    "wavelengthNm",
    "angleDeg",
    "pol",
    "r_re",
    "r_im",
    "t_re",
    "t_im",
    "R",
    "T",
    "A",
    "balanceResidual",
    "converged",
  ];
  const esc = (x: string | number | boolean | null): string => {
    const s = String(x);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(",")];
  for (const r of results) {
    lines.push(
      [
        r.wavelengthNm,
        r.angleDeg,
        r.pol,
        r.r.re,
        r.r.im,
        r.t.re,
        r.t.im,
        r.R,
        r.T,
        r.A,
        r.balanceResidual ?? "",
        r.converged,
      ]
        .map((v) => esc(v as string | number | boolean))
        .join(","),
    );
  }
  return lines.join("\n");
}
