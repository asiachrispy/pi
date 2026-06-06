# Pi Memory Module 技术方案（最终版）

> 吸收 Mem0、Letta/MemGPT、Zep、LangChain、CrewAI、AutoGen、Cognee、Khoj、Codex CLI
> 等开源系统架构，保留「索引预览 + 按需工具检索 + 会话分支隔离」核心路线。
> 以最低 token 成本（~130/轮）、最小代码量（单文件 extension）、零外部依赖，
> 为 Pi CLI / Pi-Web 提供具备人脑遗忘曲线、间隔强化、记忆巩固特性的 coding agent 记忆。

---

## 一、开源系统吸收与取舍

| 系统 | 吸收 | 拒绝 | 理由 |
|------|------|------|------|
| **Mem0** | 分层记忆；同 key 更新不新增 | 向量 DB；每次 add 调 LLM 做 dedup（500-2000 tokens/写） | Pi 不用向量、不额外消耗 LLM token |
| **Letta/MemGPT** | 冷热分页思想；固定大小记忆块 | Heartbeat 自动调页；Recall/Archival 双轨检索 | Pi session 已有 compaction 负责冷层；Heartbeat 增加延迟 |
| **Zep** | 事实/决定分离（即 Pi category）；重要性评分 | Postgres + pgvector + async pipeline；知识图谱 | 基础设施过重；Pi 是本地 agent |
| **LangChain** | 多后端可插拔概念 | 全量 Buffer / Summary 变体 | Pi 有 compaction，无需重复 |
| **CrewAI** | Entity 类型化（Pi category 已覆盖） | Multi-agent 记忆协调 | Pi 是 single-agent |
| **AutoGen** | Teachability 模式 | 代理给 Mem0 做存储 | Pi 自己管理存储，更轻 |
| **Cognee** | Key 层级命名空间（`db.preference`） | Neo4j 知识图谱 + pipeline | 编码场景不需要图谱关系 |
| **Khoj** | 本地离线优先 | 多模态文件索引 | Pi 聚焦结构化事实 |
| **Claude Code / Codex CLI** | 工具驱动检索；单一文件扩展 | 不注入 memory index | Pi 的差异化优势：index 注入 |

---

## 二、架构

```
  每次 LLM 调用:
  ┌──────────┐   context event 注入    ┌─────────────────────────┐
  │ Extension │ ────────────────────→  │ LLM sees:               │
  │ runtime   │  messages[0] = system  │ [memory:15, +2 dormant] │
  │           │  messages[1] = index   │ P preferred_db: pg      │
  │  memory   │  messages[2..] = orig  │ D auth_strategy: JWT    │
  │  store    │                        │ ... (top 8 hot keys)    │
  │ (Map)     │                        │ Model calls:            │
  │           │                        │ memory_get("key")       │
  └──────────┘                        └─────────────────────────┘
       ↑                                      │
       │ 重建                                 │ 持久化（双写）
       │ session_start 扫描                   │
       │ getBranch() 中的                     │ ① appendEntry("memory", {op,key,...})
       │ CustomEntry("memory")                │    → session JSONL (事件日志)
       │              +                       │
       │ .pi/memory.jsonl                     │ ② 快照覆盖写入
       │ (项目全局快照)                        │    → .pi/memory.jsonl (项目记忆)
       │                                      │
       ↓                                      ↓
  ┌─────────────┐                    ┌──────────────────┐
  │ Session     │                    │ 项目级记忆文件    │
  │ JSONL 事件  │                    │ .pi/memory.jsonl │
  │ (分支隔离)  │                    │ (跨 session)     │
  └─────────────┘                    └──────────────────┘
```

**四个组件，零外部依赖：**

1. **Memory Store** — `Map<string, MemoryEntry>`，纯内存
2. **Event Logger** — 写操作调用 `pi.appendEntry("memory", {...})` 落盘 session JSONL
3. **Project Snapshot** — 写操作同步覆盖 `.pi/memory.jsonl`，跨 session 恢复
4. **Context Injector** — `pi.on("context")` 向 `messages` 前部插入 memory index

---

## 三、数据结构

