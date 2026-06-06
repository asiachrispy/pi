# Pi Memory Module 设计文档

## 一、现状分析

### 1.1 Pi 生态无记忆模块

| 检查范围 | 结果 |
|----------|------|
| `pi` CLI (`packages/coding-agent`) | ❌ 无 |
| `pi-agent-core` (`packages/agent`) | ❌ 无 — `memory-repo.ts` 只是 `InMemorySessionRepo`（无磁盘会话） |
| `pi-ai` (`packages/ai`) | ❌ 无 |
| `pi-web` (`app/`, `components/`, `lib/`) | ❌ 无 |
| `pi` examples | ❌ 无 — 最近似的 `todo.ts` 仅演示状态管理模式 |

### 1.2 已有可复用的基础设施

| 组件 | 作用 | 复用于记忆 |
|------|------|-----------|
| Extension API (`pi.registerTool`) | 注册 LLM 可调用的工具 | 注册 `memory_set/get/search/delete` |
| Extension 事件 (`pi.on("session_start")`) | 会话生命周期钩子 | 从 JSONL 重建记忆状态 |
| `ctx.sessionManager.getBranch()` | 遍历当前分支所有 entries | 扫描 `toolResult` 重建状态（分支安全） |
| `toolResult.details` | 工具结果的持久化元数据 | 存储完整记忆快照 |
| JSONL 树形会话 | 文件即数据库 | 记忆随分支自动隔离 |
| Compaction 系统 | 旧对话自动摘要 | 冷层记忆（不重复实现） |
| System Prompt 注入 (`before_system_prompt`) | 添加到 System Prompt | 注入记忆索引 |

---

## 二、竞品记忆方案分析

| 项目 | 核心机制 | Token 效率 | 精确度 | 可借鉴点 |
|------|---------|-----------|--------|---------|
| **Codex (OpenAI)** | 自动摘要 + `memory` 工具按需检索 | ⭐⭐⭐ 只注入 key 级别 | ⭐⭐⭐ 工具精确获取 | **工具驱动检索** — LLM 主动调用工具获取完整值 |
| **Hermes / LobeChat** | 向量嵌入 + 语义搜索 Top-K | ⭐⭐ 全量注入 top-K 结果 | ⭐⭐⭐ 向量匹配 | **分区索引** — 按项目/主题分桶 |
| **Mem0** | 分层记忆（用户/会话/实体）+ 去重合并 + 演化 | ⭐⭐⭐⭐ 分层裁剪 | ⭐⭐⭐⭐ 演化记忆 | **分层架构 + 去重合并** — 同 key 更新而非新增 |
| **MemGPT / Letta** | OS 风格分页 + 工作记忆/归档记忆 | ⭐⭐⭐⭐ 分页加载 | ⭐⭐⭐ 按需换页 | **冷热分层** — 热索引载入，冷数据按需读取 |
| **Zep** | 事实提取 + 摘要 + 向量检索 | ⭐⭐⭐ 混合检索 | ⭐⭐⭐ 结构化事实 | **事实 vs 对话** — 区分可记忆事实与普通对话 |

### 核心洞察

Token 效率最高的方案都是 **"索引预览 + 按需检索"** 模式：

```
System Prompt 中只放记忆的「目录索引」（key + 一句话 hint）
→ LLM 看到索引，知道存在哪些记忆
→ 需要完整值的时候，调用 memory_get(key) 工具获取
→ 不需要时零额外 Token 消耗
```

**反面案例**：把所有记忆全文塞进 System Prompt → 50 条记忆 ≈ 5000 tokens/轮，极不经济。

---

