# Computer Access MCP v1.1

> **v1.1** — Give cloud AI agents hands on your local machine, and an orchestrator for the local coding agents you already use

---

## 🎯 Who this is for

This bridge exists for **cloud-side AI agents that speak MCP but have no access to your machine** — platforms where the agent lives in someone else's product and reaches out through an MCP connector:

- **Notion Custom Agents** (the original use case — a scheduled agent driving a task board)
- **Claude.ai custom connectors** (web/desktop/mobile, not Claude Code)
- **ChatGPT with MCP connectors** / custom GPTs
- **Microsoft Copilot Studio** agents
- **Mistral Le Chat connectors**, Zapier/agent-builder platforms, or anything else that can call a remote MCP server

It is **not** needed by AI tools that already run natively on your machine — **Claude Code, OpenAI Codex CLI, Gemini CLI / Antigravity, GitHub Copilot CLI, opencode, Cursor, Aider** — those have their own local access. Here they play a different role: they're the **workforce this bridge orchestrates**.

## 🧠 Two roles in one server

1. **Hands** — 19 master tools give a cloud agent direct control of the machine: terminal, filesystem, git, macOS system control, browser automation, media processing, documents, networking. The cloud agent is the brain; these tools are the hands.
2. **Orchestrator** — the **Build Board bridge** (`plan-task` / `start-task` / `get-job-status` / `cancel-task` / `merge-task`) turns those local coding agents into dispatchable workers. A cloud agent doesn't have to write code through raw tool calls — it hands the task to Claude Code, Codex, opencode, or any CLI in the registry, and the bridge runs the whole engagement: isolated worktree, build, verify, commit, push, PR, gated merge, revert window.

**Example — end-to-end development from a task board:** a Notion Custom Agent (mine is named *Dispatcher Assistant*) wakes on a schedule, reads project tasks from the board, plans them (`plan-task`), dispatches each to the coding agent named on the card (`start-task`), posts progress and failures back as board comments (`get-job-status`), and — after a human approves — merges to main (`merge-task`). One agent in Notion, every coding CLI on your machine, a full development cycle with two human gates and no terminal in sight.

```
Notion board ──> Dispatcher Assistant (cloud, MCP connector)
                      │ ngrok HTTPS + Bearer token
                      ▼
             Computer Access MCP (this repo, local)
              ├─ hands: fs / shell / git / browser / macOS …
              └─ orchestrator: Build Board bridge
                     ├─ claude-code ─┐
                     ├─ codex        ├─ isolated worktrees → branch → PR → gated merge
                     └─ opencode …  ─┘
```

---

## ✨ Features

- **Build Board Bridge** — `start-task` / `get-job-status` / `merge-task`: durable, provider-agnostic coding-agent task orchestration (SQLite job store, isolated git worktrees, heartbeat crash detection, gated `--no-ff` merges with a revert window)
- **8 Master Tools** — Consolidated tool architecture for deep machine control
- **Multi-Agent Parallelism** — Session-isolated state allows multiple AI models to work together
- **Ngrok HTTPS Tunneling** — Auto-tunnels localhost for cloud agent access
- **Ripgrep-Powered Search** — Near-instant recursive search with error transparency
- **Session-Aware Auditing** — Every action logged with session ID and CWD
- **Safety & Guardrails** — Path sandboxing, command blocklist, feature toggles
- **SSE Stability** — 15s heartbeats for rock-solid proxy connections

---

## 🚀 Getting Started

### Prerequisites

