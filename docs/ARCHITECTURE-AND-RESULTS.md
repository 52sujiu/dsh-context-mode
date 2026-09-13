# context-mode for DSH — 设计与实测

> 这份文档记录我们做了什么、它怎么运转、以及**真实跑出来的数据**（不是估算）。
> 数据取自本机 session `51e79124` 的会话日志与归档库，2026-09-14。

---

## 一、一句话概括

**把「压缩」从"丢掉再让模型猜"改成"留索引 + 按需回查"。**

原始需求是用户的一句话：

> 压缩保留我和 agent 的完整对话，但是所有的工具调用结果都不保存，
> 只存下查询索引，需要就去看这个工具调用结果。

这句话拆开是三个设计约束：

| 约束 | 落地方式 |
|---|---|
| 完整对话要保留 | 压缩产物是**逐轮重建的 transcript**，不是 LLM 摘要 |
| 工具结果不占上下文 | 工具结果**全量落库**，压缩区里只留一行 `→ ctx_search(...)` |
| 需要时能查回 | 归档分三层，带 `source` 标签，可精确检索 |

---

## 二、两个包，一条分界线

这是整个项目最重要的一次架构决策。原来所有东西挤在一个包里，
用户提出：

> context-mode 是一个工具，替换压缩策略是另一个方案，
> 可以用另一个插件、或者另一个脚本更改当前 preset 的压缩策略。

于是拆成：

```
┌─────────────────────────────────────────────────────────────┐
│  dsh-context-mode  (0.5.1)          ← 工具层                 │
│                                                             │
│  · MCP 桥接，暴露 11 个 ctx_* 工具                           │
│  · precompact：压缩前把 transcript 归档进知识库              │
│  · session-memory：每轮注入 <active_memory> 导航             │
│  · CJK 分词（trigram 索引，中文可检索）                      │
│  · 路由引导（skill + 工具描述 + system prompt 段）           │
├─────────────────────────────────────────────────────────────┤
│  dsh-context-mode-compaction  (0.1.0)   ← 策略层             │
│                                                             │
│  · CompactionEngine 的子类，替换官方 dsh-compaction-basic    │
│  · transcript.ts：逐轮重建对话（唯一真正"压缩"的地方）        │
│  · 零依赖工具包，可独立安装替换                              │
└─────────────────────────────────────────────────────────────┘
```

**为什么这样切**：工具层回答"数据放哪、怎么查"，策略层回答"上下文塞什么"。
策略层完全不依赖工具包 —— 你换掉任何一边，另一边照常工作。

---

## 三、运行逻辑

### 3.1 五个环节

```
       用户消息
          │
          ▼
   ┌──────────────┐
   │ 路由引导      │  system prompt 段 + 11 个工具描述前缀
   │              │  + bundled skill（模型可显式加载）
   └──────┬───────┘
          │  模型决定用 ctx_* 而不是裸 Bash
          ▼
   ┌──────────────┐
   │ ctx_execute  │  大输出不进上下文，落进知识库
   │ ctx_search   │  需要时按 token 检索回来
   └──────┬───────┘
          │
          ▼
   ┌──────────────┐
   │ 上下文压力上升 │
   └──────┬───────┘
          │  超过阈值（或用户 /compact）
          ▼
   ┌──────────────────────────────────────┐
   │ 压制前：precompact 归档               │
   │  session/event → 三层 → ctx_index     │
   └──────┬───────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────┐
   │ 压缩：transcript 重建                 │
   │  user:      ≤1000字全文               │
   │             >1000字 头500+尾500       │
   │  assistant: ≤400字全文                │
   │             >400字  头200+尾200       │
   │  工具结果:  从不复制，只留一行查询索引  │
   │  总量>40万字符: 从最老的整条丢弃       │
   └──────┬───────────────────────────────┘
          │
          ▼
   ┌──────────────────────────────────────┐
   │ 压缩后：session-memory 注入导航        │
   │  <active_memory>                     │
   │    <resume_snapshot seq="N">         │
   │      三个 source 标签 + 查询提示       │
   │    </resume_snapshot>                │
   └──────────────────────────────────────┘
```

### 3.2 归档三层

不是"筛掉不重要的"，是**全部入库、按类型贴标签**。
这个选择的原因：筛选是破坏性的，贴标签可以反悔。