## 三、设计方案：三温层记忆架构

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Architecture                          │
│                                                                 │
│  ┌──────────────┐  Token Cost: ~150-300 tokens                  │
│  │  HOT LAYER    │  System Prompt 中的记忆索引（只放 key + hint） │
│  │  (索引层)     │  "preferred_db → PostgreSQL"                  │
│  │              │  "auth_decision → JWT + refresh tokens"       │
│  │              │  排序：访问频次 > 最近使用 > 创建时间             │
│  └──────┬───────┘                                              │
│         │ LLM 需要时调用 memory_get(key)                          │
│  ┌──────▼───────┐  Token Cost: 按需取 1-3 条                    │
│  │  WARM LAYER   │  工具调用的完整值（存在 toolResult.details）    │
│  │  (值存储层)   │  "PostgreSQL 16, prefer JSONB over hstore"    │
│  │              │  去重：同 key 自动合并                         │
│  └──────┬───────┘                                              │
│         │  LLM 需要探索时调用 memory_search(query)                │
│  ┌──────▼───────┐  Token Cost: 0（不在上下文）                    │
│  │  COLD LAYER   │  压缩层：旧对话摘要（复用 pi 已有 compaction）  │
│  │  (归档层)     │  /compact 产生的 summary entry                │
│  │              │  不需要额外实现                                 │
│  └──────────────┘                                              │
└─────────────────────────────────────────────────────────────────┘
```

### Token 效率量化对比

| 方案 | 每轮 Memory Token | 10 条记忆 | 50 条记忆 | 100 条记忆 |
|------|---------------------|-----------|-----------|-----------|
| 全量注入（naive） | 500-5000 | 500 | 5000 | 10000 |
| 向量检索 Top-5 | 300-800 | 300 | 400 | 400 |
| **三温层（本方案）** | **150-300** | **150** | **300** | **300** |

三温层方案的 Token 消耗几乎不随记忆数量增长——因为索引层固定只显示前 8 条最热记忆。

---

## 四、数据结构

```typescript
type MemoryCategory = "fact" | "decision" | "preference" | "context";

interface MemoryEntry {
  id: number;           // 自增 ID
  key: string;          // 记忆键（snake_case，如 preferred_db）
  value: string;        // 完整记忆内容（≤ 500 字符）
  category: MemoryCategory;
  createdAt: number;    // 创建时间戳
  updatedAt: number;    // 更新时间戳
  accessCount: number;  // 访问计数（决定热层排序）
  lastAccessed?: number; // 最后访问时间（LRU 淘汰用）
}
```

### Category 语义

| Category | 含义 | 示例 |
|----------|------|------|
| `fact` | 客观信息 | `staging_url: https://api.staging.example.com` |
| `decision` | 设计/技术决策 | `auth_strategy: JWT with refresh tokens, 15min expiry` |
| `preference` | 用户偏好 | `test_framework: Vitest (migrated from Jest 2025Q1)` |
| `context` | 环境细节 | `ci_provider: GitHub Actions, deploy on push to main` |

---

## 五、工具设计

### 5.1 memory_set — 写入记忆

```
输入: key, value, category?
行为: 同 key 自动合并更新（去重），不同 key 新增
输出: "Saved: [category] key"
内部: 更新 accessCount，持久化到 toolResult.details
```

**去重策略**（参考 Mem0）：同 key 写入时，检查新旧 value 是否可合并：
- 新 value 包含旧 value 的全部信息 → 替换为新值
- 旧 value 更长 → 保留旧值但追加新信息
- 不同 category → 更新为新 category

### 5.2 memory_get — 精确获取

```
输入: key
行为: 查找精确 key 匹配的记忆，accessCount++
输出: 完整 value（或 "No memory found: key" + available keys 列表）
Token 消耗: ~120 tokens/次（仅返回 1 条完整记忆）
```

### 5.3 memory_search — 模糊搜索

```
输入: query
行为: 对 key 和 value 做大小写不敏感的 substring 匹配
输出: 最多 5 条结果（控制 Token）
Token 消耗: ~350 tokens/次（最多 5 条结果）
```

> **为什么不用向量搜索？**
> - Pi 无 embedding 基础设施，引入向量存储会大幅增加复杂度
> - 编程场景下记忆通常 < 100 条，关键词匹配精度已足够
> - 避免引入 Chroma/Pinecone/PgVector 等外部依赖
> - 未来可选项：如果记忆 > 500 条，再考虑加向量检索

### 5.4 memory_list — 摘要列表

```
输入: 无
行为: 列出所有记忆，每条只显示 key + 80 字符 preview
输出: 摘要文本
```

### 5.5 memory_delete — 删除记忆

```
输入: key
行为: 精确删除
输出: "Deleted: key" 或 "No memory found: key"
```

---

## 六、Session 集成（分支安全）

### 6.1 存储原理

记忆状态**不存磁盘文件**，而是嵌入 JSONL Session 的 toolResult details 中：

```jsonl
{"type":"message","id":"m1","parentId":"root","role":"user","content":"Remember: prefer pnpm"}
{"type":"message","id":"m2","parentId":"m1","role":"toolResult","toolName":"memory_set","details":{"action":"set","memories":[{"id":1,"key":"preferred_pm","value":"pnpm","category":"preference","accessCount":1,...}],"nextId":2}}
```

### 6.2 分支隔离

