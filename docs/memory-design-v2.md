# Pi Memory Module 技术方案 (v2)

> 合并 `memory-design.md` v1 方案与审查反馈，修正 API 对齐、状态持久化、热度公式、合并策略、安全边界等问题。

## 一、结论

方向可取：**索引预览 + 按需工具检索 + 会话分支隔离** 适合 Pi 的记忆场景。Token 效率远超全量注入和单纯向量检索，复杂度可控，不引入外部依赖。

v1 主要问题：使用不存在的 `before_system_prompt` 事件；全量快照写入 tool result `details` 导致 JSONL 膨胀；热度公式反向加分；合并策略无法处理纠正；安全边界缺失；Pi-Web 集成假设未经验证。

---

## 二、核心架构：三温层 + 事件日志

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Architecture (v2)                      │
│                                                                 │
│  ┌────────────────┐  Token Cost: ~150-300                       │
│  │  HOT LAYER      │  context 事件注入 memory index (key+hint)     │
│  │  (索引层)       │  "preferred_db → PostgreSQL"                │
│  │                │  排序: accessCount * 10 + recencyDecay * 3   │
│  └───────┬────────┘                                              │
│          │ LLM calls memory_get(key)                              │
│  ┌───────▼────────┐  Token Cost: 按需 1-3 条                      │
│  │  WARM LAYER     │  工具调用返回完整 value                       │
│  │  (值存储层)     │  内部 store: Map<key, MemoryEntry>            │
│  │                │  持久化: appendEntry("memory", {...}) event   │
│  │                │  合并: 默认覆盖，冲突时请求模型确认             │
│  └───────┬────────┘                                              │
│          │ LLM calls memory_search(query)                         │
│  ┌───────▼────────┐  Token Cost: 0 (不在上下文)                    │
│  │  COLD LAYER     │  压缩层: 复用 pi built-in compaction          │
│  │  (归档层)       │  /compact 产生的 summary entry               │
│  │                │  不需要额外实现                                │
│  └────────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
```

### 存储层：事件日志替代全量快照

v1 把完整 `memories[]` 数组塞进每次 tool result 的 `details` 字段，导致 JSONL 迅速膨胀（50 条记忆 x 5 次 set = 写入 250 条序列化对象）。v2 改为：

- **每次 set/delete/access** 调用 `pi.appendEntry("memory", { op, key, patch, timestamp })`，写入一条轻量事件。
- **重建时**扫描 `ctx.sessionManager.getBranch()`，过滤 `type === "custom" && customType === "memory"` 的条目，按时间顺序重放事件还原当前 `memories` Map。
- **tool result 的 details 不再写全量快照**，只写当前操作的摘要（action + affected key）。

这一条事件通常在 100-200 字节级别，v1 的快照通常是该数量的 N 倍（N = 记忆条数）。

### 注入层：context 事件

v1 使用 `pi.on("before_system_prompt")`——该事件在 Extension API 中不存在。v2 改为 `pi.on("context")`：

```typescript
pi.on("context", (_event) => {
  const indexBlock = buildMemoryIndex(memories);
  if (indexBlock) {
    // 在 messages 数组前部插入一条 system-like message
    return {
      messages: [createSystemMessage(indexBlock), ..._event.messages],
    };
  }
});
```

`ContextEventResult` 允许返回替换 `messages` 数组，扩展可以直接在 LLM 看到的 messages 前部追加 memory index，效果等价于 v1 的 system prompt 注入意图但使用正确的事件。

---

## 三、数据结构

```typescript
type MemoryCategory = "fact" | "decision" | "preference" | "context";

interface MemoryEntry {
  id: number;              // 自增 ID（replay 恢复）
  key: string;             // snake_case，非空，≤64 字符，regex: /^[a-z][a-z0-9_]*$/
  value: string;           // 完整内容，非空，建议 ≤500 字符（软限制，超限不截断但警告）
  category: MemoryCategory;
  createdAt: number;       // 首次创建时间戳
  updatedAt: number;       // 最后更新时间戳
  accessCount: number;     // 累计访问次数
  lastAccessed?: number;   // 最后访问时间戳
}