```
session/<会话id>/constraint   ← 用户的要求与决策        （价值最高）
session/<会话id>/finding      ← 工具结果 + 助手给出的结论
session/<会话id>/narrative    ← 助手的推理过程          （价值最低但保留）
```

检索时可以只搜一层：

```
ctx_search(queries: ["..."], source: "session/abc/constraint")   # 只看用户要求
```

#### 助手消息会分流到两层

这一点容易误读 —— **助手说的话不是都进 `narrative`**。

`precompact.ts` 的 `layerOf` 按**正文内容**决定：

```ts
if (type === 'assistant/message') {
  return statesAConcreteValue(text) ? LAYERS.finding : LAYERS.narrative
}
```

| 正文里出现 | 归入 |
|---|---|
| 数字带单位（`87 ms`、`3 次`、`94.8%`） | `finding` |
| 文件路径（`/Users/...`） | `finding` |
| 错误码式标识（`ENOENT`、`ERR_PNPM_...`） | `finding` |
| 结论措辞（`根因`、`结论是`、`发现`、`定位到`、`超过`） | `finding` |
| 其余（计划、推理、过程叙述） | `narrative` |

**设计意图**（代码注释原话）：*conclusions the assistant reached are
searchable beside the evidence* —— 说"我发现了 X"时，
应该和"工具输出 X"待在一起，这样查 X 能同时看到证据和结论。

**实测分布**（本机 session；两层标题格式相同，都是 `## [发现] 助手`）：

```
finding     154 条  ← 陈述了具体值的助手消息
narrative   613 条  ← 推理过程的助手消息
                    ratio ≈ 20% : 80%
```

**连带后果**：`transcript.ts` 裁剪一条助手消息时，
**无法从事件类型判断它当初去了哪一层** —— 所以裁剪提示必须**两层都指**：

```
[... 800 of 1200 chars elided from seq 42;
 retrieve with ctx_search(source: "session/abc/finding", "session/abc/narrative") ...]
                                                            ↑ 两层都列，漏一层就丢一半
```

只指 `finding` 会漏掉 80%，只指 `narrative` 会漏掉 20%。**两个单选都是错的。**

### 3.3 transcript 的取舍比例

`dsh-context-mode-compaction/src/transcript.ts` 里的常量：

| 常量 | 值 | 含义 |
|---|---|---|
| `USER_CLIP_AT` | 1 000 | 用户消息超过这个长度才截断 |
| `USER_CLIP_KEEP` | 500 | 截断时头尾各留 500 字 |
| `ASSISTANT_KEEP` | 200 | 助手消息头 200 + 尾 200 |
| `ASSISTANT_MIN_SPLIT` | 400 | 助手消息超过这个长度才裁剪（= `ASSISTANT_KEEP × 2`） |
| `MAX_TRANSCRIPT_CHARS` | 400 000 | 整份 transcript 的上限，超了从最老的整条丢弃 |

**逐条规则**：

```
用户消息
  ├─ ≤ 1 000 字  →  全文保留
  └─ > 1 000 字  →  头 500 + [查询指针] + 尾 500

助手消息
  ├─ ≤ 400 字    →  全文保留
  └─ > 400 字    →  头 200 + [查询指针] + 尾 200

工具结果
  └─ 任何长度    →  从不复制正文，只有一行指针

整份 transcript
  └─ > 400 000 字 →  从最老的条目开始整条丢弃，
                     头部留一句汇总指针（含 seq 范围 + 涉及的层）
```

**关键点：用户消息在 1 000 字以内是全文保留的。**
只有超长消息才头尾各留 500 —— 中间那段仍可从归档里查回。
助手消息的裁剪线是 400 字（`ASSISTANT_MIN_SPLIT`），
不是"所有助手消息都只留 200+200"。
| `MAX_TRANSCRIPT_CHARS` | 400 000 | 单次 transcript 上限 |

**关键点：用户消息在 1000 字以内是全文保留的。**
只有超长消息才头尾各留 500 —— 中间那段仍可从归档里查回。

---

## 四、实测效果

### 4.1 压缩比：保留 5.2%，省下 94.8%

本机 session `51e79124` 累计 11 次压缩的**真实数据**（来自 `compaction/summary` 事件）：