```typescript
type MemoryCategory = "fact" | "decision" | "preference" | "context";

interface MemoryEntry {
  key: string;              // snake_case, ≤64 chars, /^[a-z][a-z0-9_]*$/
  value: string;            // 实际内容，≤500 chars 建议，超限软警告
  category: MemoryCategory;
  createdAt: number;        // 首次创建时间戳 (ms)
  updatedAt: number;        // 最近一次 set 时间戳 (ms)
  accessCount: number;      // 累计访问次数（跨 session 持久化）
  lastAccessed: number;     // 最后访问时间戳 (ms)
  importance: 1 | 2 | 3 | 4 | 5;  // 默认 3
}

// appendEntry 事件格式（写入 session JSONL）
interface MemoryEvent {
  op: "set" | "delete";
  key: string;
  value?: string;
  category?: MemoryCategory;
  timestamp: number;
}
```

### Category 语义

| Category | 含义 | 示例 |
|----------|------|------|
| `fact` | 客观信息 | `staging_url: https://api.staging.example.com` |
| `decision` | 设计/技术决策 | `auth_strategy: JWT + refresh tokens, 15min expiry` |
| `preference` | 用户偏好 | `test_framework: Vitest (migrated from Jest)` |
| `context` | 环境细节 | `ci_provider: GitHub Actions, deploy on push to main` |

### Importance 对遗忘的影响

| 分值 | 含义 | 遗忘阈值 | 设置方式 |
|------|------|---------|---------|
| 1-2 | 临时/易变信息 | 21 天 | `memory_set` 可传 importance 参数 |
| 3 | 普通信息（默认） | 21 天 | 默认值 |
| 4-5 | 重要决策/偏好 | 60 天，且永不低于潜伏层 | 模型或用户显式设置 |

### 数据校验

| 字段 | 规则 | 拒绝行为 |
|------|------|---------|
| `key` | 非空；≤ 64 chars；`/^[a-z][a-z0-9_]*$/`；无连续下划线 | 返回错误提示 |
| `category` | 必须为 `fact | decision | preference | context` 之一 | 返回错误提示 |
| `value` | 非空；≤ 500 chars 建议 | > 500 存储但返回 `[long value]` 警告 |
| 敏感 key | 命中 `api_key / token / secret / password / credentials` | 拒绝并提示安全策略 |

---

## 四、人脑记忆三特性

### 4.1 遗忘曲线（Ebbinghaus 模型）

记忆有三个可见性层级，由 `lastAccessed` 和 `importance` 共同决定：

```
                    重要性 ≥ 4
最近访问  ─────────────────────────────
    │     │ 活跃    │ 潜伏    │ 沉睡*  │
    ▼     │(index)  │(index)  │(index) │  *永不低于潜伏
          ─────────────────────────────
    │     │ 活跃    │ 潜伏    │ 遗忘   │
    │     │(index)  │(index)  │(隐藏)  │
    ▼     ─────────────────────────────
          │ 活跃    │ 休眠    │ 遗忘   │
          │(index)  │(隐藏)   │(隐藏)  │
          ─────────────────────────────
           < 3天    3-21天     > 21天
              重要性 ≤ 3
```

| 层级 | 条件 | index 可见 | memory_get | memory_search | memory_list |
|------|------|-----------|------------|--------------|-------------|
| **活跃** | `lastAccessed` < 3 天，或 `accessCount` ≥ 5 且 < 7 天 | ✅ 参与 top 8 排序 | ✅ 正常返回 | ✅ 正常匹配 | ✅ |
| **潜伏/休眠** | 低重要性: 3-21 天无访问；高重要性: 3-60 天无访问 | ❌ 不显示，index 底部 `[+N dormant]` | ✅ 正常返回 | ✅ 正常匹配 | ✅ |
| **遗忘** | 低重要性: > 21 天无访问；高重要性: > 60 天无访问 | ❌ | ✅ 精确 key 可获取 | ❌ 不返回 | ❌ 仅 `--all` 可见 |

### 4.2 间隔强化（Spaced Repetition）

每次 `memory_get` / `memory_search` 命中都会：
- `accessCount += 1`
- `lastAccessed = Date.now()`

效果：频繁访问的记忆持续活跃，偶尔访问的保持在潜伏边缘，从不访问的自然遗忘。

### 4.3 记忆巩固（Consolidation via Importance）

`importance ≥ 4` 的记忆获得巩固优势：
- 遗忘阈值从 21 天延长到 60 天
- 永不低于"潜伏"层级（不会进入遗忘/隐藏状态）
- 排序权重 +10/级（importance 4 = +40 分，importance 5 = +50 分）