// appendEntry 写的事件格式
type MemoryOp = "set" | "delete" | "access";
interface MemoryEvent {
  op: MemoryOp;
  key: string;
  patch?: { value: string; category: MemoryCategory };
  timestamp: number;
}
```

### Category 语义

| Category | 含义 | 示例 |
|----------|------|------|
| `fact` | 客观信息 | `staging_url: https://api.staging.example.com` |
| `decision` | 设计/技术决策 | `auth_strategy: JWT with refresh tokens, 15min expiry` |
| `preference` | 用户偏好 | `test_framework: Vitest (migrated from Jest 2025Q1)` |
| `context` | 环境细节 | `ci_provider: GitHub Actions, deploy on push to main` |

### 数据校验（收紧）

| 字段 | 规则 | 拒绝行为 |
|------|------|---------|
| `key` | 非空；≤ 64 字符；`/^[a-z][a-z0-9_]*$/`；无连续下划线 | 返回错误提示，不执行 |
| `category` | 必须为 `fact | decision | preference | context` 之一 | 返回错误提示，列出有效值 |
| `value` | 非空；建议 ≤ 500 字符 | ≤ 500 正常存储；> 500 存储但返回 `[truncated]` 警告提示模型考虑拆分 |
| 秘密检测 | 默认拒存含 `api_key`、`token`、`private_key`、`secret`、`password` 等词的 key | 返回拒绝提示，说明安全策略 |

---

## 四、热层排序算法

v1 公式问题：`score = accessCount * 10 + (Date.now() - updatedAt) / 86400000`——`Date.now() - updatedAt` 是 elapsed 天数，越大越旧，却用加法正向加分，导致最旧记忆排第一。

v2 修正公式（稳定且有界）：

```
recentAccessScore = 1 / (1 + log2(1 + accessAgeHours))   // 1 小时内 = 1.0，24h ≈ 0.33，168h ≈ 0.2
recentUpdateScore = 1 / (1 + log2(1 + updateAgeHours))   // 同上

score = accessCount * 10 + recentAccessScore * 30 + recentUpdateScore * 20
```

- `accessCount * 10`：高频记忆天然靠前
- `recentAccessScore * 30`：最近访问的加权（最多贡献 30 分，衰减快）
- `recentUpdateScore * 20`：最近更新的加权（最多贡献 20 分）
- 所有项单调递减（越旧分越低），不存在 v1 的反向加分
- 取 score 最高的 **8 条**（`MAX_HOT_KEYS = 8`）

> 此公式只在外显时计算；对内存中所有 entry 即时排序，无需缓存 score 字段。

---

## 五、合并策略

v1 "更长值优先" 的问题：如果用户纠正一条错误记忆（新值比旧值短），自动保留旧值导致错误信息不灭。

v2 改为显式覆盖 + 冲突感知：

| 场景 | 行为 |
|------|------|
| 新 key | 直接新增 |
| 同 key，新 value 与旧 value 相似 (Jaro-Winkler ≥ 0.8) | 覆盖旧值，视为澄清/修正 |
| 同 key，新 value 与旧 value 差异显著 | 返回提示："memory key `X` already exists with different content. Choose: replace / append / delete_old。回复指令或调用 `memory_set` 时附带 `action: replace|append`" |
| 同 key，附带 `action: append` | 追加到旧值末尾，用 `\n\n` 分隔 |
| 同 key，附带 `action: replace` | 直接覆盖（模型确认过） |

不自动判定长文本胜出。模型通过显式指令表达意图。

---

## 六、工具设计

### 6.1 memory_set — 写入/更新记忆

