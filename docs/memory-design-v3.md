# Pi Memory Module 技术方案 v3

> 吸收主流开源记忆系统架构，保留「索引预览 + 按需工具检索 + 会话分支隔离」核心路线，
> 以最低 token 成本、最小代码量、零外部依赖实现 Pi CLI / Pi-Web 共用的 coding agent 记忆。

---

## 一、开源系统架构吸收与取舍

| 系统 | 吸收 | 拒绝 | 理由 |
|------|------|------|------|
| **Mem0** | 分层记忆；同一 key 更新不新增 | 向量 DB；每次 add 调 LLM 做 dedup（500-2000 tokens/写） | Pi 不用向量、不额外消耗 LLM token |
| **Letta/MemGPT** | 冷热分页思想；固定大小记忆块 | Heartbeat 自动调页；Recall/Archival 双轨检索 | Pi session 已由 compaction 负责冷层；Heartbeat 增加延迟 |
| **Zep** | 事实/决定分离（即 Pi 的 category）；重要性评分 | Postgres + pgvector + async pipeline；知识图谱 | 基础设施过重；Pi 是本地 agent |
| **LangChain** | 多后端可插拔概念 | 全量 Buffer / 各种 Summary 变体 | Pi 有 compaction，无需重复 |
| **CrewAI** | Entity 类型化（Pi 的 category 已做） | Multi-agent 记忆协调 | Pi 是 single-agent |
| **AutoGen** | Teachability 模式 | 代理给 Mem0 做存储 | Pi 自己管理存储，更轻 |
| **Cognee** | Key 层级命名空间 (e.g. `db.preference`) | Neo4j 知识图谱 + pipeline | 编码场景不需要图谱关系 |
| **Khoj** | 本地离线优先 | 多模态文件索引 | Pi 聚焦结构化事实记忆 |
| **Claude Code / Codex CLI** | **工具驱动检索**；单一文件扩展 | 不注入 memory index（claude code） | 这正是 Pi 的差异化优势：index 注入让模型知道存了什么 |

**核心结论**：开源系统主要差异在检索层（向量 vs 关键词）和持久层（SQLite vs Postgres vs 文件）。Pi 的最优解已经确定：JSONL session 持久化 + 关键词匹配 + context event 索引注入。无需引入任何新范式，只需要在细节上做对。

---

## 二、最小架构

```
  每次 LLM 调用:
  ┌──────────┐   context event 注入    ┌─────────────────────┐
  │ Extension │ ──────────────────→   │ LLM sees:           │
  │ runtime   │  messages[0] =        │ <memory_index>       │
  │           │  system prompt        │ 8 hot keys + preview │
  │  memory   │  messages[1] =        │ </memory_index>      │
  │  store    │  memory index (new)   │ ...user & asst msgs  │
  │ (Map)     │  messages[2..] =      │                      │
  │           │  original messages    │ Model calls:         │
  │           │                       │ memory_get("key")    │
  └──────────┘                       └─────────────────────┘
       ↑
       │ 重建                   │  持久化
       │ session_start/         │
       │ session_tree 扫描      │  appendEntry("memory", {op, key, ...})
       │ getBranch() 中的       │
       │ CustomEntry("memory")  │
       │                        ↓
       │                JSONL Session File
       │                ~/.pi/agent/sessions/<hash>.jsonl
```

**三个组件，零外部依赖：**

1. **Memory Store** — `Map<string, MemoryEntry>`，纯内存。仅提供 `set/get/search/delete/list`。
2. **Event Logger** — 写操作调用 `pi.appendEntry("memory", {...})` 落盘一条轻量事件。
3. **Context Injector** — `pi.on("context")` 每次 LLM 调用前向 `messages` 前部插入 memory index。

---

## 三、数据结构（精简）

