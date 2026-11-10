# 形象包格式

仓库不自带形象包，也不含任何动作素材。一个形象包就是一个目录，你把它放在哪里都行，用 `LINGXI_PACK` 指给程序：

```text
<形象包目录>/
  figure.json       # 这个文件，描述形象和动作
  clips/*.webm      # figure.json 里点名的片段
  motion.cjs        # 必需：你自己的运动算法（见文末）
```

`LINGXI_PACK` 也可以是 `packs/` 下的目录名；没设时读 `~/.lingxi/pack` 里记的路径。两处都没有，启动会停下来说明。`LINGXI_CLIPS` 可以把片段放到别处，默认就是形象包里的 `clips/`。

**放在仓库里也可以**：这个仓库约定 `packs/<名字>/` 是本机自己的形象包（比如 `packs/local/`），`.gitignore` 会把它整个忽略，不会提交、也不会发布；只有本文件、`figure.schema.json`、`check.ts` 三个格式文件是跟踪的。所以你可以直接在项目目录里改包、换片段，改完照常启动。

机器可读的格式在 [figure.schema.json](figure.schema.json)。下面的字段和启动时的检查是同一套：缺字段、类型不对，都会报出是哪个字段。

## 最小示例

```json
{
  "name": "我的形象",
  "refWidth": 462,
  "bodyWidth": 462,
  "nativeFacing": "left",
  "idle": ["待机"],
  "held": ["被拎起"],
  "noMirror": [],
  "moves": {
    "walk": [
      { "clip": "走几步", "leadSec": 0.2, "tailSec": 0.2, "minDist": 60, "maxDist": 240 }
    ],
    "run": [
      { "clip": "跑", "leadSec": 0.2, "tailSec": 0.2, "minDist": 120, "maxDist": 320 }
    ]
  },
  "words": { "wave": ["挥手"] }
}
```

## 字段

| 字段 | 必填 | 含义 |
|---|---|---|
| `name` | 是 | 形象名，会出现在对话上下文里 |
| `refWidth` | 是 | 移动距离是按多宽的身体调的（像素） |
| `bodyWidth` | 是 | 这个形象实际画出来多宽（像素） |
| `nativeFacing` | 是 | 片段里人物朝哪边：`"left"` 或 `"right"`，另一边靠镜像 |
| `idle` / `held` | 是 | 待机、被拎起时用的片段，至少各一个 |
| `noMirror` | 是 | 镜像会读错字的片段（没有就写 `[]`） |
| `canvas` | 否 | 片段的画布尺寸 `{ "width", "height" }`；给了才能按 `hit.box` 算触区 |
| `hit.box` | 否 | 人物可点的范围，画布坐标 `{ "x0", "y0", "x1", "y1" }` |
| `moves` | 是 | 怎么走、怎么跑（见下） |
| `words` | 是 | 动作词到片段的映射，每个词至少一个片段 |
| `vocab` | 否 | 给前台看的动作说明：`kind`（`motion` / `expression`）、`zh` 中文名、`about` 什么样、`when` 什么时候用、`mood` 心情标签（如 `calm`、`happy`，自由词表，前台和日常层按它挑） |
| `source` | 否 | 你自己想留的来源备注，程序不读 |

### `moves`

| 字段 | 必填 | 含义 |
|---|---|---|
| `walk` | 是 | 走路的动作列表，按顺序给距离在范围内的走法 |
| `run` | 是 | 跑的动作列表，可以是空数组 |
| `teleport` | 否 | 身体是否支持瞬移越过障碍；`false` 时用 `cross` |
| `cross` | 否 | 不能瞬移时，跨过不可走区域用的那一个动作 |

每个动作（走、跑、跨）的字段：

| 字段 | 必填 | 含义 |
|---|---|---|
| `clip` | 是 | 片段文件名，必须在 `clips/` 里；不能带路径 |
| `leadSec` | 是 | 片段开头原地不动的时间 |
| `tailSec` | 是 | 片段结尾原地不动的时间 |
| `minDist` / `maxDist` | 是 | 这一步至少、最多走多远（`refWidth` 下的像素） |
| `segment` | 否 | 只用片段中间一段 `{ "startSec", "endSec" }`，需要连续、原速 |
| `durationSec` / `endSec` | 否 | 片段总长和截断点，给需要掐掉结尾的动作 |
| `id` / `zh` / `en` / `about` / `when` | 否 | 给前台看的名字和用法说明 |
| `default` | 否 | 写 `false` 表示这个走法只在被点名时用 |

## 检查和出错

先单独检查一下，不用启动整个程序：

```powershell
pnpm check:pack D:\MyFigure
```

也可以用 `pnpm run setup:app -- --pack D:\MyFigure` 检查并记录路径；它和启动器使用同一套片段与运动模块校验。

它会读一遍 `figure.json`，列出它点名的片段，指出哪些在 `clips/` 里找不到。退出码 1 表示这个包启动不了。

不先检查也可以，启动时会依次核对：目录在不在、`figure.json` 能不能解析、每个必填字段对不对。报错写成 `figure pack <目录>: <字段> ...`，照着改那个字段即可。

## 运动算法（必需）

身体不自带运动实现。横向移动、弹簧、松手速度、重力与反弹、摩擦都由形象包里的 `motion.cjs` 提供：

```js
// <形象包>/motion.cjs
module.exports = {
  // 一次横向移动：mode 是 instant / line / spring，返回 { x, done, step(dtSeconds) }
  createMove({ mode, from, to, ms }) {},
  // 片段时间 t 对应的窗口位置（走路的起步、行进、收尾都由它决定）
  travelX({ start, target, leadSec, tailSec, duration, t }) {},
  // 松手速度：返回 { vx, vy, speed, throw }
  estimateReleaseVelocity(trail, now) {},
  // 下落一步：返回 { x, y, vx, vy, bounced, speed, atRest }
  fallStep(state, dtSeconds, bounds) {},
};
```

- 四个函数都必须给出。缺一个、文件不在、加载报错，程序都会停在启动前，报出缺的是什么；程序不会内置另一套算法兜底。
- 几何辅助（`targetLeft`、`centreShare`、`bottomTop`、`clampWindow`、`fallBounds`）仍然用内置的，保证窗口和工作区的坐标换算一致。
- 这是你自己的代码，程序会直接 `require` 并执行。写错或加载失败会在启动前报错；仓库没有另一套运动算法可以回退。
- 环境变量 `BODY_MOTION` 可以临时指向别的模块路径，方便调试；正常启动时由程序按形象包目录传入。

## 片段本身

片段是普通的视频文件，文件名就是 `figure.json` 里写的名字。它们不进这个仓库，放哪由你决定；`LINGXI_CLIPS` 不设时就找形象包自己的 `clips/`。

本项目的代码只负责动作系统和避障：什么时候走、走到哪、怎么绕开窗口。某个动作长什么样、叫什么名字，全部由形象包决定。
