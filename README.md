<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

> New issues and PRs from new contributors are auto-closed by default. Maintainers review auto-closed issues daily. See [CONTRIBUTING.md](CONTRIBUTING.md).

---

# Pi Agent Harness Mono Repo

This is the home of the pi agent harness project including our self extensible coding agent.

* **[@earendil-works/pi-coding-agent](packages/coding-agent)**: Interactive coding agent CLI
* **[@earendil-works/pi-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/pi-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, …)

To learn more about pi:

* [Visit pi.dev](https://pi.dev), the project website with demos
* [Read the documentation](https://pi.dev/docs/latest), but you can also ask the agent to explain itself

## Share your OSS coding agent sessions

If you use pi or other coding agents for open source work, please share your sessions.

Public OSS session data helps improve coding agents with real-world tasks, tool use, failures, and fixes instead of toy benchmarks.

For the full explanation, see [this post on X](https://x.com/badlogicgames/status/2037811643774652911).

To publish sessions, use [`badlogic/pi-share-hf`](https://github.com/badlogic/pi-share-hf). Read its README.md for setup instructions. All you need is a Hugging Face account, the Hugging Face CLI, and `pi-share-hf`.

You can also watch [this video](https://x.com/badlogicgames/status/2041151967695634619), where I show how I publish my `pi-mono` sessions.

I regularly publish my own `pi-mono` work sessions here:

- [badlogicgames/pi-mono on Hugging Face](https://huggingface.co/datasets/badlogicgames/pi-mono)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |

For Slack/chat automation and workflows see [earendil-works/pi-chat](https://github.com/earendil-works/pi-chat).

## Permissions & Containerization

Pi does not include a built-in permission system for restricting filesystem, process, network, or credential access. By default, it runs with the permissions of the user and process that launched it.

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/docs/containerization.md](packages/coding-agent/docs/containerization.md) for three patterns:

- **OpenShell**: run the whole `pi` process in a policy-controlled sandbox.
- **Gondolin extension**: keep `pi` and provider auth on the host while routing built-in tools and `!` commands into a local Linux micro-VM.
- **Plain Docker**: run the whole `pi` process in a local container for simple isolation.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (can be run from any directory)
```

## Supply-chain hardening

We treat npm dependency changes as reviewed code changes.

- Direct external dependencies are pinned to exact versions. Internal workspace packages remain version-ranged.
- `.npmrc` sets `save-exact=true` and `min-release-age=2` to avoid same-day dependency releases during npm resolution.
- `package-lock.json` is the dependency ground truth. Pre-commit blocks accidental lockfile commits unless `PI_ALLOW_LOCKFILE_CHANGE=1` is set.
- `npm run check` verifies pinned direct deps, native TypeScript import compatibility, and the generated coding-agent shrinkwrap.
- The published CLI package includes `packages/coding-agent/npm-shrinkwrap.json`, generated from the root lockfile, to pin transitive deps for npm users.
- Release smoke tests use `npm run release:local` to build, pack, and create isolated npm and Bun installs outside the repo before tagging a release.
- Local release installs, documented npm installs, and `pi update --self` use `--ignore-scripts` where supported.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle scripts; new lifecycle-script deps fail checks until reviewed.

## License

MIT

---

<!-- FORK-NOTE: 本节为 asiachrispy/pi fork 维护，不属于上游 earendil-works/pi。
     追加在文末以尽量降低与上游 README 的合并冲突。 -->

## Fork 增量（`asiachrispy/pi` 相对上游 `earendil-works/pi`）

> 本节仅存在于我们的 fork（`asiachrispy/pi`），记录相对上游自建的引擎能力，便于每次 `git merge upstream/main` 时清点要带着走的永久差异。
> 复核：`git fetch upstream && git log --oneline upstream/main..HEAD`。

| 主题 | 增量内容 | 关键文件 | 来源提交 |
|------|----------|----------|----------|
| **RPC 树导航 + pi-web 远程** | 让 pi-web 经 RPC 远程驱动 agent，支持会话树导航与工具命令 | `packages/coding-agent/src/modes/rpc/*`、`core/agent-session-tree.ts`、`core/agent-session-queue.ts`、`docs/rpc.md`、`docs/pi-web-remote.md` | `05325f59` |
| **memory 记忆扩展（类人遗忘）** | 记忆扩展示例 + 首次运行自动安装（修 jiti Node builtins）；曾独立成 `pi-memory` 包后精简为「example 扩展 + auto-install」 | `packages/coding-agent/examples/extensions/memory.ts`、`core/ensure-memory-extension.ts`、`docs/memory-design*.md`、`docs/memory-features.md` | `6aa70629`/`25368a21`/`0eb8ed44`/`8c6dad34`/`8c5d3720` |
| **Agnes AI provider + 模型** | 新增 Agnes provider 与模型、显示名、环境变量密钥 | `packages/ai/src/providers/*`、`packages/ai/src/models.ts`、`core/provider-display-names.ts`、`packages/ai/src/env-api-keys.ts` | `935ec8e7` |
| **package-manager 重构 + 边界加固** | 拆分包管理为 git / npm / source-parser，新增包边界与大文件检查 | `core/package-manager-{git,npm}.ts`、`core/package-source-parser.ts`、`scripts/check-large-files.mjs`、`scripts/check-package-boundaries.mjs` | `632d8b23`/`110d50fd` |
| **AI 重试分类 / 定价 / responses 增强** | 重试错误分类、service-tier 定价、openai-responses 共享逻辑 | `packages/ai/src/utils/retry-classification.ts`、`packages/ai/src/providers/openai-responses*.ts` | 含于上游合并修复批次 |
| **system prompt 技能工作流增强** | 扩充 skill workflow 指引 | `packages/agent/src/agent-loop.ts`、system prompt | `b3988f64` |
| **dev-browser 技能 + skills-lock** | 新增 dev-browser 技能与技能锁定文件 | `.pi/skills/dev-browser/SKILL.md`、`skills-lock.json` | `8c5d3720` |
| **版本与上游合并维护** | Release v0.78.2；合并上游 v0.79.1 后的类型/未用变量修复 | `CHANGELOG.md`、各包 | `a253843e`/`7965963e`/`7923991f`/`dcf0bbc3` |

> 治理提示：`memory`、`web_fetch`（已迁社区 `pi-web-access`）等「引擎能力」优先评估能否由社区扩展承接，减少需长期维护的源码改动；RPC / package-manager 等深度引擎改造属必须自维护部分。