```typescript
type MemoryCategory = "fact" | "decision" | "preference" | "context";

interface MemoryEntry {
  key: string;            // snake_case, ≤64 chars, /^[a-z][a-z0-9_]*$/
  value: string;          // 实际内容，≤500 chars 建议，超限软警告不截断
  category: MemoryCategory;
  updatedAt: number;      // 最近一次 set 的时间戳 (ms)
  accessCount: number;    // 本 session 内访问次数（重载/切分支后归零）
}

// appendEntry 事件格式
interface MemoryEvent {
  op: "set" | "delete";
  key: string;
  value?: string;         // 仅 set
  category?: MemoryCategory; // 仅 set
  timestamp: number;      // ms
}
```

**v2 → v3 简化点：**

- 去除 `id`、`createdAt`、`lastAccessed` — 未用于任何功能
- `accessCount` 仅在内存维护，不写 access 事件 — 消除 JSONL 膨胀
- 事件只有 `set` 和 `delete` 两种 op — 写入量减至最小

---

## 四、Token 预算详解

### 4.1 索引格式（最小化）

```
[memory:15]
P preferred_pm: pnpm
D auth_strategy: JWT + refresh tokens, 15min
F staging_url: https://staging-api.example.com
P test_framework: Vitest
D db_indexing: partial indexes for soft-delete
C ci_provider: GitHub Actions
F api_version: v3, deprecating v2 by 2026Q3
P code_style: arrow functions, no semicolons
```