```
输入: key (string), value (string), category? (string), action? ("replace" | "append")
行为:
  - 校验 key/value/category
  - 检查 key 是否存在，按合并策略处理
  - 写入内存 Map
  - 调用 pi.appendEntry("memory", { op: "set", key, patch: { value, category }, timestamp })
输出: 状态文本 + affected key
details: 只写 { action: "set", key, summary, timestamp }（非全量快照）
```

### 6.2 memory_get — 精确获取

```
输入: key (string)
行为:
  - 精确匹配 key
  - accessCount++, lastAccessed = now
  - appendEntry("memory", { op: "access", key, timestamp })
输出: 完整 value（category 标记），或 "No memory found: key" + 可用 key 列表
Token: ~120 tokens/次
```

### 6.3 memory_search — 模糊搜索

```
输入: query (string)
行为:
  - 对 key 和 value 做大小写不敏感 substring 匹配
  - 匹配的 entry 执行 accessCount++ 和 access 事件写入
  - 最多返回 5 条结果
  - 如果 query 为空或 "*"，按 score 降序返回前 5 条
输出: 匹配的 key-value 列表
Token: ~350 tokens/次（最多 5 条）
```

> 第一版不使用向量检索。编程场景记忆 < 100 条时关键词匹配精度足够。> 500 条后可考虑引入 `sqlite-vec` 或本地 embedding 模型。

### 6.4 memory_list — 列表预览

```
输入: category? (string)  // 可选的分类过滤
行为: 列出所有记忆，每条 key + 80 字符脱敏 preview
输出: 列表文本
```

### 6.5 memory_delete — 删除

```
输入: key (string)
行为: 从 Map 中删除对应 key
      调用 appendEntry("memory", { op: "delete", key, timestamp })
输出: "Deleted: key" 或 "No memory found: key"
```

---

## 七、状态重建与分支隔离

### 重建流程

```typescript
// session_start, session_tree, 或 session_before_switch 触发
const rebuildFromBranch = (ctx: ExtensionContext) => {
  const store = new Map<string, MemoryEntry>();
  let nextId = 1;

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue;
    if (entry.customType !== "memory") continue;
    const event = entry.data as MemoryEvent;
    switch (event.op) {
      case "set":
        if (store.has(event.key)) {
          store.set(event.key, {
            ...store.get(event.key)!,
            value: event.patch!.value,
            category: event.patch!.category,
            updatedAt: event.timestamp,
          });
        } else {
          store.set(event.key, {
            id: nextId++,
            key: event.key,
            value: event.patch!.value,
            category: event.patch!.category,
            createdAt: event.timestamp,
            updatedAt: event.timestamp,
            accessCount: 0,
          });
        }
        break;
      case "delete":
        store.delete(event.key);
        break;
      case "access": {
        const entry = store.get(event.key);
        if (entry) {
          entry.accessCount++;
          entry.lastAccessed = event.timestamp;
        }
        break;
      }
    }
  }
  return { store, nextId };
};
```

### 分支隔离

```
Branch A: root → user("remember X") → memory_set("foo","A") → assistant(...)
Branch B: root → user("remember Y") → memory_set("foo","B") → assistant(...)
              ↑ fork point

Branch A's getBranch() 只包含 A 路径上的 "memory" custom entries → foo = "A"
Branch B's getBranch() 只包含 B 路径上的 "memory" custom entries → foo = "B"
```

分支隔离由 `getBranch()` 天然保证：它只沿当前 leaf → root 的单链遍历，不跨分支。

### 热度恢复

关键改进：v1 只从 `memory_set/delete` 重建，丢失 `accessCount`。v2 通过事件日志包含 `access` 事件，重建时完整恢复所有 field（包括 accessCount、lastAccessed），确保重载/切分支后热度不丢失。

---

## 八、System Prompt 注入（context 事件）

### 注入内容（Token 高效版）

