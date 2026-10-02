export interface C {
  re: number;
  im: number;
}

export const c = (re: number, im = 0): C => ({ re, im });

export const add = (a: C, b: C): C => ({ re: a.re + b.re, im: a.im + b.im });
export const sub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
export const mul = (a: C, b: C): C => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re
});

export const div = (a: C, b: C): C => {
  const denom = b.re * b.re + b.im * b.im;
  if (!Number.isFinite(denom) || denom === 0) {
    throw new NumericalError(`无效复数除法，分母模平方=${denom}`);
  }
  return { re: (a.re * b.re + a.im * b.im) / denom, im: (a.im * b.re - a.re * b.im) / denom };
};

export function sqrt(z: C): C {
  const modulus = Math.hypot(z.re, z.im);
  const re = Math.sqrt(Math.max(0, (modulus + z.re) / 2));
  let im = Math.sqrt(Math.max(0, (modulus - z.re) / 2));
  if (z.im < 0) im = -im;
  if (re === 0 && im < 0) im = 0;
  return { re, im };
}

export const abs2 = (z: C): number => z.re * z.re + z.im * z.im;

export class NumericalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NumericalError";
  }
}