```
分支 A: user → memory_set(preferred_db=PostgreSQL) → assistant
分支 B: user → memory_set(preferred_db=MySQL)       → assistant (从同一节点分叉)
         ↑
    两个分支的 memory 工具调用在不同路径上
    reconstructFromSession() 扫描各自分支 → 各自重建独立的 memories[]
```

### 6.3 状态重建

```typescript
// session_start 或 session_tree 事件触发
const reconstructFromSession = (ctx) => {
  memories = [];
  nextId = 1;
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message") continue;
    const msg = entry.message;
    // 只扫描 memory_set 和 memory_delete 的结果
    if (msg.role !== "toolResult") continue;
    if (msg.toolName !== "memory_set" && msg.toolName !== "memory_delete") continue;
    const details = msg.details as MemoryDetails;
    if (details) {
      memories = details.memories;  // 完整快照
      nextId = details.nextId;
    }
  }
};
```

---

## 七、System Prompt 注入设计

### 7.1 注入时机

通过 `before_system_prompt` 事件注入，在每次 LLM 调用前动态生成。

### 7.2 注入内容（Token 高效版）

只注入热层索引，不含完整值：

```xml
<memory>
You have access to persistent memory.
Current index (15 total memories, showing top 8):

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

**约 250 tokens**，包含 8 条记忆的关键信息，足够 LLM 判断是否需要深入查询。

### 7.3 热层排序算法

```
score = accessCount * 10 + recency(updatedAt) * 2 + recency(createdAt)
取 score 最高的 8 条（MAX_HOT_KEYS = 8）
```

---

## 八、安装与使用

### 8.1 单文件安装

```bash
cp memory.ts ~/.pi/agent/extensions/memory.ts
```

### 8.2 启用

```bash
pi --extension ~/.pi/agent/extensions/memory.ts
```

或在 `~/.pi/agent/extensions/` 目录下放置后自动发现（`/reload` 热加载）。

### 8.3 使用示例

```
User: "Remember: our staging API is https://staging-api.example.com, auth is Bearer token from 1Password"
Agent: [calls memory_set("staging_api", "...", "fact")]

User: "Remember: prefer Vitest over Jest for testing"
Agent: [calls memory_set("test_framework", "Vitest", "preference")]

User: "What's our staging API URL?"
Agent: [calls memory_get("staging_api")]
Agent: "Your staging API is at https://staging-api.example.com"

User: "List all decisions we've made"
Agent: [calls memory_search("")]
Agent: "Here are your stored memories..."

User: "Forget the staging URL, we changed it"
Agent: [calls memory_delete("staging_api")]
```

### 8.4 命令

```
/memory   — 查看所有记忆
```

---

## 九、与 Pi-Web 的集成

Pi-Web 通过共享同一个 JSONL Session 文件自动获得记忆能力：

```
CLI session:  ~/.pi/agent/sessions/--path--/xxx.jsonl
                    ↑ 同一文件
Pi-Web session:  ~/.pi/agent/sessions/--path--/xxx.jsonl

→ CLI 写入的 memory_set toolResult 自动对 Pi-Web 可见
→ Pi-Web 的 session_start 事件也会触发 reconstructFromSession()
```

无需任何 Pi-Web 代码变更。

---

## 十、未来扩展

| 方向 | 触发条件 | 方案 |
|------|---------|------|
| **向量检索** | 记忆 > 500 条时关键词搜索精度下降 | 引入轻量向量存储（如 SQLite + sqlite-vec） |
| **自动记忆提取** | 用户不想手动说 "remember" | `agent_end` 事件 + LLM 自动提取本轮关键决策 |
| **记忆过期** | 长期不用的记忆 | 基于 `lastAccessed` 的 TTL 淘汰 |
| **跨项目共享** | 用户级全局记忆 | 文件持久化 `~/.pi/agent/memories.json` |
| **Pi Package 发布** | 分享给社区 | `pi install npm:@user/pi-memory` |
| **冲突检测** | 同一 key 被设为矛盾的值 | LLM 辅助的语义去重 |

---

## 附录：完整源码

```typescript
// ~/.pi/agent/extensions/memory.ts
// Version: 1.0.0
// License: MIT
//
// 三温层记忆系统 for Pi Coding Agent
// - Hot: System Prompt 索引层（~200 tokens）
// - Warm: toolResult.details 值存储（按需获取）
// - Cold: Pi Compaction 归档（复用已有基础设施）

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// ============================================================
// Types
// ============================================================

type MemoryCategory = "fact" | "decision" | "preference" | "context";