- 去掉 XML 标签、重复的 `` ` `` 和 `- [ ]` 列表标记
- Category 缩写为单字母：`F/D/P/C`
- Preview 限制 60 字符，超出截断加 `...`
- 仅一行 header 说明总数

**Token 对比：**

| 格式 | 8 条目 | 50 条目（仅 8 hot） | 100 条目（仅 8 hot） |
|------|--------|---------------------|----------------------|
| v1 XML `<memory>` | ~300 | ~300 | ~300 |
| v2 XML `<memory>` | ~250 | ~250 | ~250 |
| **v3 紧凑格式** | **~120** | **~120** | **~120** |

**120 tokens** = 每次 LLM 调用的固定开销。不会随记忆数量增长。

### 4.2 工具调用 Token 预算

| 操作 | Tokens |
|------|--------|
| `memory_set` 工具定义 + 参数 schema | 不含在每轮（工具定义随 system prompt 固定） |
| `memory_set` 调用返回 | ~30 ("Saved: [fact] staging_url") |
| `memory_get` 调用返回（单条 full value） | ~150（包含工具定义、调用、结果文本） |
| `memory_search` 调用返回（最多 5 条） | ~400（含工具定义、调用、5 条完整结果） |

### 4.3 典型场景 Token 总量

| 场景 | 开销 |
|------|------|
| 普通问答（不需要记忆） | **120** — 仅 index |
| 模型从记忆取 1 条 | **270** — index + 1 get |
| 模型从记忆取 3 条 | **570** — index + 3 gets |
| 模型搜索记忆 | **520** — index + 1 search |

对比全量注入方案（50 条记忆 ≈ 5000 tokens/轮），节省 **90-97%**。

---

## 五、核心机制

### 5.1 合并策略：永远覆盖

v2 的冲突感知合并（检测新旧 value 差异、返回提示让模型选择 replace/append/delete）增加了：
- 工具参数复杂度（`action` 字段）
- 模型决策负担（需要额外回复选择）
- 实现复杂度（Jaro-Winkler 比较、冲突分支处理）

**v3 简化：同 key set 直接覆盖。** 理由：
1. 用户说 "remember: prefer Vitest" → 模型设 `test_framework: Vitest`
2. 用户说 "actually use Jest now" → 模型设 `test_framework: Jest`
3. 覆盖 = 正确行为。保留旧值永远是错的。
4. 如果真的需要 append（罕见），模型会先 `memory_get` 再拼上新值整体 `memory_set`。

### 5.2 排序算法：衰减 + 频次

```typescript
function sortForIndex(entries: MemoryEntry[]): MemoryEntry[] {
  const now = Date.now();
  const HOUR = 3600000;
  return [...entries]
    .sort((a, b) => {
      const aRecency = Math.exp(-(now - a.updatedAt) / (24 * HOUR));
      const bRecency = Math.exp(-(now - b.updatedAt) / (24 * HOUR));
      const aScore = a.accessCount * 10 + aRecency * 30;
      const bScore = b.accessCount * 10 + bRecency * 30;
      return bScore - aScore;
    })
    .slice(0, MAX_HOT_KEYS);
}
```

- `exp(-age/24h)`：1 小时内 ≈ 0.96，24h ≈ 0.37，7d ≈ 0.001 — 快速衰减
- `accessCount * 10`：本轮高频记忆自然靠前
- `recentUpdate * 30`：最近更新的加权，但不压倒高频
- 所有项单调递减（越旧分越低）
- 取 top 8 注入 index

### 5.3 状态重建：事件扫描

```typescript
function rebuildStore(entries: SessionEntry[]): Map<string, MemoryEntry> {
  const store = new Map<string, MemoryEntry>();
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== "memory") continue;
    const event = entry.data as MemoryEvent;
    if (event.op === "set") {
      store.set(event.key, {
        key: event.key,
        value: event.value!,
        category: event.category!,
        updatedAt: event.timestamp,
        accessCount: 0,
      });
    } else if (event.op === "delete") {
      store.delete(event.key);
    }
  }
  return store;
}
```

- 只扫描当前分支（`getBranch()` 返回的路径），天然分支隔离
- 只有 `set`/`delete` 事件，无 `access` 事件
- `accessCount` 从 0 开始（重载后重置，可接受）
- O(branch_depth) 扫描，通常 < 50 条 entry，< 1ms

### 5.4 安全边界

| 层级 | 规则 |
|------|------|
| **写入拒绝** | key 命中 `/api[_-]?key\|token\|secret\|password\|passwd\|credential\|private[_-]?key\|auth[_-]?token/i` 时直接拒绝，返回错误文本 |
| **索引脱敏** | 命中敏感 key 的 preview 显示 `[redacted]` |
| **不去重敏感 value** | 如果 key 是 `staging_url`（合法）但 value 里包含 `?token=abc123`，不做检测 — 这是模型调用者的责任；工具描述中写明 "do not store credentials" |
| **用户全量可见** | `/memory list` 显示完整 value（不脱敏），用户对自己的 session 数据有完全可见权 |
| **session 内限定** | 不做跨 session 全局文件记忆（不做 `~/.pi/agent/memories.json`） |

---

## 六、工具 API 定义

### 6.1 memory_set

```
参数: key (string), value (string), category? (string: "fact"|"decision"|"preference"|"context")
校验: key 非空且符合 snake_case 规则；value 非空；category 为枚举值之一
      key 命中敏感模式 → 拒绝
行为: store.set(key, newEntry)
      pi.appendEntry("memory", { op: "set", key, value, category, timestamp })
返回: "Saved: [category] key" 或 "Updated: [category] key"
```

### 6.2 memory_get

```
参数: key (string)
行为: store.get(key) → accessCount++
返回: "[category] key:\nvalue" 或 "No memory found: key\nAvailable: key1, key2, ..."
```

### 6.3 memory_search

```
参数: query (string)
行为: 大小写不敏感 substring 匹配 key + value
      匹配结果按 sortForIndex 排序，取前 5
      对结果 accessCount++
返回: 匹配的 key-value 列表，最多 5 条
      空 query 或 "*" 返回前 5 条最热记忆
```

### 6.4 memory_list

```
参数: category? (string, 可选)
行为: 列出所有记忆（分类过滤），每条 key + 80 chars preview
返回: 列表文本
```

### 6.5 memory_delete

```
参数: key (string)
行为: store.delete(key)
      pi.appendEntry("memory", { op: "delete", key, timestamp })