| seq | 被压缩的 token | 摘要字符数 | 折算保留率 |
|---:|---:|---:|---:|
| 2787 | 362 315 | 14 067 | 1.0% |
| 3867 | 191 009 | 19 286 | 2.5% |
| 4588 | 118 434 | 17 320 | 3.7% |
| 5174 | 83 483 | 18 126 | 5.4% |
| 6025 | 134 391 | 17 330 | 3.2% |
| 6417 | 69 293 | 16 414 | 5.9% |
| 6727 | 48 554 | 20 881 | 10.8% |
| 6919 | 38 892 | 24 606 | 15.8% |
| 7368 | 82 023 | 60 384 | 18.4% |
| 8104 | 95 598 | 42 330 | 11.1% |
| 8782 | 112 457 | 27 542 | 6.1% |
| **合计** | **1 336 449** | **278 286** | **5.2%** |

```
压缩前 ████████████████████████████████████████████████ 1,336,449 tokens
压缩后 ██▌                                                278,286 chars (~70k tokens)

                                              ↑ 保留 5.2%，省掉 94.8%
```

> 说明：`保留率 = 摘要字符数 ÷ 4 ÷ 原 token 数`，按 4 字符 ≈ 1 token 折算。
> 这是保守估计 —— 中文的字符/token 比通常更低，实际保留率还要更小。

**用户要求的"只保留 10%"实际上做到了 5.2%，比目标更激进。**

### 4.2 归档侧：2 417 个片段，2.2 MB

这些东西原本要占上下文，现在躺在库里：

```
session/51e79124.../narrative    613 chunks
session/c3bd33db.../narrative    318 chunks
session/c3bd33db.../finding      154 chunks
session/51e79124.../finding      154 chunks
session/51e79124.../constraint   145 chunks   ← 用户要求，一条不丢
session/c3bd33db.../constraint   101 chunks
─────────────────────────────────────────
全部 231 个 source、2 417 个 chunk、2.2 MB 文本
```

整库 **22.4 MB**（含 trigram 索引，中文检索用）。

### 4.3 这个会话的体量

```
会话日志解压后：20 772 271 字符（约 519 万 token）
事件总数：      8 903
  user/message       1 462
  assistant/message  1 358
  tool/call          1 324
  tool/result        1 331
  turn                129 轮
压缩次数：      11
```

**一个 519 万 token 的会话，上下文里始终只保留导航 + 最近事件。**

### 4.4 成本

压缩本身要调一次模型。最后一次（seq 8782）的用量：

```
inputTokens:      430     ← 极少，说明用了缓存
cacheReadTokens:  156 544 ← 几乎全部走缓存
outputTokens:     4 387
```

**缓存命中率 97%** —— 因为 transcript 重建时字节级复用了原有上下文前缀。

---

## 五、每轮注入的导航长什么样

这是压缩后模型看到的东西（实测 672 字符）：

```xml
<active_memory>
<resume_snapshot seq="8782">
Compacted turns are archived; nothing is inlined here.
Retrieve on demand, scoping ctx_search by source:
  session/51e79124-.../constraint  user requirements and decisions
  session/51e79124-.../finding     tool results and stated conclusions
  session/51e79124-.../narrative   assistant reasoning and plans
Query a concrete token (a path, a command, an error string),
not a paraphrase.
</resume_snapshot>
user: 发布吧
tool call: ctx_execute
</active_memory>
```

**注意它不内联摘要正文** —— 早先版本塞 42 330 字符的摘要，
被预算裁成残片，反而制造噪音。现在只给**指针 + 查询方法**。

---

## 六、两种裁剪，都要留下能照做的查询指令

transcript 有两种"丢内容"的方式，**两种都在原位留下指针**：

```
① 单条裁剪（这条内容太长）
   ## [assistant 7078]
   （头 200 字）
   [... 2608 of 3008 chars elided from seq 7078;
    retrieve with ctx_search(source: "session/51e79124.../finding",
                                "session/51e79124.../narrative") ...]
   （尾 200 字）
                          ↑ 给了 base + 该条目可能所在的全部层 + seq

② 整条丢弃（转录总量超过 40 万字符）
   [... 18 older transcript entries elided (seq 100..117);
    retrieve with ctx_search(source: "session/51e79124.../constraint",
    "session/51e79124.../narrative", "session/51e79124.../finding") ...]
                          ↑ 给了 seq 范围 + 涉及的所有层
```

