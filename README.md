# Computer Access MCP v2.0

> **v2.0** — Give cloud AI agents hands on your local machine — hardened, modular, injection-proof — plus an orchestrator for the local coding agents you already use

---

## 🎯 Who this is for

This bridge exists for **cloud-side AI agents that speak MCP but have no access to your machine** — platforms where the agent lives in someone else's product and reaches out through an MCP connector:

- **Notion Custom Agents** (the original use case — a scheduled agent driving a task board)
- **Claude.ai custom connectors** (web/desktop/mobile, not Claude Code)
- **ChatGPT with MCP connectors** / custom GPTs
- **Microsoft Copilot Studio** agents
- **Mistral Le Chat connectors**, Zapier/agent-builder platforms, or anything else that can call a remote MCP server

It is **not** needed by AI tools that already run natively on your machine — **Claude Code, OpenAI Codex CLI, Gemini CLI / Antigravity, GitHub Copilot CLI, opencode, Cursor, Aider** — those have their own local access. Here they play a different role: they're the **workforce this bridge orchestrates**.

**The control surface is pluggable too.** The bridge knows nothing about any particular board: a dispatcher — Notion custom agent, an Obsidian plugin, a cron script, any MCP client — supplies *which repo, which local agent, which brief* through the MCP tools, and the bridge does the rest. Notion is the worked example throughout these docs, not a dependency: the bridge is a generic build executor whose entire vocabulary is `directory + agent + mode + prompt + jobId` — `grep -ri notion src/` returns nothing. Whatever holds your queue (a Notion board, an Obsidian vault, a cron script) polls and dispatches through the six MCP tools.

## 🧠 Two roles in one server

1. **Hands** — 19 master tools give a cloud agent direct control of the machine: terminal, filesystem, git, macOS system control, browser automation, media processing, documents, networking. The cloud agent is the brain; these tools are the hands.
2. **Orchestrator** — the **build bridge** (`plan` / `start` / `get_status` / `answer` / `cancel` / `merge`) turns those local coding agents into dispatchable workers. A cloud agent doesn't have to write code through raw tool calls — it hands the task to Claude Code, Codex, opencode, or any CLI in the registry, and the bridge runs the whole engagement: isolated worktree, build, verify, commit, push, PR, gated merge, revert window.

**Example — end-to-end development from a task board:** a Notion Custom Agent (mine is named *Dispatcher Assistant*) wakes on a schedule, reads project tasks from the board, plans them (`plan`), dispatches each to the coding agent named on the card (`start`), posts progress and failures back as board comments (`get_status`), and — after a human approves — merges to main (`merge`). One agent in Notion, every coding CLI on your machine, a full development cycle with two human gates and no terminal in sight.

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