```xml
<memory>
You have access to persistent memory. Current index (15 total, showing top 8):

- [P] `preferred_pm`: pnpm
- [D] `auth_strategy`: JWT with refresh tokens, 15min expiry
- [F] `staging_url`: https://staging-api.example.com
- [P] `test_framework`: Vitest (migrated from Jest 2025Q1)
- [D] `db_indexing`: Use partial indexes for soft-delete queries...
- [C] `ci_provider`: GitHub Actions, deploy on push to main
- [F] `api_version`: v3, deprecating v2 by 2026Q3
- [P] `code_style`: Prefer arrow functions, no semicolons

To retrieve full details, call `memory_get` with the key.
To find memories, call `memory_search` with a query.
Categories: F(act), D(ecision), P(reference), C(ontext).
</memory>
```

**约 250 tokens**。value preview 限制 60 字符，超出截断加 "..."。

### safety: preview 脱敏

如果 key 命中敏感模式（`api_key`, `token`, `secret`, `private_key`, `password`, `credentials`），preview 替换为 `[redacted]` 而非原始值。

### context 事件 vs system prompt 拼接

`context` 事件在每次 LLM 调用前触发，收到的 `messages` 数组已经包含 system prompt 作为第一条消息。扩展可以通过返回 `{ messages: [systemWithMemory, ...rest] }` 来修改 messages 数组，将 memory index 放在 system prompt 之后、user/assistant messages 之前（或融入 system prompt 内容）。这避免了拼接字符串的脆弱性。

---

## 九、Pi-Web 集成

### 共享基础

Pi-Web 与 Pi CLI 共享同一个 `~/.pi/agent/sessions/` 目录和 JSONL session 文件格式。理论上同一 session 文件中的 `CustomEntry(customType: "memory")` 对两端都可见。

### 实际前提

v1 断言 "无需任何 Pi-Web 代码变更" 过于绝对。实际前提条件：

1. **Pi-Web 加载了 memory extension**：Pi-Web 必须在其 extension 发现路径（`~/.pi/agent/extensions/memory.ts`）中加载该扩展，或通过配置显式加载。如果 Pi-Web 没有加载该扩展 runtime，则不会监听 `context` 事件注入 memory index，也不会注册 memory tools。
2. **同一 extension runtime 和事件链**：Pi-Web 使用 `createAgentSession()` / agent-session 时，必须走相同的 `ExtensionRunner` 和事件总线管道。需要确认 Pi-Web 的 extension 加载机制与 CLI 完全一致。
3. **工具注册时机**：memory 工具需要在 agent 轮次开始前完成注册。Pi-Web 的 session 初始化顺序需要保证 extension 的 `registerTool` 调用在前。

### 验证方式

1. 确保 Pi-Web 的 extension 目录路径与 CLI 一致（`PI_CODING_AGENT_DIR` 指向相同）
2. 在 CLI 创建 session 并写入 memory，在 Pi-Web 打开同一 session 验证 `/memory` 命令可见
3. 验证 Pi-Web 下模型的 context 中是否注入 memory index

### 潜在差异

如果 Pi-Web 的 extension 加载机制存在差异（如不同的生命周期、不同的 context 构建方式），memory 扩展可能需要提供替代的集成路径。核心不变的是 JSONL session 格式：`CustomEntry(customType: "memory")` 是标准格式，无论哪端重建状态都是同一组事件。

---

## 十、命令与用户交互

### /memory list — 用户审计

```
/memory list [category]
显示所有记忆（可分类过滤），key + truncated value
支持键盘导航滚动
用于用户审计和手动清理
```

### /memory delete <key> — 用户删除

```
/memory delete staging_url
立即删除指定记忆，写入 delete 事件
输出确认信息
```

> 注意：`/memory` 命令的 `list` 和 `delete` 子命令具有不同安全语义。`list` 可显示完整 value（用户对自己的数据有完全可见权），`delete` 无需确认直接删除（用户操作视为显式意图）。

---

## 十一、安全边界