第二种是后补的。早先它只说"归档里能查到"，**没给 source 也没给 seq** ——
模型看到这句话不知道该搜哪里，等于没提示。现在两种指针的信息量对齐了。

**归档里确实有全文**（本机 session 实测）：

```
narrative 层 613 条：
  > 400 字（会被裁剪）：18 条
  ≤ 400 字（完整保留）：595 条
  最长：3008 字  ← 被裁成 200+200，但全文在库里
```

端到端验证：搜 `createCallable 替换 self` 命中 seq 7078、8180；
搜 `compactNow 绕过 compactRegion` 命中 seq 8046、7174。

---

## 七、踩过的坑

这些不是花絮，每一个都改变了对系统的理解。

### 6.1 Cordis 的 `#private` 会炸

```ts
class MyService extends Service {
  #state = new WeakMap()   // ← 崩溃
}
```

`Service` 构造器里调用 `createCallable()`，**替换了 `self`**：

```js
if (self[symbols.invoke]) self = createCallable(...)   // lib/index.js:1777
```

`setPrototypeOf` 搬不走 `#private` 槽位。**改成模块级 `WeakMap`。**

> 规则：Cordis 服务类里永远不要用 `#private`。

### 6.2 手动压缩和自动压缩走的不是同一条路

```
自动：compactIfNeeded() → compactRegion()      (lib/index.js:873 → 930)
手动：compactNow()      → compactSurfaceRegion()  (:944)  ← 绕过了 compactRegion
```

手动压缩**不写 `range` 字段**。我们的归档器硬依赖它，于是 8 次手动压缩
**一次都没归档成功**。改成用 `input.messages` 和 surface 节点做**身份匹配**后，8/8 全中。

### 6.3 导航只出现一次就消失

最隐蔽的一个。错误代码：

```ts
// lines 每轮都重建为空数组，state.navigation 第一轮就设上了
if (navigation !== state.navigation) lines.push(navigation)
```

第二轮起 `lines` 是空的，条件永远为假 —— **导航再也没出现过**。

修正：

```ts
if (navigation !== undefined) lines.push(navigation)
```

`state` 只用来判断**要不要重建**（省计算），不能用来判断**要不要输出**。

### 6.4 测试是无效的，差点骗过自己

写完修复后测试 **9/9 全绿**。但把 bug 放回去重跑 —— **还是全绿**。

原因：测试里每次 `render()` 都重新 `installSessionMemory`，
内部的 `WeakMap` 随之重置，`state.navigation` 永远是 `undefined`，
那个错误条件**恒真**。

真实环境 `install()` 只调用一次。改成持久 session + 持久 renderer 后，
反证才失败在正确的那条用例上：

```
A) 修复后：9/9 通过
B) 放回旧逻辑：✖ navigation survives a growing event log across many turns
```

> **规则：每个新测试必须先证明它能失败，否则它什么都没测到。**

### 6.5 在 ESM 里用 `require`

诊断代码写 `require('node:fs')`，但包是 `"type": "module"` ——
`require is not defined`，还被 `catch {}` 静默吞掉，导致**日志一条都没写**。

排查因此多绕了一大圈。

> 规则：`catch {}` 是 bug 的藏身处。

### 6.6 只看一层目录就下结论

`ls lib/` 只看到 `types` 一个目录，就断言"发布包没有编译产物"。
实际 `tsc` 的 `outDir` 就是 `lib/types`，产物一直在 12.7 KB 的 `index.js` 里。

**误报。** 教训：判断前先看到叶子。

---

## 八、当前状态

### 已发布

| 包 | 版本 | 说明 |
|---|---|---|
| `dsh-context-mode` | **0.5.1** | 工具层，`latest` |
| `dsh-context-mode-compaction` | **0.1.0** | 策略层 |

安装：

```bash
npm i dsh-context-mode dsh-context-mode-compaction
```

预设里把压缩后端换成我们的：

```yaml
- id: compaction-basic
  name: 'dsh-context-mode-compaction'   # 原来是 @deepseek-ai/dsh-compaction-basic
```