interface MemoryEntry {
  id: number;
  key: string;
  value: string;
  category: MemoryCategory;
  createdAt: number;
  updatedAt: number;
  accessCount: number;
  lastAccessed?: number;
}

interface MemoryDetails {
  action: string;
  memories: MemoryEntry[];
  nextId: number;
  summary?: string;
}

// ============================================================
// Constants
// ============================================================

const MAX_HOT_KEYS = 8;
const MAX_VALUE_LENGTH = 500;
const MAX_SEARCH_RESULTS = 5;
const HOT_KEY_PREVIEW_LENGTH = 60;

// ============================================================
// System Prompt Builder (Token Efficient)
// ============================================================

function buildMemoryPrompt(memories: MemoryEntry[]): string {
  if (memories.length === 0) return "";

  const hotEntries = [...memories]
    .sort((a, b) => {
      const scoreA = a.accessCount * 10 + (Date.now() - a.updatedAt) / 86400000;
      const scoreB = b.accessCount * 10 + (Date.now() - b.updatedAt) / 86400000;
      return scoreB - scoreA;
    })
    .slice(0, MAX_HOT_KEYS);

  const hint = hotEntries
    .map((m) => {
      const categoryChar = m.category[0].toUpperCase();
      const preview =
        m.value.length > HOT_KEY_PREVIEW_LENGTH
          ? m.value.slice(0, HOT_KEY_PREVIEW_LENGTH) + "..."
          : m.value;
      return `- [${categoryChar}] \`${m.key}\`: ${preview}`;
    })
    .join("\n");

  return `<memory>
You have access to persistent memory across sessions. Current index (${memories.length} total, showing ${hotEntries.length}):

${hint}

To retrieve full details, call \`memory_get\` with the key.
To find memories, call \`memory_search\` with a query.
To save info, call \`memory_set\` with key, value, and category.
Categories: F(act) - objective information, D(ecision) - design/tech choices, P(reference) - user preferences, C(ontext) - environment details.
</memory>`;
}

// ============================================================
// Dedup Logic (inspired by Mem0)
// ============================================================

function mergeMemory(
  existing: MemoryEntry,
  newValue: string,
  newCategory: string,
): MemoryEntry {
  return {
    ...existing,
    value: newValue.length > existing.value.length ? newValue : existing.value,
    category: (newCategory as MemoryCategory) || existing.category,
    updatedAt: Date.now(),
    accessCount: existing.accessCount + 1,
  };
}

function recordAccess(entry: MemoryEntry): void {
  entry.accessCount++;
  entry.lastAccessed = Date.now();
}

// ============================================================
// Extension
// ============================================================