| 层级 | 规则 |
|------|------|
| **写入防御** | `memory_set` 工具拒绝 key 命中敏感词模式（`api_key`、`token`、`private_key`、`secret`、`password`、`credentials`、`passwd`、`auth_token`）。报错文本："For security, memory cannot store credentials. Use your provider's API key system or environment variables." |
| **索引脱敏** | `context` 事件注入的热索引中，命中敏感 key 的 preview 显示 `[redacted]` 而非潜在泄露内容 |
| **工具输出脱敏** | `memory_get` 返回全文时不做额外脱敏（LLM 已在 context 中），但 `details` 摘要不含 value |
| **用户审计** | `/memory list` 显示完整 value（不脱敏）— 用户对自己的数据有完全可见权 |
| **事件日志** | `appendEntry("memory", ...)` 的 `patch.value` 字段包含完整明文。这是 JSONL 的固有特性—会话文件不可与人共享 |
| **跨会话** | 第一版不做跨 session 全局文件记忆（即不做 `~/.pi/agent/memories.json`）。所有记忆限定在当前 session |

---

## 十二、Token 效率量化

| 方案 | 10 条记忆 | 50 条记忆 | 100 条记忆 |
|------|----------|----------|----------|
| 全量注入 | ~500 | ~5000 | ~10000 |
| 向量检索 Top-5 | ~300 | ~400 | ~400 |
| **本方案（索引 + 按需）** | **~150** | **~300** | **~300** |

索引层固定展示 8 条最热记忆，token 消耗几乎不随总量增长。

---

## 十三、隐藏风险

### 1. 事件日志膨胀

每条 `access` 事件都产生一次 `appendEntry` 写入。高频访问场景下（模型每轮调用多次 `memory_get/search`），JSONL 行数快速增加。**缓解**：`access` 事件可配置为不去重直接写，或在 compaction 时由 compaction 扩展合并连续的 access 事件。第二版可考虑 accessCount 仅内存维护、不写 event（但分支切换后热度会丢失——取舍选择：分支隔离 > JSONL 大小）。

### 2. 分支 fork 后记忆分叉

从非 root 节点 fork 时，记忆状态 fork 点之前的 memory 事件共享，fork 点之后各自独立演化。这是符合直觉的行为，但用户可能预期 "fork = 完整复制当前状态"——实际上 fork 只 copy 祖先路径上的事件。如果 fork 后在 A 分支 set 新记忆再 fork 到 B，B 看不到 A 分支的 set。**这实际上是正确行为**，但需文档说明。

### 3. 并发 session 写冲突

两个进程（CLI + Pi-Web）同时打开同一 session 写入 memory 事件时，JSONL 使用 `appendFileSync`，可能出现交错行或丢失。**缓解**：这是 JSONL session 的已知限制，非 memory 模块独有。核心 agent 已有 append-only 设计但无跨进程锁。建议用户文档明确勿同时编辑同一 session。

### 4. Compaction 吞噬 memory 事件

如果 compaction 裁剪了包含 memory `custom` 条目的分支片段，后续 `getBranch()` 遍历不到这些事件，记忆丢失。**缓解**：与 compaction 设计对齐——compaction 的 branch summary 节点下会挂载 `CustomEntry` 的摘要。当前 compaction 系统仅处理 `message` 条目——需要确认是否保留 `custom` 条目在 compaction 后的路径上。如果 compaction 丢弃 custom 条目，memory 需要监听 `session_before_compact` 事件，将当前 memory 状态写入一个 snapshot entry 作为 compaction 的保留锚点。

### 5. Pi-Web extension 生命周期差异

Pi-Web 可能使用不同的 session 初始化顺序或 extension 加载时序。如果 `context` 事件在 Pi-Web 中触发时机不同（例如首次加载时 messages 数组为空），memory index 注入可能失败或产生异常。**缓解**：在 `context` handler 中做防御性检查——如果 `messages` 数组为空或首条非 system message，跳过注入并在 `session_start` 时 log warning。同时在 Pi-Web 集成测试中覆盖该路径。

### 6. 大型 value 的 JSONL 可读性