- Node.js >= 18
- ngrok account (free tier works) — [dashboard.ngrok.com](https://dashboard.ngrok.com)

### Installation

```bash
npm install
```

### Configuration

```bash
cp .env.example .env
# Edit .env with your NGROK_AUTHTOKEN, MCP_TOKEN, and ALLOWED_DIRS
```

### Usage

```bash
npm start
```

Prints a secure connection URL + auth header — paste into your Notion Custom Agent's MCP settings.

---

## 🛠️ Tool Surface (8 Master Tools)

### 📂 `fs-manage` — File System Operations

| Action | Description |
|--------|-------------|
| `read` | Read text files with `limit` and `tail` support |
| `read-media` | Read image/audio as base64 for multimodal LLMs |
| `batch-read` | Read multiple files in one call |
| `write` | Create/overwrite files with auto-parent directory creation |
| `smart-edit` | Surgical find-and-replace edits |
| `list` / `list-with-sizes` | List directory contents with metadata |
| `tree` | Recursive JSON structure with exclusion patterns |
| `file-info` | File metadata (size, timestamps, permissions) |
| `move` / `copy` / `delete` / `mkdir` | File and directory management |

### 🔍 `fs-search` — Codebase Search

| Action | Description |
|--------|-------------|
| `regex-search` | Recursive regex search with context lines (`rg` backend) |
| `file-search` | Glob-based file finding across the codebase |
| `code-definitions` | Quick extraction of function/class/interface definitions |

### ⚙️ `sys-manage` — macOS & System Control

| Action | Description |
|--------|-------------|
| `exec` | Universal shell command execution (with CWD) |
| `info` | OS version, CPU, RAM, disk, uptime |
| `ps-list` / `ps-kill` | Process management and monitoring |
| `list-apps` / `open-app` / `open-url` / `open-file` | macOS app control |
| `clipboard-read` / `clipboard-write` | System clipboard access |
| `screenshot` | Capture screen or windows |
| `notification` / `say` | Notifications and text-to-speech |
| `volume` / `brightness` | Audio and display control |
| `caffeinate` / `lock-screen` | Power management |
| `active-app` / `window-list` | Window awareness |

### 📦 `git-manage` — Version Control

| Action | Description |
|--------|-------------|
| `status` / `add` / `commit` / `push` / `pull` | Core git workflow |
| `branch` / `log` / `diff` / `stash` / `merge` / `tag` | Branch management |
| `raw` | Run any git command directly |

### 🌐 `browser-manage` — Web Automation

| Action | Description |
|--------|-------------|
| `navigate` | Open a URL in headless Puppeteer |
| `click` / `type` | Interact with page elements |
| `get-text` / `get-html` | Extract page content |
| `screenshot-page` / `pdf` | Capture pages |
| `evaluate` | Run arbitrary JavaScript |
| `wait` | Wait for elements or conditions |

### 🌐 `net-manage` — Network & Research

| Action | Description |
|--------|-------------|
| `http-request` | REST client (GET/POST/PUT/DELETE) |
| `download` | Download files to local filesystem |
| `web-search` | Live search via DuckDuckGo |
| `port-check` | Verify local service status |

### 🎬 `media-manage` — Media Processing

| Action | Description |
|--------|-------------|
| `transcode` | Video transcoding via FFmpeg |
| `convert-image` | Image format conversion |
| `extract-audio` | Extract audio from video |
| `metadata` | Read media metadata via FFprobe |

### 📄 `doc-manage` — Document Intelligence

| Action | Description |
|--------|-------------|
| `pdf` / `docx` / `spreadsheet` / `csv` | Parse document contents |
| `markdown-preview` | Preview Markdown rendering |

---

## 🏗️ Build Board Bridge

Five MCP tools that let a scheduled cloud agent (e.g. a Notion Custom Agent) drive local coding-agent CLIs against a task board — the orchestrator role described above. State is durable (SQLite at `data/jobs.sqlite` + per-job logs at `data/logs/<taskId>.log`) and survives restarts.

| Tool | Description |
|------|-------------|
| `plan-task` | Dispatch a READ-ONLY plan job (no branch, no worktree, no writes) and return **immediately** — a slow plan never hangs the caller. Every provider plans in its cheapest viable mode (`planMode` in the registry): **headless** (flags, plan on stdout), **oneshot** (plan captured from a generated file like `plan.md`, artifact cleaned so the repo stays pristine), or **interactive** (the CLI's TUI driven through a pty — mode toggles, slash-commands, the brief). Thin/empty one-shot plans (< `PLAN_MIN_CHARS`) escalate to an interactive session for the same provider, and `complex: true` skips straight there. Plans are jobs in the same store as builds (state `planning` → `planned`, result in `plan`) sharing the concurrency pool, heartbeat/stale-kill, a `PLAN_TIMEOUT_MS` ceiling, and orphan-on-restart recovery. `PLAN_FALLBACK_AGENT` is **last-resort only** — it plans when a provider's mode can't be driven at all (pty failure, unknown flags, no mode), attributed in the plan text; the card's agent always does the build. `planUnsupported` only when neither the provider nor a valid fallback can plan. |
| `answer-task` | Relay a human's reply into a job paused on `hold(needs_input)`. A live interactive session gets the answer written straight into its pty (the session continues); a dead session (or one lost to a bridge restart, or a headless question) gets the answer folded into the brief and the job cleanly re-runs. Loop until `planned`. |
| `start-task` | Dispatch a task: creates branch `task/<taskId>` in an isolated worktree under `WORKTREE_ROOT`, runs the provider CLI asynchronously, returns immediately. On success: commit → push → PR via `gh` (compare-URL fallback; local-only when the repo has no `origin`) → state `in_review`. Structured returns: `alreadyRunning` (idempotent on `pageId`), `capacityExceeded`, `invalidRepo` (exact reason: missing path / not a dir / not a git repo / outside `ALLOWED_DIRS`). Empty diff after a build → `failed` with "no changes" (nothing committed or pushed). Re-dispatch of a `failed`/`in_review`/`hold`/`cancelled` task is the Rework path (same branch/worktree). |
| `get-job-status` | One job (with log excerpt, board-comment-ready) or the 50 most recent. Hold jobs carry `holdReason` (`needs_input` \| `quota` \| `session` \| `blocked`), `prevState`, `question`, `holdSince`. |
| `cancel-task` | Kills a running/held job, removes the worktree, **keeps the branch** — later re-dispatch resumes from it. |
| `merge-task` | `--no-ff` merge into main + push. Refuses unless the job is `in_review` and the working tree is clean. Branch **kept** for `REVERT_WINDOW_HOURS`, worktree removed. Conflicts return `{merged:false, conflict:true}` with the worktree intact. `action:"revert"` reverts a merge within the window (operator use). |

### 🔌 Always-on service (macOS)

The bridge runs forever as a per-user launchd service — starts at login, auto-restarts on crash — with sleep/wake resilience built to how macOS actually behaves: **sleep freezes the process and it resumes on wake** (no relaunch needed), so the bridge (a) holds a `caffeinate` power assertion **only while jobs are running**, (b) detects wake via a monotonic-clock gap and immediately runs *tunnel check → reconcile → self-scan*.

```bash
npm run build && ./scripts/install-service.sh   # bridge (+ ngrok tunnel service if NGROK_DOMAIN set)
./scripts/buildboard status|logs|stop|start     # stop = real stop (bootout); KeepAlive won't fight you
./scripts/uninstall-service.sh
```

- **Stable URL**: ngrok runs as its own KeepAlive service (`com.buildboard.tunnel`) on your reserved domain, so the MCP URL in Notion never changes; the bridge monitors it via the ngrok local API and reports it in `/status` — a tunnel blip never crashes anything.
- **Self-scan**: with `NOTION_TOKEN` (Keychain-backed) + `BOARD_DATA_SOURCE_ID`, the bridge polls the board every `SELF_SCAN_INTERVAL_MS` and on startup/wake: Ready for Dev → dispatch (capacity-respecting), In Progress/Hold → reconcile, Approved → merge. **The board is the durable queue** — cards queued while the Mac slept are picked up within seconds of wake instead of waiting for the cloud agent's 4-hour pulse. Both dispatchers share the SQLite store and page-UUID dedup, so a card is never double-dispatched.
- **Recovery, not routine resume**: on bridge start, non-terminal jobs are triaged — provider pid still **alive** → reattach (pid-liveness becomes the heartbeat; the pipeline finishes when it exits); pid **dead** → `RESUME_STRATEGY`: `resume` (provider session via `resumeArgsTemplate` — claude/opencode/grok/agy `--continue`, worktree-scoped), `rerun` (original brief, same worktree), or `rework` (fail with a note). A job whose card has left the active board states is never resumed.
- Service logs live in `~/.build-board/logs/` with copy-truncate rotation at 10 MB.

**Per-task Mode (board `Mode` select → build posture):** `Auto approve` (default, configurable via `DEFAULT_MODE`) runs the provider in its skip-permissions posture — full autonomy, installs allowed. `Accept edits` runs the provider's `acceptEditsArgs` posture under a **pty**: file edits auto-apply, but higher-risk actions (shell/installs/deletes/network) pause the CLI — the bridge captures the exact prompt, parks the job in `hold(needs_input)`, posts it to the card, and `answer-task` feeds the human's reply back into the live session. Both postures are data in [providers.json](providers.json).

**Package installs are user-authorized by design** (`ALLOW_PACKAGE_INSTALLS`, default `true`): these are your own repos, so `npm/pnpm/yarn/bun/pip/cargo/brew install` run freely inside allowlisted repo paths — nothing classifies them as dangerous. Setting it `false` refuses install commands on the bridge's exec surfaces (verifyCommand, `sys-manage exec`, `task-manage`); the allowlist and prompt-injection scoping are unchanged either way.

**Board-aware writeback:** the bridge's own writebacks (self-scan, wake-reconcile) resolve every Notion property and status/mode option name through [board-map.json](board-map.json) — nothing is hard-coded in logic. Each job persists its `pageId` + `boardId`, so comments and status flips always target the right card. MCP tools and the self-scan funnel through the same transition functions and job store (page-UUID dedup + per-task locks), so the cloud agent's pulse and the self-scan can never double-dispatch. The bridge only writes machine-side statuses (`in_progress`, `in_review`, `hold`, `rework`, `failed`, `merged`) — the human gates (Todo, Ready for Dev, Approved) are read-only to it.

> **Optional pty upgrade:** interactive/supervised sessions ship on a dependency-free `expect(1)` relay. If you want the more robust native pty, run `npm install node-pty` yourself — the bridge auto-detects and prefers it. The bridge never installs it for you.

**Hold & auto-retry:** provider output is classified on failure — rate-limit/quota → `hold(quota)` and the sweep auto-retries after `HOLD_RETRY_MS`, restoring the previous state; auth/session errors → `hold(session)` (human re-login needed); a trailing question → `hold(needs_input)` with the question captured; a failed push (protected branch / non-fast-forward / auth) → `hold(blocked)` with the commit kept local and `localOnly:true` — never a silent success.

**Providers** are data, not code — [providers.json](providers.json) maps a `codingAgent` name to `{command, argsTemplate, cwd, env, promptVia}` with `{brief}`/`{workspace}` placeholders. Shipped working: `claude-code`, `codex`, `opencode`; stubs to fill in: `antigravity-agy`, `grok-build`, `copilot-cli`. Adding a provider = one JSON entry.

> ⚠️ **Unattended-run flags:** the shipped entries run fully auto-approved (`claude --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`) — otherwise a bash prompt or sandbox denial stalls/fails the job until the stale-kill fires. Containment comes from the bridge, not the CLI: allowlisted repos (`ALLOWED_DIRS`), isolated worktrees, two human gates before main, and the revert window. To tighten codex later, swap the flag for `--sandbox workspace-write` (note: its sandbox blocks network, so dep installs fail). `opencode run` is non-interactive with allow-by-default permissions; if your opencode config sets permissions to "ask", switch them to "allow" for headless use.

**Crash safety:** heartbeat bumps on every output chunk (stdout *and* stderr); jobs silent past `HEARTBEAT_TIMEOUT_MS` or running past `JOB_MAX_RUNTIME_MS` are killed and marked `failed`; jobs interrupted by a bridge restart are marked `failed` on boot.

**Verification:** `verifyCommand` param > `.buildboard.json` `{"verifyCommand": "..."}` in the repo > skip. A failing verify commits the work locally (not pushed) and fails the task for Rework.

---

## 🛡️ Security & Guardrails

- **Path Isolation** — All operations validated against `ALLOWED_DIRS`
- **Command Blocklist** — Destructive patterns (`rm -rf /`, etc.) intercepted
- **Bearer Token Auth** — Every MCP request requires `MCP_TOKEN`
- **Audit Logs** — Every tool execution recorded in `audit.log` with session ID
- **Feature Toggles** — Disable write, shell, git, or media via `.env`

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8123` | Local MCP server port |
| `NGROK_DOMAIN` | — | Ngrok static domain (optional, for stable URLs) |
| `NGROK_AUTHTOKEN` | — | From [dashboard.ngrok.com](https://dashboard.ngrok.com) |
| `ALLOWED_DIRS` | — | Comma-separated absolute paths the server can access |
| `COMMAND_TIMEOUT` | `30000` | Shell command timeout in ms |
| `MCP_TOKEN` | — | Bearer token for authentication |
| `ENABLE_WRITE_EDIT` | `true` | Allow file write/edit operations |
| `ENABLE_RUN_COMMAND` | `true` | Allow shell command execution |
| `ENABLE_GIT` | `true` | Allow git operations |
| `ENABLE_FFMPEG` | `true` | Allow FFmpeg media processing |
| `DEFAULT_PROVIDER` | `claude-code` | Coding agent used when a task doesn't name one |
| `WORKTREE_ROOT` | `~/.build-board/worktrees` | Where task worktrees are created (outside repo trees) |
| `MAX_CONCURRENT_JOBS` | `2` | Parallel bridge job cap; excess returns `capacityExceeded` |
| `HEARTBEAT_TIMEOUT_MS` | `900000` | Kill + fail a job with no output for this long (15 min) |
| `JOB_MAX_RUNTIME_MS` | `7200000` | Hard kill for any job running longer (2 h) |
| `REVERT_WINDOW_HOURS` | `168` | Merged branches kept this long for revert, then cleaned |
| `PLAN_FALLBACK_AGENT` | `claude-code` | Last-resort planner, used only when a provider's plan mode can't be driven (empty = disable) |
| `PLAN_MIN_CHARS` | `200` | One-shot plans shorter than this escalate to an interactive session |
| `PLAN_IDLE_MS` | `20000` | Interactive session idle window before question/completion detection |
| `NOTION_TOKEN` | — | Board token for self-scan; `keychain:<service>` pulls from the macOS Keychain |
| `BOARD_DATA_SOURCE_ID` | — | Notion data source id of the Build Board |
| `SELF_SCAN_INTERVAL_MS` | `90000` | Board poll interval while awake (also fires on startup + wake) |
| `RESUME_STRATEGY` | `resume` | Dead-job recovery: `resume` \| `rerun` \| `rework` |
| `WAKE_GAP_MS` | `120000` | Wall-clock gap treated as a wake from sleep |
| `TUNNEL_API_URL` | `http://127.0.0.1:4040/api/tunnels` | ngrok local API for tunnel liveness |
| `ALLOW_PACKAGE_INSTALLS` | `true` | User-authorized installs in allowlisted repos; `false` refuses them on exec surfaces |
| `DEFAULT_MODE` | `auto` | Posture when a card has no Mode: `auto` \| `accept_edits` |
| `ENABLE_CONFIRMATION_GATE` | `false` | **Break-glass**: when `true`, `merge-task` refuses outright (autonomous merges disabled) |

---

## 📦 Project Structure

```
computer-access/
├── .env                    # Active config (secrets, gitignored)
├── .env.example            # Configuration template
├── .gitignore
├── package.json
├── tsconfig.json
├── providers.json          # Coding-agent CLI registry (Build Board bridge)
├── agent-instructions.md   # Notion Custom Agent instructions
├── README.md
├── data/                   # Bridge state: jobs.sqlite + logs/ (gitignored)
└── src/
    ├── start.ts            # Ngrok boot orchestrator
    ├── server.ts           # MCP server: master tools + Build Board tools
    ├── bridge.ts           # Build Board orchestration (start/status/merge, sweeps)
    ├── jobs.ts             # Durable SQLite job store
    └── providers.ts        # Provider registry loader/validator
```

---

## 📋 Changelog

### v1.1 — 2026-07-03
- **Build Board bridge**: `plan-task` / `start-task` / `get-job-status` / `answer-task` / `cancel-task` / `merge-task` MCP tools for board-driven coding-agent orchestration; plans are async background jobs (`planning` → `planned`) — no tool call ever blocks on a slow run
- **Plan modes per provider**: headless, oneshot (generated-file capture), and pty-driven interactive TUIs with question relay via board comments (`hold(needs_input)` → `answer-task`), thin-plan escalation, and last-resort fallback planning
- **Always-on service**: launchd LaunchAgents (bridge + ngrok tunnel) with `buildboard start|stop|status|logs`, power assertion held only while jobs run, monotonic-clock wake detection → tunnel/reconcile/self-scan, Notion board self-scan for near-instant card pickup, and pid-liveness recovery (reattach alive orphans; `RESUME_STRATEGY` for dead ones via per-provider `resumeArgsTemplate`)
- Durable SQLite job store (`data/jobs.sqlite`) with boot recovery + per-job log files
- Provider registry (`providers.json`) with per-provider **build** and **plan** modes (`buildArgs`/`planArgs`/`planSupported`), flags verified against installed CLIs: claude-code, codex, opencode, grok-build, github-copilot-cli plan-capable; antigravity-agy build-only
- Isolated per-task git worktrees under `WORKTREE_ROOT`, branch `task/<id>` kept through a configurable revert window
- **Hold states** with `holdReason` (`needs_input`/`quota`/`session`/`blocked`), quota auto-retry restoring `prevState`, push-failure → hold(blocked) with commit kept local
- Empty-diff builds return "no changes" instead of committing; structured `invalidRepo` with exact reason; default-branch detection (never hardcoded `main`)
- Heartbeat-based stale-job detection (stdout+stderr), max-runtime kill, concurrency cap
- Wired the confirmation gate into `merge-task` as a break-glass switch; removed duplicate `/health` route; `/status` now reports bridge jobs

### v1.0 — 2026-04-24
- Standardized terminal print pattern (consistent with browser-access)
- Added tunnel health check monitoring (30s interval)
- Renamed from "Agent Smith" to "Computer Access"
- Updated ngrok boot message format

---

## 📄 License

MIT
