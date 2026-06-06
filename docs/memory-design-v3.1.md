# Pi Memory v3.1：项目级持久 + 人脑记忆特性

> v3 缺口：项目级记忆只靠 session resume（新建 session 即丢失）；时间衰减只在索引排序，没有遗忘。
> v3.1 以最小的复杂度代价补齐这两项，模拟人脑记忆的遗忘曲线、间隔强化、记忆巩固。

---

## 一、缺口分析

| 特性 | v3 现状 | 问题 |
|------|---------|------|
| 项目级记忆 | session resume 隐式保留 | 用户 `/new` 新建 session 后，上个 session 的记忆全部丢失。同项目不该失忆。 |
| 时间遗忘 | index 排序有 recency 衰减 | 只影响展示顺序，不影响存储。一条 6 个月前的 `staging_url` 永久占据 slot。模型可能在 index 中看到过时信息。 |
| 访问强化 | accessCount 记录访问次数 | accessCount 不持久化（重载归零），等价于每次重启失忆。 |
| 记忆巩固 | 无 | 所有记忆同等对待。重要决策和临时的 staging URL 没有差异。 |

---

## 二、v3.1 新增能力

### 2.1 项目级记忆文件

memory 不再仅依赖 session JSONL 中的 `CustomEntry`。同时维护一份**项目级记忆快照**：

```
项目根目录 /.pi/memory.jsonl
```

- 每次 `memory_set` / `memory_delete` 时，同步写入 session JSONL（事件日志）**和**项目级文件（当前完整快照，覆盖写入）。
- `session_start` 时：先从 session JSONL 重建（保持分支隔离），再从项目级文件**合并**（补齐上个 session 的记忆）。
- 合并规则：session 中已有的 key 不覆盖（session 优先），session 中没有的 key 从项目级文件导入。

```
重建流程：
1. scan session getBranch() → sessionStore (分支隔离)
2. read .pi/memory.jsonl → projectStore (项目全局)
3. for each key in projectStore:
     if key not in sessionStore → sessionStore.set(key, projectStore.get(key))
4. 最终: sessionStore = 本分支记忆 + 项目历史记忆
```

**效果**：
- `/new` 新建 session → 记忆不丢失（从 `.pi/memory.jsonl` 恢复）
- fork 分支 → 新分支继承项目全局记忆 + 父分支特定记忆
- 同项目切换 session → 记忆持续

**存储格式**（`.pi/memory.jsonl`）：
```jsonl
{"key":"preferred_db","value":"PostgreSQL","category":"preference","updatedAt":1717000000000,"createdAt":1716000000000,"accessCount":23,"lastAccessed":1717000000000,"importance":3}
```

每行一条 JSON，覆盖写入整个文件（非追加）。文件大小：100 条记忆 × 250 字节 ≈ 25KB。

> 为什么不是 session JSONL 追加？因为项目级文件是**快照**，不是事件日志。它始终反映"当前项目知道的全部记忆"。session JSONL 仍然是 truth source for 分支隔离。

### 2.2 遗忘曲线（Ebbinghaus 模型）

每条记忆增加 `lastAccessed` 和 `importance` 字段。基于这两个字段决定记忆的**可见性层级**：

```
                    重要性高 (4-5)
最近访问  ────────────────────────────
    │     │ 活跃    │ 潜伏    │ 沉睡  │
    ▼     │(index)  │(index)  │(index)│
          ────────────────────────────
    │     │ 活跃    │ 潜伏    │ 遗忘  │
    │     │(index)  │(index)  │(隐藏) │
    ▼     ────────────────────────────
          │ 活跃    │ 休眠    │ 遗忘  │
          │(index)  │(隐藏)   │(隐藏) │
          ────────────────────────────
           < 3天    3-21天     > 21天
              重要性低 (1-3)
```

**三个可见性层级**：