`memory_set` 的 `patch.value` 直接写入 JSONL，value 可能包含多行文本、特殊字符等。JSONL 本身每行一条 JSON——大段多行 value 会破坏人类可读性。**缓解**：在第一版中接受这个 tradeoff；JSONL 是机器读写格式。如果成为实际问题，可改为 base64 编码 value 或压缩存储。

### 7. 超长 session 的重建性能

每次 `session_start` 全量扫描 `getBranch()` 重建 state，对于深度 > 1000 条 entry 的 session 可能耗时。**缓解**：`getBranch()` 是 O(depth) 操作——分支深度，非 session 总 entry 数。深度通常 < 200（每次用户交互约 3-5 条 entry）。500 条深度仍 < 1ms。此风险低，但需 benchmark 验证上限。

### 8. 冲突合并依赖模型判断

当同 key 新旧 value 差异显著时，系统返回冲突提示让模型决定 `replace/append/delete_old`。模型可能忽略提示、错误选择，或陷入循环。**缓解**：冲突提示需要高度结构化（明确的 option 列表），memory_set 工具接受 `action` 参数作为冲突解决指令。如果模型连续 3 次对同一 key 产生冲突，自动降级为 replace（最新值胜出）。

---

## 十四、测试计划

### 单元测试

| 测试项 | 描述 |
|--------|------|
| 状态日志重建 | 给定一组 MemoryEvent，验证 rebuild 后的 Map 正确 |
| 分支切换隔离 | 在分支 A set key，切换到分支 B，验证 B 看不到 A 的 key |
| set/get/search/delete | 基本 CRUD 操作 |
| 热度排序 | 验证 accessCount + recency 排序正确 |
| 无效 key/category 拒绝 | 空 key、非法字符、无效 category 等 |
| 合并策略 | 覆盖、冲突检测、append 模式 |
| 敏感 key 写入拒绝 | api_key、token 等黑名单 pattern |
| Compaction 中的 memory survival | 验证 compaction 后 memory 事件可重建 |

### 回归测试

| 测试项 | 描述 |
|--------|------|
| session 重载后 memory 仍存在 | `session_start(reload)` 触发 rebuild，验证记忆完整 |
| memory_get/search 后 accessCount 可恢复 | access 事件写入 → 重载 → 验证 accessCount 不变 |

### 交互测试

```bash
# 载入 extension
./pi-test.sh --extension ~/.pi/agent/extensions/memory.ts

# 验证工具可见
/list-tools | grep memory

# 验证 /memory 命令
/memory list

# 端到端流程
# 1. set memory
# 2. 新 session get 是否恢复
# 3. /memory list 可见
```

### CI

```bash
npm run check    # 类型检查 + lint
```

---

## 十五、默认假设

- **第一版 session-local**：不做跨项目全局文件记忆（`~/.pi/agent/memories.json`）
- **第一版无向量检索**：关键词 substring search 覆盖 < 100 条记忆
- **不改 packages/agent**：所有代码落在 `packages/coding-agent` extension 体系
- **单一 .ts 文件扩展**：安装方式为 `~/.pi/agent/extensions/memory.ts`

---

## 十六、未来扩展

| 方向 | 触发条件 | 方案 |
|------|---------|------|
| **向量检索** | 记忆 > 500 条时 substring 精度下降 | 引入 `sqlite-vec` 或本地 ONNX embedding 模型 |
| **自动记忆提取** | 用户不想手动 "remember" | `agent_end` 事件 + LLM 提取本轮决策/事实 |
| **记忆过期 TTL** | 长期未访问的记忆占用 slot | 基于 `lastAccessed` 的 TTL（默认 90 天无访问自动清理） |
| **跨项目全局记忆** | 用户在多个项目间共享偏好 | 文件持久化 + 项目级别 namespace |
| **access 事件合并** | JSONL 中大量 access 冗余 | Compaction 扩展合并连续 access 事件为 accessCount=sum |
| **Pi-Web 专用集成路径** | Pi-Web extension 生命周期差异 | 提供备用初始化钩子或适配层 |
