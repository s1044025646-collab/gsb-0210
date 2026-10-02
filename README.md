# 多层薄膜反射透射谱与偏振分析后端

平面多层各向同性、非磁性（μ=μ₀）光学薄膜的**离线相干光谱计算服务**。只提供 HTTP API 与 CLI，无前端、无外部材料数据库、无 Docker/WSL/付费服务依赖。

- 语言/运行时：TypeScript + Node.js（要求 Node ≥ 22.5，使用内置 `node:sqlite`，无需原生编译）
- 存储：SQLite（冻结材料/膜系、扫描参数、结果快照）
- 平台：Windows 本地可直接运行（也适用于其他平台）

## 物理约定

| 项目 | 约定 |
|---|---|
| 时谐因子 | 场按 `exp(-iωt)` 演化，前向波 `exp(i k z)` |
| 复折射率 | `N = n + iκ`，**无源介质 κ ≥ 0**（振幅随传播衰减） |
| 吸收系数 | 强度吸收系数 `α = 2 k₀κ`（1/m，α ≥ 0）；κ<0 表示增益，本服务拒绝 |
| 波长/厚度 | 纳米 nm |
| 角度 | 度（°），入射角范围 `[0, 90)` |
| 偏振 | `s`（TE，电场垂直入射面）与 `p`（TM，磁场垂直入射面） |

求解方法为自行实现的 **2×2 特征（Abelès/传输）矩阵法**，未调用任何现成薄膜光学求解器。

### 能量与分支

- 返回复振幅反射/透射系数 `r`、`t`（总电场），以及功率 `R`、`T`、`A`。
- **透射率使用法向能流**（坡印廷矢量 z 分量）比：`T = Re(Ns cosθs)/(N0 cosθ0)·|t|²`，**不是**透射振幅模平方。
- 无吸收入射介质/基底时 `R + T + A = 1`，`balanceResidual` 给出残差。
- 折射角/法向波矢按**向前传播或衰减**选支：`cosθ = sqrt(1-(N0 sinθ0/N)²)`，要求 `Im(N cosθ) ≥ 0`（衰减）且 `Re(cosθ) ≥ 0`（前向）。全反射时基底侧为倏逝波，`T=0、R=1`。

### 数值稳定范围与限制

- 膜层数量上限 **200**。
- 单层单程光学衰减 `|Im(N cosθ) k₀ d|` 超过约 **300**（往返阈值 600）时标记 `converged=false` 并给出告警，**拒绝把结果当合法值**。
- 出现 `A<0`（能量凭空产生）等异常时同样标记未收敛；服务不会把负吸收或超界能量误差“裁剪”成合法结果（仅对最终展示做 0..1 保护，收敛标志与告警保持可见）。
- 反射率极小值仅在**离散采样网格**上有效：位置不确定度不超过一个采样步长，**不保证找到连续全局最优**；窄于一个步长的谷可能漏检，需要时在谷附近加密扫描。

## 安装与构建

```powershell
npm install
npm run build
```

## 测试

```powershell
npm test
```

测试使用**独立解析参考**（教科书 Fresnel 公式、四分之一波等效导纳公式），不使用本求解器自身输出作为期望值，并包含有吸收情况下的能流 `R+T+A=1` 检查。覆盖：

- 裸介面解析 Fresnel（多角度、s/p）
- 无损多层膜 `R+T=1`
- 全反射 `T=0、R=1`
- 零厚度层不变
- 相邻同折射率层合并不变
- 法向入射 s/p 功率相等
- 四分之一波抗反射膜在设计波长的反射谷
- Brewster 角 p 反射趋零
- 有吸收膜 `A>0` 且能量守恒
- 参数校验（负厚度、增益介质、非法折射率）与超厚吸收层未收敛

## 启动 API

```powershell
# 默认端口 8080，数据目录 ./data
npm start

# 自定义端口与数据目录
$env:PORT="9000"; $env:THINFILM_DATA_DIR="E:\data\thinfilm"; npm start
```