| 层级 | 条件 | 行为 |
|------|------|------|
| **活跃** | `lastAccessed` < 3 天，或 `accessCount` >= 5 且 `lastAccessed` < 7 天 | 正常进入 index top 8 排序 |
| **潜伏/休眠** | 低重要性: 3-21 天无访问；高重要性: 3-21 天无访问 | **不在 index 中显示**，但 `memory_get/search` 仍可检索。index 底部显示一条：`[+N dormant memories]` |
| **遗忘/隐藏** | > 21 天无访问 | **不在 index 中显示**。`memory_get` 仍可直接获取（明确 key）。`memory_search` 不返回（除非 query 精确匹配 key）。`memory_list` 默认不显示，`/memory list --all` 可见。 |

**永不过期**：`importance >= 4` 且 `accessCount >= 10` 的记忆永远不进入"遗忘"层级（至少保持"潜伏"）。

**手动清理**：21 天遗忘 + 低重要性的记忆，在 `/memory list --all` 中标记 `[stale]`。用户可 `/memory clean` 批量删除 stale 记忆。不自动删除。

### 2.3 间隔强化（Spaced Repetition）

`memory_get` 调用不只是 `accessCount++`，还会更新 `lastAccessed`。每次访问都会**重置遗忘时钟**。

效果模拟人脑的间隔重复效应：
- 频繁访问的记忆 → `lastAccessed` 持续更新 → 始终保持"活跃"
- 偶尔访问的记忆 → 每 3-7 天重置一次时钟 → 在"潜伏"边缘但不会被遗忘
- 从不访问的记忆 → 21 天后自然遗忘

### 2.4 记忆巩固（Consolidation via Importance）

新增 `importance` 字段（1-5）：

| 分值 | 含义 | 遗忘抗性 | 设置方式 |
|------|------|---------|---------|
| 1-2 | 临时/易变信息 | 弱，21 天即遗忘 | `memory_set` 默认值 = 3，模型可传 `importance` 参数 |
| 3 | 普通信息 | 中等 | 默认值 |
| 4-5 | 重要决策/偏好 | 强，永不低于潜伏 | 模型判断或用户显式设置 |

模型在 `memory_set` 时可传 `importance`：
```
memory_set("auth_strategy", "JWT + refresh", "decision", importance=5)
```

重要记忆的遗忘时钟更慢：importance 4-5 的记忆，潜伏期从 3-21 天延长到 7-60 天。

### 2.5 检索强度 vs 存储强度

人脑记忆的关键区分：
- **存储强度**：记忆一旦存入就不会真正消失（只是检索困难）
- **检索强度**：取决于最近访问频率和线索

Pi 映射：
- 存储强度 = 项目级文件 `.pi/memory.jsonl`（记忆永存，除非显式 delete）
- 检索强度 = index 可见性 + `memory_search` 返回优先级
- 被"遗忘"的记忆仍在磁盘上，只是检索强度低（需要明确 key 才能取出）

---

## 三、数据结构变更

```typescript
interface MemoryEntry {
  key: string;
  value: string;
  category: MemoryCategory;
  createdAt: number;       // 首次创建时间 (ms) — 恢复
  updatedAt: number;       // 最后 set 时间 (ms)
  accessCount: number;     // 累计访问次数（含跨 session）
  lastAccessed: number;    // 最后访问时间 (ms) — 恢复
  importance: 1 | 2 | 3 | 4 | 5;  // 默认 3
}
```

**字段增量**：v3 只有 `key/value/category/updatedAt/accessCount`，v3.1 增加 `createdAt/lastAccessed/importance`。

**accessCount 持久化**：项目级文件保存 accessCount 和 lastAccessed。session 重建时从项目级文件恢复这些值，session 运行期间累加。session 结束时写回项目级文件。

**事件格式不变**：`appendEntry("memory", {op, key, ...})` 仍只有 set/delete，不含 access。access 更新在内存中积累，session shutdown 时 snapshot 到 `.pi/memory.jsonl`。

---

## 四、排序算法更新