export default function (pi: ExtensionAPI) {
  // ---- State ----
  let memories: MemoryEntry[] = [];
  let nextId = 1;

  // ---- Branch-Safe State Reconstruction ----
  const reconstructFromSession = (ctx: ExtensionContext) => {
    memories = [];
    nextId = 1;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const msg = entry.message;
      if (msg.role !== "toolResult") continue;
      if (msg.toolName !== "memory_set" && msg.toolName !== "memory_delete") continue;
      const details = msg.details as MemoryDetails | undefined;
      if (details) {
        memories = details.memories;
        nextId = details.nextId;
      }
    }
  };

  pi.on("session_start", async (_e, ctx) => reconstructFromSession(ctx));
  pi.on("session_tree", async (_e, ctx) => reconstructFromSession(ctx));

  // ---- Inject Memory Index into System Prompt ----
  pi.on("before_system_prompt", (_event, ctx) => {
    const prompt = buildMemoryPrompt(memories);
    if (prompt) ctx.systemPrompt += "\n\n" + prompt;
  });

  // ============================================================
  // Tool: memory_set
  // ============================================================
  pi.registerTool({
    name: "memory_set",
    label: "Memory Set",
    description:
      "Save a key-value fact into persistent memory. If the key already exists, update it. " +
      "Categories: fact (objective info), decision (design choices), preference (user preferences), context (environment).",
    parameters: Type.Object({
      key: Type.String({
        description: "Unique identifier in snake_case (e.g., preferred_db, auth_strategy)",
      }),
      value: Type.String({
        description: "The information to remember, up to ~500 characters",
      }),
      category: Type.Optional(
        Type.String({ description: "Memory category: fact | decision | preference | context" }),
      ),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const key = params.key.trim().toLowerCase();
      const value = params.value.slice(0, MAX_VALUE_LENGTH);
      const category = (params.category || "fact") as MemoryCategory;

      const existingIdx = memories.findIndex((m) => m.key === key);
      if (existingIdx >= 0) {
        memories[existingIdx] = mergeMemory(memories[existingIdx], value, category);
        return {
          content: [{ type: "text", text: `Updated memory: [${category}] ${key}` }],
          details: { action: "set", memories: [...memories], nextId } as MemoryDetails,
        };
      }

      const entry: MemoryEntry = {
        id: nextId++,
        key,
        value,
        category,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        accessCount: 1,
      };
      memories.push(entry);

      return {
        content: [{ type: "text", text: `Saved: [${category}] ${key}` }],
        details: { action: "set", memories: [...memories], nextId } as MemoryDetails,
      };
    },
  });

  // ============================================================
  // Tool: memory_get
  // ============================================================
  pi.registerTool({
    name: "memory_get",
    label: "Memory Get",
    description:
      "Retrieve a specific memory by its exact key. Use when you see a key in the system prompt memory index.",
    parameters: Type.Object({
      key: Type.String({ description: "Exact memory key" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const key = params.key.trim().toLowerCase();
      const found = memories.filter((m) => m.key === key);
      for (const m of found) recordAccess(m);

      const text = found.length
        ? found.map((m) => `[${m.category}] ${m.key}:\n${m.value}`).join("\n\n")
        : `No memory found: ${key}\nAvailable keys: ${memories.map((m) => m.key).join(", ") || "(none)"}`;

      return {
        content: [{ type: "text", text }],
        details: { action: "get", memories: [...memories], nextId, summary: text } as MemoryDetails,
      };
    },
  });

  // ============================================================
  // Tool: memory_search
  // ============================================================
  pi.registerTool({
    name: "memory_search",
    label: "Memory Search",
    description: "Search memories by keyword (matches key and value). Use when you don't know the exact key.",
    parameters: Type.Object({
      query: Type.String({ description: "Search keyword" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const q = params.query.toLowerCase();
      const results = memories.filter(
        (m) => m.key.toLowerCase().includes(q) || m.value.toLowerCase().includes(q),
      );
      for (const m of results) recordAccess(m);

      const text = results.length
        ? results
            .slice(0, MAX_SEARCH_RESULTS)
            .map((m) => `[${m.category}] \`${m.key}\`:\n${m.value}`)
            .join("\n\n")
        : `No memories match: ${q}`;

      return {
        content: [{ type: "text", text }],
        details: { action: "search", memories: [...memories], nextId, summary: text } as MemoryDetails,
      };
    },
  });

  // ============================================================
  // Tool: memory_list
  // ============================================================
  pi.registerTool({
    name: "memory_list",
    label: "Memory List",
    description: "List all stored memories as key + one-line preview.",
    parameters: Type.Object({}),

    async execute(_id, _params, _signal, _onUpdate, _ctx) {
      const text = memories.length
        ? memories
            .map((m) => {
              const preview = m.value.length > 80 ? m.value.slice(0, 80) + "..." : m.value;
              return `[${m.category[0].toUpperCase()}] \`${m.key}\`: ${preview}`;
            })
            .join("\n")
        : "No memories stored.";

      return {
        content: [{ type: "text", text }],
        details: { action: "list", memories: [...memories], nextId, summary: text } as MemoryDetails,
      };
    },
  });

  // ============================================================
  // Tool: memory_delete
  // ============================================================
  pi.registerTool({
    name: "memory_delete",
    label: "Memory Delete",
    description: "Delete a memory by key.",
    parameters: Type.Object({
      key: Type.String({ description: "Memory key to delete" }),
    }),

    async execute(_id, params, _signal, _onUpdate, _ctx) {
      const idx = memories.findIndex((m) => m.key === params.key.trim().toLowerCase());
      const text =
        idx >= 0 ? `Deleted: ${memories[idx].key}` : `No memory found: ${params.key}`;
      if (idx >= 0) memories.splice(idx, 1);
      return {
        content: [{ type: "text", text }],
        details: { action: "delete", memories: [...memories], nextId } as MemoryDetails,
      };
    },
  });

  // ============================================================
  // Command: /memory
  // ============================================================
  pi.registerCommand("memory", {
    description: "Show all stored memories",
    handler: async (_args, ctx) => {
      if (memories.length === 0) {
        ctx.ui.notify("No memories stored yet.", "info");
        return;
      }
      const lines = memories.map(
        (m) => `[${m.category}] ${m.key}: ${m.value.slice(0, 100)}`,
      );
      ctx.ui.notify(`Memories (${memories.length}):\n${lines.join("\n")}`, "info");
    },
  });
}
```
