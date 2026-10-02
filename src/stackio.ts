// 膜系的 JSON 导入/导出与归一化。支持常量复折射率与命名色散材料。
import { Layer, Stack, ValidationError, validateStack } from "./optics.js";
import { BUILTIN_MATERIALS, MaterialSpec, evaluateMaterial } from "./materials.js";

export interface LayerDTO {
  name?: string;
  thicknessNm: number;
  // 二选一：直接给常量复折射率，或引用已注册材料（可带版本）。
  n?: [number, number];
  material?: string;
  // 内联色散规格（冻结快照时使用）。
  materialSpec?: MaterialSpec;
}

export interface StackDTO {
  name?: string;
  nIncident: number;
  nSubstrate: number;
  layers: LayerDTO[];
}

export class ImportError extends ValidationError {
  constructor(message: string, path = "stack") {
    super(message, path);
    this.name = "ImportError";
  }
}

export function importStack(dto: StackDTO, materialRegistry?: Record<string, MaterialSpec>): Stack {
  if (!dto || typeof dto !== "object") throw new ImportError("膜系 JSON 必须为对象");
  if (!Array.isArray(dto.layers)) throw new ImportError("缺少 layers 数组");
  const reg = { ...BUILTIN_MATERIALS, ...(materialRegistry ?? {}) };
  const layers: Layer[] = dto.layers.map((l, i) => {
    if (typeof l.thicknessNm !== "number" || l.thicknessNm < 0)
      throw new ImportError(`layers[${i}].thicknessNm 必须为非负数`);
    let spec: MaterialSpec | undefined;
    let nConst: [number, number] | undefined;
    if (l.n) {
      nConst = l.n;
    } else if (l.materialSpec) {
      spec = l.materialSpec;
    } else if (l.material) {
      spec = reg[l.material];
      if (!spec) throw new ImportError(`layers[${i}] 引用了未注册材料「${l.material}」`);
    } else {
      throw new ImportError(`layers[${i}] 必须提供 n、material 或 materialSpec 之一`);
    }
    const layer: Layer = {
      name: l.name ?? l.material,
      thickness: l.thicknessNm,
      n: nConst
        ? nConst
        : (wl: number) => {
            const v = evaluateMaterial(spec as MaterialSpec, wl);
            return [v[0], Math.max(0, v[1])];
          },
    };
    return layer;
  });
  const stack: Stack = {
    nIncident: dto.nIncident,
    nSubstrate: dto.nSubstrate,
    layers,
  };
  validateStack(stack);
  return stack;
}

// 合并相邻同折射率（给定波长下实部虚部均近似相等）的层，用于“合并不变”性质与演示。
export function mergeAdjacentEqual(stack: Stack, atWavelengthNm = 550, tol = 1e-9): Stack {
  const merged: Layer[] = [];
  for (const layer of stack.layers) {
    const nv = typeof layer.n === "function" ? layer.n(atWavelengthNm) : layer.n;
    const prev = merged[merged.length - 1];
    if (prev) {
      const pv = typeof prev.n === "function" ? prev.n(atWavelengthNm) : prev.n;
      if (Math.abs(pv[0] - nv[0]) <= tol && Math.abs(pv[1] - nv[1]) <= tol) {
        prev.thickness += layer.thickness;
        continue;
      }
    }
    merged.push({ name: layer.name, thickness: layer.thickness, n: layer.n });
  }
  return { ...stack, layers: merged };
}
