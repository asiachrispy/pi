# Pi Memory：特性与功能

> 基于 memory-design-final 方案。Pi 记忆是一个项目级、具备人脑遗忘特性的键值记忆系统，通过 extension 安装在 Pi CLI / Pi-Web 中，零外部依赖。

---

## 特性

### 极低 Token 成本

每次 LLM 调用固定消耗约 130 tokens（索引注入），不随记忆数量增长。对比全量注入（50 条记忆 ≈ 5000 tokens/轮），节省 **97%**。

### 项目级持久化

记忆随项目保存到 `.pi/memory.jsonl`。新建 session、fork 分支、切换到其他项目再回来——记忆不丢失。每个项目拥有独立的记忆空间。

### 人脑记忆模型

| 机制 | 表现 |
|------|------|
| **遗忘曲线** | 21 天无访问的记忆进入潜伏（index 不显示），继续无访问进入遗忘（search 不返回，需精确 key） |
| **间隔强化** | 每次 `memory_get` 刷新遗忘时钟。频繁访问的记忆持续活跃，从不访问的自然遗忘 |
| **记忆巩固** | `importance` 4-5 的重要记忆遗忘阈值延长到 60 天，且永不低于潜伏层 |
| **存储 vs 检索** | 被"遗忘"的记忆仍在磁盘上。遗忘是检索困难，不是删除。`/memory list --all` 可审计全部 |

### 分支隔离

fork 出的分支各自拥有独立记忆空间，互不干扰。底层由 Pi session JSONL 树形结构保证。

```text
Branch A: root → "remember X" → memory_set("foo","A") → foo = "A"
Branch B: root → "remember Y" → memory_set("foo","B") → foo = "B"  (独立)
```

### 用户可控

- `/memory list` 查看活跃和潜伏记忆
- `/memory list --all` 查看全部记忆（含遗忘层级，`[stale]` 标记）
- `/memory delete <key>` 删除指定记忆
- `/memory clean` 批量清除遗忘记忆

---

## 功能

### 5 个 LLM 工具

| 工具 | 功能 | 示例 |
|------|------|------|
| `memory_set` | 写入/覆盖键值记忆 | `memory_set("preferred_db", "PostgreSQL", "preference", importance=5)` |
| `memory_get` | 按 key 获取完整值 | `memory_get("preferred_db")` |
| `memory_search` | 模糊搜索（不返回遗忘层级） | `memory_search("database")` |
| `memory_list` | 列出记忆（key + 预览） | `memory_list()` 或 `memory_list("decision")` |
| `memory_delete` | 按 key 删除 | `memory_delete("old_api_url")` |

### 4 种分类

| 分类 | 含义 | 示例 |
|------|------|------|
| `fact` | 客观信息 | staging URL、API 版本号 |
| `decision` | 设计/技术决策 | 为什么选 Postgres、认证策略 |
| `preference` | 用户偏好 | 测试框架、代码风格 |
| `context` | 环境细节 | CI provider、部署方式 |

### Importance 分级

| 分值 | 遗忘抗性 | 适用场景 |
|------|---------|---------|
| 1-2 | 弱（21 天） | 临时信息 |
| 3 | 中等（21 天） | 默认值 |
| 4-5 | 强（60 天，永不遗忘） | 重要决策、核心偏好 |

### 4 个用户命令

```
/memory list           # 活跃 + 潜伏记忆
/memory list fact      # 按 category 过滤
/memory list --all     # 全部记忆（含遗忘层级）
/memory delete <key>   # 删除指定记忆
/memory clean          # 批量清除 stale 记忆
```

### 安全性

- `api_key`、`token`、`password`、`credentials` 等敏感 key 名直接拒绝写入
- 索引注入时敏感记忆的值显示 `[redacted]`
- 用户通过 `/memory list --all` 可审计全部记忆（含遗忘层级）

---

## 工作量

| 维度 | 说明 |
|------|------|
| 安装 | 单文件 `~/.pi/agent/extensions/memory.ts` |
| 依赖 | 零外部依赖（仅 Pi Extension API + Node.js 内置 fs） |
| 存储 | Session JSONL（事件日志）+ `.pi/memory.jsonl`（项目快照，~25KB/100 条） |
| 性能 | 100 条记忆索引排序 < 1ms；rebuild 扫描 < 1ms |

## 局限（v1 范围）

| 不做的事 | 原因 |
|----------|------|
| 跨项目全局记忆 | v1 限定项目级，不做全局用户 profile |
| 向量/语义搜索 | < 100 条记忆时关键词匹配足够 |
| 自动提取记忆 | 需模型主动调用 `memory_set` 或用户说 "remember" |
| 自动删除遗忘记忆 | 遗忘 = 隐藏，不自动删除。用户手动 `/memory clean` |