返回: "Deleted: key" 或 "No memory found: key"
```

---

## 七、Pi-Web 集成

### 共享路径

Pi CLI 和 Pi-Web 共享 `$PI_CODING_AGENT_DIR/sessions/` 下的 JSONL 文件。同一 session 文件中的 `CustomEntry(type:"custom", customType:"memory")` 对两端读写均可见。

### 前提条件

| 条件 | 说明 |
|------|------|
| Extension 文件路径一致 | 两端 `~/.pi/agent/extensions/memory.ts` 指向同一文件 |
| Pi-Web 加载该 extension | 需要在 Pi-Web 的 extension 加载路径中注册，或显式 `--extension` 配置 |
| 同一 session 文件 | 打开同一项目目录 → 自动匹配同一 session |
| 事件链一致 | `session_start` → rebuild store；`context` → inject index。这些是 coding-agent 核心事件，Pi-Web 通过 `createAgentSession()` 走相同事件总线 |

### 不成立时不工作

如果 Pi-Web 的 extension 发现路径与 CLI 不同，或 Pi-Web 使用不同的 session 初始化顺序导致 `context` 事件不触发，memory index 不会注入。此时 memory tools 仍可通过 JSONL 获得持久化，但模型不会在 context 中看到 index。

### 验证清单

1. CLI session 中 `memory_set("foo", "bar")` → 检查 JSONL 中是否有 `CustomEntry("memory")`
2. 在 Pi-Web 中打开同一 session → 检查 `/memory list` 是否显示 "foo"
3. 在 Pi-Web 中发送 "what is foo?" → 模型是否调用了 `memory_get("foo")` 且返回 "bar"
4. 如果模型未调用 → index 未注入 → 检查 Pi-Web extension 日志

---

## 八、隐藏风险（v3 更新）

### 1. accessCount 归零

重载 session 或切换分支后 `accessCount` 全部归零。首轮排序完全依赖 `updatedAt` recency。这在实践中可接受——session 重启后的第一轮交互会自然重建访问热度。

**注意**：如果频繁重载 session（如 `/reload` 每次 prompt 后），热点记忆的排序会抖动。罕见场景。

### 2. JSONL 中无 access 事件

accessCount 不持久化 = 跨 session 热度丢失。如果用户期望 "我上周反复查的 key 今天应该还是 top request"，v3 不满足。缓解：如需此行为，可添加「定期 snapshot」——每小时/每 10 次 set 写一条 snapshot entry 带 accessCount。v1 阶段不做。

### 3. 覆盖 vs 事故删除

模型错误地 `memory_set("important_key", "")` 会覆盖一条重要记忆。因为没有 "are you sure?" 确认。缓解：value 非空校验拒绝空字符串；如果模型用单字覆盖，此为模型调用者责任。

### 4. Compaction 丢弃 custom entry

Compaction 可能裁剪包含 `CustomEntry("memory")` 的历史片段。如果 compaction 的 branch summary 不保留 custom entries，则重建 scan 不到这些事件。**需确认**：compaction 的 `session_before_compact` 事件中 `branchEntries` 是否包含 `custom` 类型条目，以及 compaction 产物是否保留它们。如果否，memory 需在 compaction 前写入完整快照 entry。

### 5. 并发读写冲突（CLI + Pi-Web）

两个进程同时写同一 session JSONL → `appendFileSync` 可能交错。这是 JSONL session 架构的已知限制，非 memory 独有。建议用户文档明确写明不要两个进程同时使用同一 session。

### 6. 大型 value 的 JSONL 行

`memory_set` 写入 500 字符 value → JSONL 行 ≈ 600 字符。人类可读性差但机器可读性不受影响。如果日后 value 增大到 2000+ 字符，可改用 Base64 或 gzip。

### 7. 敏感词黑名单旁路

sensitive key 黑名单是正则匹配，可通过变体绕过（`my_private_key` → `my_priv_key`、`my_privatekey`）。这属于 known weakness——黑名单永远不可靠。v1 接受此风险，v2 可加 LLM 辅助检测。

### 8. 超长 session 重建

500+ branch entries 全量扫描重建 < 1ms。极端场景（10,000+ entries 的巨型 session）可能 < 5ms。风险极低但需 benchmark 确认。

---

## 九、测试计划

### 单元测试（`test/suite/regressions/`）

| 测试 | 验证点 |
|------|--------|
| rebuild from events | `[{op:"set",key:"a",value:"1"}, {op:"set",key:"a",value:"2"}, {op:"delete",key:"a"}]` → store 为空 |
| branch isolation | 分支 A set key X，切换分支 B，B 看不到 X |
| set/get/search/delete | 基本 CRUD |
| hot sort order | accessCount 高 + 最近更新 → 排前面；旧记忆 → 排后面 |
| invalid key reject | `""`, `"UPPERCASE"`, `"1starts-with-number"`, `"too__many_underscores"` → 全部拒绝 |
| invalid category reject | `"unknown"`, `""`, `"FACT"` → 拒绝 |
| sensitive key reject | `"api_key"`, `"auth_token"`, `"password"` → 拒绝并返回安全提示 |
| empty value reject | `""` → 拒绝 |
| overwrite | set key A twice → 取最新值 |
| memory_list category filter | category="fact" 只返回 fact 条目 |

### 交互测试（tmux）

```bash
# Extension 加载
tmux ... "./pi-test.sh --extension /path/to/memory.ts"
# 验证工具注册
/list-tools | grep memory
# 端到端: set → reload → get → /memory list
```

### CI

```bash
npm run check    # typecheck + lint (no tests run)
./test.sh        # non-e2e tests
```

---

## 十、与 v1/v2 的设计差异总结

| 维度 | v1 | v2 | v3 |
|------|----|----|-----|
| Token 预算（每轮） | ~250 | ~250 | **~120** |
| 注入事件 | `before_system_prompt` (不存在) | `context` + 修改 messages | `context` + 修改 messages |
| 持久化 | tool result `details` 全量快照 | `appendEntry("memory", ...)` 事件日志 (含 access) | `appendEntry("memory", ...)` 事件日志 (**无 access**) |
| 合并策略 | 更长值优先 | 冲突感知 + 模型选择 | **永远覆盖** |
| 热度排序 | `accessCount*10 + elapsedDays` (反了) | `accessCount*10 + decay*30 + decay*20` | `accessCount*10 + expDecay*30` |
| 数据校验 | 无 | key/category/value 校验 + 敏感 key 黑名单 | 同 v2，更严 |
| accessCount 持久化 | 不恢复 | 通过 access 事件恢复 | **不持久化**（接受归零） |
| Pi-Web | "无需代码变更" | 明确前提条件 | 明确前提条件 + 验证清单 |
| 代码复杂度 | 简单 | 中等（冲突检测、access logging） | **简单**（覆盖、无 access 日志） |

---

## 十一、未来扩展（v2+）

| 方向 | 触发条件 | 方案 |
|------|---------|------|
| 向量检索 | 记忆 > 500 条 | `sqlite-vec` 或本地 ONNX embedding |
| 自动提取 | 使用频率高 | `agent_end` 事件 + LLM 提取本轮决策 |
| accessCount 持久化 | 用户投诉热度丢失 | 定期 snapshot entry 写入当前 accessCount |
| 跨项目全局记忆 | 多项目共享偏好 | `~/.pi/agent/memories.json` + 项目 namespace |
| 记忆过期 TTL | 旧记忆占用 slot | 90 天无 set 自动标记 stale |
| compaction 锚点 | compaction 丢弃 custom entry | `session_before_compact` 写 memory snapshot |
| LLM 辅助安全检测 | 敏感词绕过黑名单 | tool 参数先过 LLM 快速检查（警告级，不阻断） |