- **Build Bridge** — `plan` / `start` / `get_status` / `answer` / `cancel` / `merge`: durable, dispatcher-agnostic coding-agent orchestration (SQLite job store, FIFO queue, isolated git worktrees, question relay, heartbeat crash detection, gated `--no-ff` merges with a revert window)
- **8 Master Tools** — Consolidated tool architecture for deep machine control
- **Multi-Agent Parallelism** — Session-isolated state allows multiple AI models to work together
- **19 Master Tools** — Consolidated tool architecture for deep machine control
- **Two transports** — Legacy SSE (`/sse`) and modern Streamable HTTP (`/mcp`)
- **Multi-Agent Parallelism** — Session-isolated state lets multiple models work together
- **Ngrok HTTPS Tunneling** — Auto-tunnels localhost for cloud agent access
- **Ripgrep-Powered Search** — Fast recursive search with graceful `grep`/`fast-glob` fallback
- **Session-Aware Auditing** — Every action logged (with rotation) with session ID and CWD
- **Safety & Guardrails** — Path sandboxing (symlink-aware), shell-free execution, feature toggles, kill switch

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
# Edit .env with your NGROK_AUTHTOKEN, BRIDGE_AUTH_TOKEN, and ALLOWED_DIRS
```

`MCP_TOKEN` is **required** — the server refuses to open a tunnel without it (override for trusted local testing only via `ALLOW_UNAUTHENTICATED_TUNNEL=true`).

### Usage

```bash
npm start        # build + boot server + ngrok tunnel
npm test         # run the unit tests (vitest)
npm run lint     # eslint
npm run typecheck
```

`npm start` prints two connection URLs — paste the one your agent supports:

- **Streamable HTTP** → `<url>/mcp` (preferred for new clients)
- **Legacy SSE** → `<url>/sse`

---

## 🛠️ Tool Surface (19 Master Tools)

Each tool is action-dispatched: pass an `action` plus the fields that action needs.

| Tool | Purpose | Key actions |
|------|---------|-------------|
| `fs-manage` | Filesystem | read, read-media, batch-read, write, smart-edit, patch, list, list-with-sizes, tree, file-info, move, copy, delete, mkdir |
| `fs-search` | Codebase search | regex-search, file-search, code-definitions |
| `sys-manage` | System & macOS | exec, info, ps-list, ps-kill, list-apps, open-app/url/file, clipboard-read/write, screenshot, notification, say, volume, brightness, caffeinate, lock-screen, active-app, window-list, test-run, lint |
| `git-manage` | Version control | status, add, commit, push, pull, branch, log, diff, stash, merge, tag, raw |
| `media-manage` | FFmpeg/FFprobe | transcode, convert-image, extract-audio, metadata |
| `doc-manage` | Documents | pdf, docx, spreadsheet, csv, markdown-preview |
| `browser-manage` | Headless browser | navigate, click, type, get-text, get-html, screenshot-page, pdf, evaluate, wait |
| `net-manage` | Network | http-request, download, web-search, port-check |
| `task-manage` | Background jobs | run, status, logs, cancel, list |
| `watch-manage` | FS watch / log tail | watch, poll, unwatch, list-watchers, tail-log |
| `secret-manage` | macOS Keychain (off by default) | get, set, delete, list |
| `archive-manage` | Archives | zip, unzip, tar, untar, list-contents |
| `db-manage` | SQLite | query, execute, schema, list-tables |
| `diff-manage` | Diff & patch | file-diff, dir-diff, apply-patch, three-way-merge |
| `code-format` | Formatters | format, check, list-formatters |
| `test-manage` | Structured tests | run, run-file, coverage |
| `audit-manage` | Audit log explorer | tail, search, stats, session-history |
| `env-manage` | `.env` files | read, set, unset, validate, diff |
| `window-manage` | macOS windows | list, focus, resize, move, screenshot-window, applescript |

---

## 🏗️ Build Bridge

Six MCP tools that let any dispatcher (a Notion custom agent, an Obsidian plugin, a cron script — anything that speaks MCP) drive local coding-agent CLIs — the orchestrator role described above. The bridge's entire vocabulary is `jobId + repoPath + agent + mode + prompt`; it knows nothing about whichever tool dispatches the work. Every response uses the generic states `planning · planned · queued · running · awaiting_input · paused · in_review · failed · merged · cancelled`. State is durable (SQLite at `data/jobs.sqlite` + per-job logs at `data/logs/<jobId>.log`) and survives restarts.

| Tool | Description |
|------|-------------|
| `plan` | Dispatch a READ-ONLY plan job (no branch, no worktree, no writes) and return **immediately** — a slow plan never hangs the caller. Every provider plans in its cheapest viable mode (`planMode` in the registry): **headless** (flags, plan on stdout), **oneshot** (plan captured from a generated file like `plan.md`, artifact cleaned so the repo stays pristine), or **interactive** (the CLI's TUI driven through a pty — mode toggles, slash-commands, the brief). Thin/empty one-shot plans (< `PLAN_MIN_CHARS`) escalate to an interactive session for the same provider, and `complex: true` skips straight there. Plans are jobs in the same store as builds (state `planning` → `planned`, result in `plan`) sharing the concurrency pool, heartbeat/stale-kill, a `PLAN_TIMEOUT_MS` ceiling, and orphan-on-restart recovery. `PLAN_FALLBACK_AGENT` is **last-resort only** — it plans when a provider's mode can't be driven at all (pty failure, unknown flags, no mode), attributed in the plan text; the job's own agent always does the build. `planUnsupported` only when neither the provider nor a valid fallback can plan. |
| `answer` | Relay a human's reply into a job paused on `awaiting_input`. A live interactive session gets the answer written straight into its pty (the session continues); a dead session (or one lost to a bridge restart, or a headless question) gets the answer folded into the brief and the job cleanly re-runs. Loop until `planned`. |
| `start` | Dispatch a build: creates branch `job/<jobId>` (or a caller-supplied `branch`) in an isolated worktree under `WORKTREE_ROOT`, runs the agent CLI asynchronously, returns immediately. On success: commit → push → PR via `gh` (compare-URL fallback; `localOnly` when the repo has no `origin`) → `in_review` with a `diffStat`. Structured returns: `alreadyRunning` (idempotent on `jobId`), `queued: true` (capacity full — waits in a durable FIFO queue and starts itself when a slot frees), `invalidRepo` (exact reason, never a guessed path), and `awaiting_input` when the directory has no git repo — the bridge asks permission and `answer("yes")` runs `git init` and continues. Empty diff after a build → `in_review` with an **empty `diffStat`** so the caller sees nothing changed. Re-dispatch of a `failed`/`in_review`/`paused`/`cancelled` job re-runs on the same branch/worktree. |
| `get_status` | Always an **array**: one job (with log excerpt) or the 50 most recent. Key fields: `state`, `question` (on `awaiting_input`), `pausedReason` (`quota` auto-retries; `session`/`blocked` wait for a human), `prUrl`/`branchUrl`, `localOnly`, `diffStat`, `plan`, `error`, `lastHeartbeat`. |
| `cancel` | Kills a running/held job, removes the worktree, **keeps the branch** — later re-dispatch resumes from it. |
| `merge` | `--no-ff` merge into main + push. Refuses unless the job is `in_review` and no tracked files have uncommitted changes (untracked junk like `.DS_Store` never blocks). Branch **kept** for `REVERT_WINDOW_HOURS`, worktree removed. Conflicts return `{merged:false, conflict:true}` with the worktree intact. `action:"revert"` reverts a merge within the window (operator use). |

### 🔌 Always-on service (macOS)

The bridge runs forever as a per-user launchd service — starts at login, auto-restarts on crash — with sleep/wake resilience built to how macOS actually behaves: **sleep freezes the process and it resumes on wake** (no relaunch needed), so the bridge (a) holds a `caffeinate` power assertion **only while jobs are running**, (b) detects wake via a monotonic-clock gap and immediately runs *tunnel check → reconcile in-flight jobs → drain the queue*.

```bash
npm run build && ./scripts/install-service.sh   # bridge (+ ngrok tunnel service if NGROK_DOMAIN set)
./scripts/buildboard status|logs|stop|start     # stop = real stop (bootout); KeepAlive won't fight you
./scripts/uninstall-service.sh
```

- **Stable URL**: ngrok runs as its own KeepAlive service (`com.buildboard.tunnel`) on your reserved domain, so the MCP URL registered in your dispatcher never changes; the bridge monitors it via the ngrok local API and reports it in `/status` — a tunnel blip never crashes anything.
- **Durable FIFO queue**: dispatches beyond `MAX_CONCURRENT_JOBS` wait in SQLite (`state: queued`) and are drained at boot, by the sweep, and by the wake routine — jobs queued while the Mac slept start within seconds of wake, and the dispatcher never has to re-call `start`.
- **Recovery, not routine resume**: on bridge start, non-terminal jobs are triaged — provider pid still **alive** → reattach (pid-liveness becomes the heartbeat; the pipeline finishes when it exits); pid **dead** → `RESUME_STRATEGY`: `resume` (provider session via `resumeArgsTemplate` — claude/opencode/grok/agy `--continue`, worktree-scoped), `rerun` (original brief, same worktree), or `rework` (fail with a note).
- Service logs live in `~/.bridge/logs/` with copy-truncate rotation at 10 MB.

**Per-job Mode (`mode` param → build posture):** `auto` (default, configurable via `DEFAULT_MODE`) runs the agent in its skip-permissions posture — full autonomy, installs allowed. `accept_edits` runs the agent's `buildAcceptEditsArgs` posture under a **pty**: file edits auto-apply, but higher-risk actions (shell/installs/deletes/network) pause the CLI — the bridge captures the exact prompt, parks the job in `awaiting_input`, and `answer` feeds the human's reply back into the live session. Both postures are data in [providers.json](providers.json).

**Package installs are user-authorized by design** (`ALLOW_PACKAGE_INSTALLS`, default `true`): these are your own repos, so `npm/pnpm/yarn/bun/pip/cargo/brew install` run freely inside allowlisted repo paths — nothing classifies them as dangerous. Setting it `false` refuses install commands on the bridge's exec surfaces (verifyCommand, `sys-manage exec`, `task-manage`); the allowlist and prompt-injection scoping are unchanged either way.

**Launch-context-proof:** the bridge augments its `PATH` at startup with the well-known agent install dirs (`~/.local/bin`, `~/.claude/local`, `~/.opencode/bin`, homebrew, …), so providers resolve identically whether it was launched from a login shell, an IDE terminal, or launchd — and a boot **agent preflight** line reports exactly where each configured CLI resolves (or that it's missing) so a broken agent shows up at startup, not as a failed job.

> **Optional pty upgrade:** interactive/supervised sessions ship on a dependency-free `expect(1)` relay. If you want the more robust native pty, run `npm install node-pty` yourself — the bridge auto-detects and prefers it. The bridge never installs it for you.

**Hold & auto-retry:** provider output is classified on failure — rate-limit/quota → `paused(quota)` and the sweep auto-retries after `HOLD_RETRY_MS`, restoring the previous state; auth/session errors → `paused(session)` (human re-login needed); a trailing question → `awaiting_input` with the question captured; a failed push (protected branch / non-fast-forward / auth) → `paused(blocked)` with the commit kept local and `localOnly:true` — never a silent success.

**Providers** are data, not code — [providers.json](providers.json) maps an `agent` name to `{command, buildAutoArgs, buildAcceptEditsArgs, planMode, planArgs, resumeArgsTemplate, promptVia}` with `{brief}`/`{workspace}`/`{nudge}` placeholders. Shipped: `claude-code`, `codex`, `opencode`, `antigravity-agy`, `grok-build`, `github-copilot-cli` — each with auto, accept-edits, and plan postures. Adding a provider = one JSON entry (see the `_TODO` notes in the file for what's verified vs. per-spec).

> ⚠️ **Unattended-run flags:** the shipped entries run fully auto-approved (`claude --dangerously-skip-permissions`, `codex exec --dangerously-bypass-approvals-and-sandbox`) — otherwise a bash prompt or sandbox denial stalls/fails the job until the stale-kill fires. Containment comes from the bridge, not the CLI: allowlisted repos (`ALLOWED_DIRS`), isolated worktrees, two human gates before main, and the revert window. To tighten codex later, swap the flag for `--sandbox workspace-write` (note: its sandbox blocks network, so dep installs fail). `opencode run` is non-interactive with allow-by-default permissions; if your opencode config sets permissions to "ask", switch them to "allow" for headless use.

**Crash safety:** heartbeat bumps on every output chunk (stdout *and* stderr); jobs silent past `HEARTBEAT_TIMEOUT_MS` or running past `JOB_MAX_RUNTIME_MS` are killed and marked `failed`; jobs interrupted by a bridge restart are marked `failed` on boot.

**Verification:** `verifyCommand` param > `.bridge.json` `{"verifyCommand": "..."}` in the repo > skip. A failing verify commits the work locally (not pushed) and fails the task for Rework.

---

## 🛡️ Security & Guardrails

- **Path isolation (symlink-aware)** — All file operations are validated against `ALLOWED_DIRS`. Paths are fully symlink-resolved, so a symlink inside an allowed directory that points outside it is rejected.
- **Shell-free execution** — Tools invoke binaries via `execFile` with explicit argument vectors, so filenames/queries containing shell metacharacters cannot inject commands.
- **Bearer token auth** — Every MCP request requires `MCP_TOKEN` in the `Authorization` header (constant-time comparison; never accepted as a query parameter).
- **Kill switch** — Create `~/.mcp_kill` to block **all** tool calls (GET and POST) with a 503 until removed.
- **Feature toggles** — Disable write, shell, git, media, browser, net, db, or keychain independently.
- **Confirmation gate** — With `ENABLE_CONFIRMATION_GATE=true`, actions marked *dangerous* must be re-called with `confirm:true`.
- **Tool allowlist** — `TOOLS=fs-manage,fs-search` registers only those tools (least privilege).
- **Audit logs** — Every tool execution is recorded in `audit.log` (JSONL, auto-rotated) with session ID.

> ⚠️ **Honest limitation:** the command blocklist (`rm -rf /`, `curl … | sh`, …) is a *tripwire*, not a boundary. Once `ENABLE_RUN_COMMAND` is on, the `sys-manage exec` and `task-manage` tools can run anything your user account can, anywhere on disk — `ALLOWED_DIRS` only sandboxes the structured file tools and the command working directory. For real containment, disable shell execution or scope `TOOLS`.

---

## 🔧 Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8123` | Local MCP server port (shared by server and ngrok) |
| `NGROK_DOMAIN` | — | Ngrok static domain (optional, for stable URLs) |
| `NGROK_AUTHTOKEN` | — | From [dashboard.ngrok.com](https://dashboard.ngrok.com) |
| `ALLOWED_DIRS` | `~/Documents` | Repo allowlist. Add via `--add-dir <path>` / `buildboard add-dir` or `allowed-dirs.txt` (hot-reloaded); remove/edit via the file only |
| `COMMAND_TIMEOUT` | `30000` | Shell command timeout in ms |
| `BRIDGE_AUTH_TOKEN` | — | **Required** bearer for the internet-exposed MCP endpoint (`MCP_TOKEN` legacy alias; `BRIDGE_ALLOW_NO_AUTH=true` for local-only testing) |
| `CORS_ORIGINS` | — | Comma-separated allowlist; permissive if unset |
| `ENABLE_SECRETS` | `false` | Keychain access (largest exfiltration surface) — off by default |
| `TOOLS` | — | Optional least-privilege allowlist: only register these tools |
| `MAX_EXEC_BUFFER` | `64 MB` | Child-process stdout/stderr buffer cap |
| `AUDIT_LOG_MAX_BYTES` | `10 MB` | Audit log rotation threshold |
| `ENABLE_WRITE_EDIT` | `true` | Allow file write/edit operations |
| `ENABLE_RUN_COMMAND` | `true` | Allow shell command execution |
| `ENABLE_GIT` | `true` | Allow git operations |
| `ENABLE_FFMPEG` | `true` | Allow FFmpeg media processing |
| `DEFAULT_AGENT` | `claude-code` | Agent used when a job doesn't name one (`DEFAULT_PROVIDER` legacy alias) |
| `WORKTREE_ROOT` | `~/.bridge/worktrees` | Where task worktrees are created (outside repo trees) |
| `MAX_CONCURRENT_JOBS` | `2` | Parallel job cap; excess dispatches queue FIFO and start themselves |
| `HEARTBEAT_TIMEOUT_MS` | `900000` | Kill + fail a job with no output for this long (15 min) |
| `JOB_MAX_RUNTIME_MS` | `7200000` | Hard kill for any job running longer (2 h) |
| `REVERT_WINDOW_HOURS` | `168` | Merged branches kept this long for revert, then cleaned |
| `PLAN_FALLBACK_AGENT` | `claude-code` | Last-resort planner, used only when a provider's plan mode can't be driven (empty = disable) |
| `PLAN_MIN_CHARS` | `200` | One-shot plans shorter than this escalate to an interactive session |
| `PLAN_IDLE_MS` | `20000` | Interactive session idle window before question/completion detection |
| `PLAN_TIMEOUT_MS` | `600000` | Hard runtime ceiling for plan jobs (the `plan` call itself never blocks) |
| `HOLD_RETRY_MS` | `1800000` | Delay before a `paused(quota)` job auto-retries |
| `RESUME_STRATEGY` | `resume` | Dead-job recovery: `resume` \| `rerun` \| `rework` |
| `WAKE_GAP_MS` | `120000` | Wall-clock gap treated as a wake from sleep |
| `TUNNEL_API_URL` | `http://127.0.0.1:4040/api/tunnels` | ngrok local API for tunnel liveness |
| `ALLOW_PACKAGE_INSTALLS` | `true` | User-authorized installs in allowlisted repos; `false` refuses them on exec surfaces |
| `DEFAULT_MODE` | `auto` | Posture when a card has no Mode: `auto` \| `accept_edits` |
| `ENABLE_CONFIRMATION_GATE` | `false` | **Break-glass**: when `true`, `merge` refuses outright (autonomous merges disabled) |

---

## 📦 Project Structure

```
computer-access/
├── .env                    # Active config (secrets, gitignored)
├── .env.example            # Configuration template
├── .github/workflows/ci.yml
├── package.json
├── tsconfig.json
├── providers.json          # Coding-agent CLI registry (auto/accept-edits/plan/resume postures)
├── allowed-dirs.txt        # Optional allowlist additions (gitignored, hot-reloaded)
├── agent-instructions.md   # Example dispatcher instructions (Notion custom agent)
├── README.md
├── data/                   # Bridge state: jobs.sqlite + logs/ (gitignored)
├── scripts/                # install-service.sh · uninstall-service.sh · buildboard CLI
├── service/                # launchd plist templates (bridge + ngrok tunnel)
├── tests/                  # bridge-smoke.ts (157 assertions) · service-smoke.sh
└── src/
    ├── start.ts            # Ngrok boot orchestrator (embedded-tunnel mode)
    ├── server.ts           # Composition root: transports (SSE + /mcp), auth, guarded registrar
    ├── config.ts           # Environment parsing + allowed-dirs machinery (single source of truth)
    ├── security.ts         # Symlink-aware sandbox, blocklists, confirmation gate
    ├── audit.ts / exec.ts / runtime.ts   # Rotating audit log · shell-free exec · shared state
    ├── tools/              # One module per master tool (19) + bridgeTools.ts (the 6 bridge tools)
    ├── bridge.ts           # Job orchestration: dispatch, queue, sessions, recovery, sweeps
    ├── jobs.ts             # Durable SQLite job store (self-healing schema)
    ├── providers.ts        # Provider registry loader/validator
    ├── pty.ts              # Dependency-free pty layer (expect(1); node-pty auto-preferred)
    ├── power.ts            # caffeinate assertion, held only while jobs run
    └── wake.ts             # Monotonic-clock wake detection
```

---

## 📋 Changelog

### v2.0 — 2026-07-06
**The build bridge (dispatcher-agnostic orchestration):**
- **Build bridge**: `plan` / `start` / `get_status` / `answer` / `cancel` / `merge` MCP tools — a generic, dispatcher-blind build executor (vocabulary: `jobId + repoPath + agent + mode + prompt`; states: `planning/planned/queued/running/awaiting_input/paused/in_review/failed/merged/cancelled`). All calls return immediately; nothing blocks on a slow run
- Durable SQLite job store with a self-healing schema guard, FIFO **queueing** past the concurrency cap (drained at boot, sweep, and wake), and per-job log files
- Provider registry (`providers.json`): per-agent **auto / accept-edits / plan / resume** postures for claude-code, codex, opencode, antigravity-agy, grok-build, github-copilot-cli; plan modes headless / oneshot (generated-file capture) / interactive (pty-driven TUI) with thin-plan escalation and last-resort `PLAN_FALLBACK_AGENT`
- **Question relay**: supervised (`accept_edits`) builds and interactive plans pause as `awaiting_input` with the CLI's exact prompt; `answer` feeds the reply into the live pty session or cleanly re-runs. A directory without a git repo parks the job asking permission to `git init` — never initialized silently
- Isolated per-job git worktrees under `WORKTREE_ROOT`, branch `job/<jobId>` kept through a configurable revert window; empty diffs finish `in_review` with an empty `diffStat`; merge guard ignores untracked files; push failures pause with the commit kept local (`localOnly`)
- **Always-on service**: launchd LaunchAgents (bridge + ngrok reserved-domain tunnel) with the `buildboard` CLI, power assertion held only while jobs run, monotonic-clock wake detection → tunnel check / reconcile / queue drain, and pid-liveness recovery (reattach alive orphans; `RESUME_STRATEGY` resume/rerun/rework via per-provider `--continue` templates)
- **Hardening**: `BRIDGE_AUTH_TOKEN` required on the internet-exposed endpoint; `ALLOWED_DIRS` defaults to `~/Documents` with non-interactive `--add-dir` and a hot-reloaded `allowed-dirs.txt` (removals file-only); launch-context-proof PATH augmentation + boot agent preflight; user-authorized package installs (`ALLOW_PACKAGE_INSTALLS`); heartbeat stale-kill on stdout+stderr; break-glass `ENABLE_CONFIRMATION_GATE`
**The hardened core (security & structure):**
- **Security:** shell-free execution across all tools (execFile + argv), symlink-aware path sandbox, constant-time token check (header only), kill switch on POST routes, keychain off by default, tunnel refuses to start without `MCP_TOKEN`, confirmation gate wired into dispatch.
- **Robustness:** JSON body parsing (webhook tool names, pre-parsed transport bodies), single `/health` route, `smart-edit` uniqueness check without `$`-corruption, `patch` via system `patch(1)`, depth-capped/symlink-safe `tree`, background-task buffer caps + eviction + process-group kill, size caps on media reads, browser crash recovery, larger exec buffer.
- **Structure:** extracted `config`/`security`/`exec`/`audit`/`runtime` modules and split the 19 tool handlers into one module each under `src/tools/` (server.ts is now a ~350-line composition root); added vitest tests, eslint, and CI.
- **Enhancements:** Streamable HTTP transport (`/mcp`) alongside SSE, audit-log rotation, per-tool allowlist (`TOOLS`).
- **Dependencies:** replaced abandoned `xlsx@0.18.5` (ReDoS / prototype-pollution CVEs) with the vendor-distributed SheetJS `0.20.3` (same API, patched); dropped dead `@types/axios` and `@types/express-rate-limit`.

### v1.0 — 2026-04-24
- Standardized terminal print pattern; tunnel health check monitoring; renamed to "Computer Access".

---

## 📄 License

MIT