`accessCount ≥ 10` 的记忆额外获得抗遗忘保护（即使 importance 低也延长阈值到 30 天）。

### 4.4 存储强度 vs 检索强度

- **存储强度**：`.pi/memory.jsonl` 保存全部记忆，`memory_delete` 是唯一删除路径。被"遗忘"的记忆仍在磁盘上。
- **检索强度**：index 可见性 + `memory_search` 返回优先级。遗忘 ≠ 删除，只是检索困难（需精确 key）。
- **不自动删除**：21 天遗忘的记忆在 `/memory list --all` 中标记 `[stale]`，用户手动 `/memory clean` 清理。

---

## 五、项目级持久化

### 双写策略

| 写目标 | 格式 | 写入时机 | 用途 |
|--------|------|---------|------|
| Session JSONL (`appendEntry`) | 事件日志（set/delete） | 每次 tool 调用 | 分支隔离 rebuild |
| `.pi/memory.jsonl` | 全量快照（覆盖写入） | 每次 set/delete + session shutdown | 跨 session 恢复 |

### 重建流程

```
session_start:
  1. scan session.getBranch() → 过滤 CustomEntry("memory") → 重放事件 → sessionStore
  2. read .pi/memory.jsonl → projectStore
  3. for each key in projectStore:
       if key not in sessionStore → sessionStore.set(key, projectStore.get(key))
       else → sessionStore[key].accessCount = max(两者), .lastAccessed = max(两者)
  4. 最终 store = sessionStore (分支优先, 项目补齐)
```

- Session 中已有的 key 不覆盖（分支隔离优先）
- 项目级 accessCount/lastAccessed 作为"记忆强度"的跨 session 基线恢复

### 效果

| 操作 | 记忆状态 |
|------|---------|
| 同一 session 继续工作 | 正常累积（session JSONL + 项目文件同步） |
| `/new` 新建 session | 从 `.pi/memory.jsonl` 恢复全部项目记忆 |
| fork 分支 | 继承父分支 session 记忆 + 项目全局记忆 |
| 切换到其他项目的 session | 加载那个项目的 `.pi/memory.jsonl` |

### 文件大小

100 条记忆 × ~250 字节/行 ≈ 25KB。不影响项目仓库（`.pi/` 已在 `.gitignore`）。

---

## 六、Token 预算

### 索引格式

```
[memory:15, +2 dormant]
P preferred_pm: pnpm
D auth_strategy: JWT + refresh tokens, 15min
F staging_url: https://staging-api.example.com
P test_framework: Vitest
D db_indexing: partial indexes for soft-delete
C ci_provider: GitHub Actions
F api_version: v3, deprecating v2 by 2026Q3
P code_style: arrow functions, no semicolons
```

| 格式 | 8 条目 | 50 条目（仅 8 hot） | 100 条目（仅 8 hot） |
|------|--------|---------------------|----------------------|
| v1 XML | ~300 | ~300 | ~300 |
| **最终版** | **~130** | **~130** | **~130** |

### 工具调用

| 操作 | Tokens |
|------|--------|
| 普通问答（不需记忆） | **130** — 仅 index |
| 取 1 条记忆 | **280** — index + 1 get |
| 取 3 条记忆 | **580** — index + 3 gets |
| 搜索记忆 | **530** — index + 1 search |

对比全量注入（50 条 ≈ 5000 tokens/轮），节省 **97%**。

---

## 七、排序算法

```typescript
const DAY = 86400000;
const MAX_HOT_KEYS = 8;

function sortForIndex(entries: MemoryEntry[], now: number): MemoryEntry[] {
  return [...entries]
    .filter(e => !isForgotten(e, now))
    .sort((a, b) => {
      const aAccessDecay = Math.pow(0.5, (now - a.lastAccessed) / DAY / 7);  // 半衰期 7 天
      const bAccessDecay = Math.pow(0.5, (now - b.lastAccessed) / DAY / 7);
      const aUpdateDecay = Math.pow(0.5, (now - a.updatedAt) / DAY / 14);    // 半衰期 14 天
      const bUpdateDecay = Math.pow(0.5, (now - b.updatedAt) / DAY / 14);

      const aScore = a.accessCount * 5 + aAccessDecay * 50
                   + aUpdateDecay * 30 + a.importance * 10;
      const bScore = b.accessCount * 5 + bAccessDecay * 50
                   + bUpdateDecay * 30 + b.importance * 10;
      return bScore - aScore;
    })
    .slice(0, MAX_HOT_KEYS);
}

function isForgotten(e: MemoryEntry, now: number): boolean {
  const age = (now - e.lastAccessed) / DAY;
  const threshold = e.importance >= 4 ? 60
                  : e.accessCount >= 10 ? 30
                  : 21;
  return age > threshold;
}
```

