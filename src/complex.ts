// 最小复数库，避免外部依赖。
// 约定见 optics.ts 顶部说明。
export interface C {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): C => ({ re, im });
export const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: C, b: C): C => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
});
export const scale = (a: C, s: number): C => ({ re: a.re * s, im: a.im * s });
export const div = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return { re: (a.re * b.re + a.im * b.im) / d, im: (a.im * b.re - a.re * b.im) / d };
};
export const abs2 = (a: C): number => a.re * a.re + a.im * a.im;
export const abs = (a: C): number => Math.hypot(a.re, a.im);
export const neg = (a: C): C => ({ re: -a.re, im: -a.im });
export const exp = (a: C): C => {
  const m = Math.exp(a.re);
  return { re: m * Math.cos(a.im), im: m * Math.sin(a.im) };
};
export const sqrt = (a: C): C => {
  // 主平方根：实部非负；实部为 0 时虚部与输入虚部同号。
  const r = abs(a);
  if (r === 0) return { re: 0, im: 0 };
  const re = Math.sqrt((r + a.re) / 2);
  let im = Math.sqrt((r - a.re) / 2);
  if (a.im < 0) im = -im;
  return { re, im };
};
export const isFiniteC = (a: C): boolean => Number.isFinite(a.re) && Number.isFinite(a.im);