### 主要端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 健康检查 |
| POST | `/stacks` | 导入并冻结膜系 |
| GET | `/stacks` `/stacks/:id` | 列出/读取膜系 |
| POST | `/compute` | 单点计算（波长、角度、偏振） |
| POST | `/scan/wavelength` | 波长扫描，可返回反射极小点；`"format":"csv"` 导出 CSV |
| POST | `/scan/angle` | 角度扫描（偏振随角度变化） |
| POST | `/compare` | 两套膜系（如两个折射率版本）同网格谱差异 |
| POST | `/conserve` | 守恒核验 |
| GET | `/scans?kind=` `/scans/:id` | 历史报告读取（重启后可用），支持 `?format=csv` |

### 请求示例（单点）

```http
POST /compute
Content-Type: application/json

{
  "stack": {
    "nIncident": 1.0,
    "nSubstrate": 1.5,
    "layers": [
      { "name": "AR", "thicknessNm": 112.27, "n": [1.224744871, 0] }
    ]
  },
  "wavelengthNm": 550,
  "angleDeg": 0,
  "pols": ["s", "p"]
}
```

膜层折射率三种写法：`"n":[实部, 虚部]`（常量）、`"material":"bk7"`（内置/已注册）、`"materialSpec":{...}`（内联色散快照）。色散模型支持 `constant`、`cauchy`、`sellmeier`（均离线、无增益）。

### 快速用 curl 验证

```powershell
curl.exe -s http://localhost:8080/health
```

## CLI

```powershell
node dist/cli.js help

# 单点
node dist/cli.js point --file examples/ar-coating.json --wl 550 --angle 0

# 波长扫描 + 极小点，导出 CSV
node dist/cli.js scan --file examples/ar-coating.json --mode wavelength `
  --start 450 --stop 700 --step 5 --fixed 0 --minima --format csv --out ar.csv

# 角度扫描（偏振变化 / Brewster）
node dist/cli.js scan --file examples/bare-glass.json --mode angle `
  --start 0 --stop 89 --step 1 --fixed 550

# 两个折射率版本/膜系比较
node dist/cli.js compare --fileA a.json --fileB b.json --mode wavelength `
  --start 450 --stop 700 --step 5 --fixed 0

# 守恒核验、零厚度/合并自检、历史读取
node dist/cli.js conserve --file examples/absorbing-stack.json --wl 550 --angle 30
node dist/cli.js merge-test --file examples/ar-coating.json --wl 550
node dist/cli.js history
node dist/cli.js get --id 1 --format csv
```

## 演示

```powershell
npm run demo
```

演示内容：裸基底 vs 四分之一波抗反射膜、反射谷与采样分辨率说明、Brewster 角附近 s/p 偏振差异、吸收膜非零 `A` 与 `R+T+A=1`，以及关闭并重新打开 SQLite 后读取历史报告。

## 目录结构

```
src/
  complex.ts    复数运算（自包含）
  optics.ts     Fresnel 系数、特征矩阵、R/T/A 与校验/稳定范围
  materials.ts  离线折射率色散模型 + 内置材料
  stackio.ts    膜系 JSON 导入、相邻同折射率层合并
  scan.ts       波长/角度扫描、谱差异、反射极小点
  exporters.ts  JSON / CSV
  db.ts         SQLite 冻结与快照
  server.ts     HTTP API
  cli.ts        命令行
  demo.ts       端到端演示
test/           node:test 测试（独立解析参考）
examples/       示例膜系 JSON
data/           SQLite 数据目录（运行后生成）
```

## 已知限制

- 仅各向同性、非磁性、平面平行膜层；不处理粗糙度、散射、非相干厚基底、各向异性与磁响应。
- 入射介质与基底限定为无吸收实折射率；吸收仅允许出现在膜层。
- 内置材料为离线常数/经典色散，非商用材料数据库档案；关键结果请以实测折射率为准。
- 极小点为离散网格结果，不替代连续优化。