---

## 八、合并策略：永远覆盖

同 key 直接覆盖。理由：
- 用户纠正 = 更短的值覆盖更长的值（v1 的"长值优先"会保留错误）
- Append 场景罕见，模型可先 `memory_get` 再拼上新值整体 `memory_set`
- 冲突感知 / 模型决策（v2）增加复杂度和模型负担，收益极低

---

## 九、工具 API

### 9.1 memory_set

```
参数: key (string), value (string), category? (string), importance? (1-5)
校验: key 非空 + snake_case；value 非空；category 枚举；key 不命中敏感模式
行为: store.set(key, entry)
      pi.appendEntry("memory", { op: "set", key, value, category, timestamp })
      同步覆盖 .pi/memory.jsonl
返回: "Saved: [category] key" 或 "Updated: [category] key"
```

### 9.2 memory_get

```
参数: key (string)
行为: store.get(key) → accessCount++, lastAccessed = now
返回: "[category] key:\nvalue" 或 "No memory found: key\nAvailable: keys..."
```

### 9.3 memory_search

```
参数: query (string)
行为: 大小写不敏感 substring 匹配 key + value
      遗忘层级的记忆不参与匹配
      匹配结果按 sortForIndex 排序，最多 5 条
      命中的记忆 accessCount++, lastAccessed = now
      空 query 或 "*" 返回前 5 条最热记忆
返回: 匹配的 key-value 列表
```

### 9.4 memory_list

```
参数: category? (string)
行为: 列出非遗忘层级的全部记忆，key + 80 chars preview
      category 过滤
返回: 列表文本
```

### 9.5 memory_delete

```
参数: key (string)
行为: store.delete(key)
      pi.appendEntry("memory", { op: "delete", key, timestamp })
      同步覆盖 .pi/memory.jsonl
返回: "Deleted: key" 或 "No memory found: key"
```

---

## 十、命令

```
/memory list            # 活跃 + 潜伏记忆
/memory list fact       # 按 category 过滤
/memory list --all      # 全部记忆（含遗忘层级，stale 标记）
/memory delete <key>    # 删除指定记忆
/memory clean           # 批量删除所有 stale 记忆（需确认）
```

---

## 十一、安全边界

| 层级 | 规则 |
|------|------|
| **写入拒绝** | key 命中 `/api[_-]?key\|token\|secret\|password\|passwd\|credential\|private[_-]?key\|auth[_-]?token/i` → 直接拒绝 |
| **索引脱敏** | 命中敏感 key 的 index preview 显示 `[redacted]` |
| **session 限定** | 记忆仅限当前项目，不做全局共享文件；不做跨项目迁移 |
| **用户审计** | `/memory list --all` 显示全部记忆完整值（用户对自己的数据有完全可见权） |

---

## 十二、Pi-Web 集成

### 前提条件

| 条件 | 说明 |
|------|------|
| Extension 文件路径一致 | 两端 `~/.pi/agent/extensions/memory.ts` 指向同一文件 |
| Pi-Web 加载该 extension | Pi-Web 需在 extension 路径中注册或显式 `--extension` |
| 同一项目目录 | 打开同目录 → 自动匹配同一 session + 同一 `.pi/memory.jsonl` |
| 事件链一致 | `session_start` → rebuild；`context` → inject index。Pi-Web 通过 `createAgentSession()` 走相同事件总线 |

### 不成立时不工作

若 Pi-Web 的 extension 路径或 session 初始化顺序与 CLI 不同，memory index 不会注入。此时 memory tools 仍可通过 JSONL 获得持久化，项目级记忆文件仍可被 Pi-Web 读取。

### 验证清单