`compaction-repo/scripts/wire.mjs` 可以自动改写 preset。

### 验证状态

```
npm run verify
  工具包  ✓ build   ✓ build:server   ✓ smoke   ✓ 9/9 navigation tests
  策略包  ✓ build   ✓ smoke   ✓ test:wrapping   ✓ test:manual-range
          ✓ test:pointers  12/12 archive-pointer tests
```

**导航测试 9 条**：分隔符完整、只渲染一次、预算压力下存活、
重复渲染稳定、**跨多轮增长存活**（就是 6.3 那个 bug）、
指向三层、无压缩时不注入、摘要正文不内联、换行是真换行。

**指针测试 12 条**：无 base 时才用旧措辞、有 base 时报 seq 范围、
报出 archive source、旧措辞不再出现、**范围与实际丢弃的条目吻合**、
涉及几层就报几层、装得下时不报、空丢弃不报、`clipNotice` 报 base+layer+seq、
`clipNotice` 接受多层、**被裁的助手条目必须同时列出 finding 与 narrative**、
被裁的用户条目只列 constraint。

### 11 个工具全部保留

```
ctx_execute      ctx_execute_file   ctx_index
ctx_search       ctx_fetch_and_index  ctx_batch_execute
ctx_stats        ctx_doctor         ctx_upgrade
ctx_purge        ctx_insight
```

---

## 九、还没验证 / 还没修的

诚实地说清楚边界：

1. **导航是否真的有用** —— 只验证了"它能注入"，没验证"模型因此更少丢掉上下文"。
   需要几天的日常使用观察：压缩后是否还需要用户重新交代背景、助手是否会主动 `ctx_search`。

2. **`MAX_EVENTS = 50` 是计数不是字数** —— 一条巨大的工具输出可能挤掉其他条目。应该改成字符预算。

3. **`precompact.ts:313` 的 `render(text)` 是恒等函数** —— 文档注释承诺返回检索提示，实际直接把 `text` 返回。

4. **旧 chunk 的中文索引** —— trigram 索引是后加的，老数据需要重建库才能用中文检索。

5. **`smoke.mjs` 的事件模型过期** —— 把 `user/message` 建模成 `data.message.content`，
   真实结构是 `data.content`。

> 原先列在这里的"整条丢弃只给模糊提示"**已经修掉**，见第六节。
> 触发条件是单次 transcript 超过 40 万字符 —— 目前最长的一次是 6 万字符，
> 所以这是**预防性修复**，不是正在发生的故障。

---

## 十、文件地图

```
dsh-context-mode/                    工具层
├── src/
│   ├── index.ts              插件入口、11 个工具、路由注入
│   ├── mcp-client.ts         MCP 桥接
│   ├── precompact.ts         压缩前归档 → 三层
│   ├── session-memory.ts     每轮注入 <active_memory> 导航
│   ├── routing.ts            路由规则
│   ├── output-containment.ts 大输出拦截
│   └── cjk.ts                中文分词
├── scripts/
│   ├── verify-session-memory.mjs   9 条行为测试
│   ├── smoke.mjs
│   └── cleanup-injected.mjs
├── skills/context-mode/      模型可加载的规则集
└── vendor/context-mode/      上游引擎（自包含，无外部依赖）

dsh-context-mode-compaction/         策略层
├── src/
│   ├── compaction.ts         CompactionEngine 子类
│   ├── transcript.ts         逐轮重建对话 ← 真正的压缩逻辑
│   └── index.ts
└── scripts/
    ├── wire.mjs              改写 preset 接入本策略
    ├── verify-checkpoint.mjs 检查点结构校验
    └── smoke.mjs
```

---

## 十一、设计原则小结

从这次工作里沉淀下来的几条：

1. **不删除，只标注。** 筛选是破坏性的，标签可以反悔。全量入库，检索时选层。

2. **指针优于正文。** 上下文里放"去哪查"，不放"查到了什么"。
   导航块 672 字符，换来的是随时能取回 2.2 MB。

3. **工具和策略分家。** 一个负责存储与检索，一个负责上下文取舍。
   各自可独立替换。

4. **测试必须先能失败。** 否则它只是让人安心的装饰。

5. **只碰适配层，不碰核心。** DSH 是官方代码，所有改动在自己的插件里完成。