```typescript
const DAY = 86400000;

function sortForIndex(entries: MemoryEntry[]): MemoryEntry[] {
  const now = Date.now();
  return [...entries]
    .filter(e => !isForgotten(e, now))    // 遗忘的不要
    .sort((a, b) => {
      const aAccessAge = (now - a.lastAccessed) / DAY;
      const bAccessAge = (now - b.lastAccessed) / DAY;
      const aUpdateAge = (now - a.updatedAt) / DAY;
      const bUpdateAge = (now - b.updatedAt) / DAY;

      // 访问衰减 (半衰期 7 天)
      const aAccessDecay = Math.pow(0.5, aAccessAge / 7);
      const bAccessDecay = Math.pow(0.5, bAccessAge / 7);

      // 更新衰减 (半衰期 14 天)
      const aUpdateDecay = Math.pow(0.5, aUpdateAge / 14);
      const bUpdateDecay = Math.pow(0.5, bUpdateAge / 14);

      const aScore = a.accessCount * 5
                   + aAccessDecay * 50
                   + aUpdateDecay * 30
                   + a.importance * 10;
      const bScore = b.accessCount * 5
                   + bAccessDecay * 50
                   + bUpdateDecay * 30
                   + b.importance * 10;
      return bScore - aScore;
    })
    .slice(0, MAX_HOT_KEYS);
}

function isForgotten(e: MemoryEntry, now: number): boolean {
  const accessAge = (now - e.lastAccessed) / DAY;
  const threshold = e.importance >= 4 ? 60 : 21;  // 高重要性 60 天
  return accessAge > threshold;
}
```

- 插入 importance 加权（1-5 → 贡献 10-50 分）
- 访问衰减用 7 天半衰期：今天访问过 → 1.0；7 天前 → 0.5；14 天前 → 0.25
- 遗忘的记忆直接过滤掉，不在 index 中占 slot

---

## 五、新增工具参数

### memory_set 新增 `importance`

```
参数: key, value, category?, importance? (1-5, default 3)
```

### memory_list 新增 `--all`

```
/memory list           # 活跃 + 潜伏
/memory list --all      # 全部（含遗忘）
```

---

## 六、生命周期

```
session_start
  ├─ 从 session getBranch() 重建 sessionStore（分支隔离）
  ├─ 从 .pi/memory.jsonl 读取 projectStore
  └─ 合并：projectStore 中 sessionStore 没有的 key 导入

每次 tool 调用 (set/get/search/delete)
  ├─ set → 更新 sessionStore + appendEntry + 标记 dirty
  ├─ get → sessionStore.get() + accessCount++ + lastAccessed = now
  └─ delete → sessionStore.delete() + appendEntry + 标记 dirty

context event (每次 LLM 调用前)
  └─ 从 sessionStore 生成 index（过滤遗忘 + 排序 + top 8）

session_shutdown / session_tree
  └─ 如果 dirty → 序列化 sessionStore 全量覆盖写入 .pi/memory.jsonl
```

---

## 七、v3 → v3.1 差异总结

| 维度 | v3 | v3.1 |
|------|----|------|
| 项目级持久 | session resume 隐式 | `.pi/memory.jsonl` 项目级文件 |
| 新建 session | 记忆丢失 | 从项目文件恢复 |
| 遗忘机制 | 无 | 21 天无访问 → 潜伏 → 遗忘（importance 调节） |
| accessCount 持久化 | 重载归零 | 项目文件保存，session shutdown 写回 |
| importance | 无 | 1-5，模型可设置，影响遗忘抗性 |
| lastAccessed | 无 | 恢复，每次 get 更新 |
| createdAt | 无 | 恢复，首次 set 记录 |
| Token 开销 | 120 | 120（index 格式不变） + 潜伏计数行 `[+N dormant]` ~8 tokens |
| 代码增量 | 基线 | + 项目文件 I/O + 遗忘判定 + importance 参数 |