1. CLI `memory_set("foo","bar")` → 检查 session JSONL 中 `CustomEntry("memory")` 存在
2. 检查 `.pi/memory.jsonl` 包含 foo 条目
3. Pi-Web 打开同一项目 → `/memory list` 显示 foo
4. Pi-Web 发送 "what is foo?" → 模型调用 `memory_get("foo")` 并返回 "bar"

---

## 十三、隐藏风险

| # | 风险 | 缓解 |
|---|------|------|
| 1 | **并发写冲突** — CLI + Pi-Web 同时写 `.pi/memory.jsonl` → 覆盖丢失 | JSONL session 架构的已知限制；用户文档要求不同时操作 |
| 2 | **Compaction 丢弃 custom entry** — 裁剪后重建丢失事件 | 监听 `session_before_compact`，必要时写 memory snapshot entry |
| 3 | **遗忘 ≠ 安全删除** — 遗忘的记忆仍在磁盘，用户以为删除了 | `/memory list --all` 可见所有记忆（含遗忘）；`/memory clean` 真删除 |
| 4 | **敏感词黑名单旁路** — `my_priv_key` 绕过 `private_key` 正则 | 正则黑名单有已知弱点；工具描述中写明 "do not store credentials" |
| 5 | **新 session 分支冲突** — fork 后两个分支独立 set 同 key，merge 时取项目文件的值作为 baseline | 标准行为：分支优先，项目文件只补齐未在分支中出现的 key |
| 6 | **项目文件 vs session 文件不同步** — crash 时 `.pi/memory.jsonl` 可能落后于 session JSONL | session JSONL 始终是 truth source；项目文件仅加速重建。下次 set 时自动修复 |
| 7 | **巨型 value** — 2000+ 字符 value 写入 JSONL 破坏可读性 | 软限制 500 字符 + 警告；未来可 Base64 编码 |
| 8 | **频繁 /new 的性能** — 每次新建 session 全量写入 `.pi/memory.jsonl` | 100 条记忆 < 1ms 写入；频率极低 |

---

## 十四、测试计划

| 测试 | 验证点 |
|------|--------|
| rebuild from events | set → set(覆盖) → delete → store 为空 |
| branch isolation | 分支 A set X，分支 B 看不到 X |
| project-level merge | session 有 key A，项目文件有 key B → store 同时有 A 和 B |
| forget curve | 设置 lastAccessed = 25 天前 → 记忆进入遗忘层级，index 不显示 |
| importance resistance | importance 5 + lastAccessed 30 天前 → 仍为潜伏（非遗忘） |
| set/get/search/delete | 基本 CRUD |
| hot sort order | 高频 + 最近访问 + 高 importance → 排前 |
| sensitive key reject | `api_key`, `token`, `password` → 拒绝 |
| empty/invalid key | `""`, `"UPPER"`, `"too__many"` → 拒绝 |
| `/memory list --all` | 遗忘的记忆标记 `[stale]` |
| overwrite | 同 key set 两次 → 最新值 |
| session reload | restart → 从项目文件恢复 accessCount |

---

## 十五、默认假设与局限

| 事项 | 决定 |
|------|------|
| 存储范围 | 项目级（`.pi/memory.jsonl`），不做全局用户级共享 |
| 检索方式 | 关键词 substring 匹配，不做向量检索 |
| 代码位置 | `packages/coding-agent` extension，不改 `packages/agent` harness |
| 安装方式 | 单文件 `~/.pi/agent/extensions/memory.ts` |
| 自动提取 | v1 不做（需模型主动调用 `memory_set` 或用户说 "remember"） |
| 自动删除 | v1 不做（遗忘只是隐藏，需用户 `/memory clean`） |

---

## 十六、未来扩展

| 方向 | 触发条件 | 方案 |
|------|---------|------|
| 向量检索 | 记忆 > 500 条 | `sqlite-vec` 或本地 ONNX embedding |
| 自动提取 | 使用频率高 | `agent_end` 事件 + LLM 提取本轮决策 |
| 跨项目全局记忆 | 多项目共享偏好 | `~/.pi/agent/memories.json` + 项目命名空间 |
| 自动清理 stale | 遗忘记忆堆积 | 90 天 stale → 自动删除（可配置开关） |
| Compaction 锚点 | compaction 丢弃 custom entry | `session_before_compact` 写入 snapshot |
| LLM 辅助安全 | 敏感词绕过正则 | tool 参数过 LLM 快速检查（警告级） |
