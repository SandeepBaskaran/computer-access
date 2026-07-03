# Computer Access MCP v1.1

> **v1.1** — Universal cross-platform MCP server for local machine access via cloud AI agents

Secure bridge for any cloud agent (Notion Custom Agents, Claude, GPT, Gemini) to access your local machine's terminal, filesystem, git, macOS system controls, media processing, documents, and networking — over MCP with ngrok HTTPS tunneling.

> ⚠️ **This server intentionally exposes your shell and filesystem to a remote agent.** Read [Security & Guardrails](#️-security--guardrails) before running it. Treat the connection URL and `MCP_TOKEN` as root credentials for your machine.

---

## ✨ Features

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
# Edit .env with your NGROK_AUTHTOKEN, MCP_TOKEN, and ALLOWED_DIRS
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
| `ALLOWED_DIRS` | — | Comma-separated absolute paths the server can access |
| `COMMAND_TIMEOUT` | `30000` | Shell command timeout in ms |
| `MCP_TOKEN` | — | **Required.** Bearer token for authentication |
| `CORS_ORIGINS` | — | Comma-separated allowlist; permissive if unset |
| `ENABLE_WRITE_EDIT` / `ENABLE_RUN_COMMAND` / `ENABLE_GIT` / `ENABLE_FFMPEG` / `ENABLE_BROWSER` / `ENABLE_NET` / `ENABLE_DB` | `true` | Feature toggles |
| `ENABLE_SECRETS` | `false` | Allow macOS Keychain access (`secret-manage`) |
| `ENABLE_CONFIRMATION_GATE` | `false` | Require `confirm:true` for dangerous actions |
| `TOOLS` | — | Optional per-tool allowlist (comma-separated) |
| `MAX_READ_BYTES` | `10485760` | Max file read size |
| `MAX_EXEC_BUFFER` | `67108864` | Max child-process output buffer |
| `AUDIT_LOG_MAX_BYTES` | `10485760` | Rotate `audit.log` past this size |
| `RATE_LIMIT_WINDOW_MS` / `RATE_LIMIT_MAX` | `60000` / `200` | Request rate limiting |
| `WEBHOOK_URL` | — | POST a notification after each tool call |

---

## 📦 Project Structure

```
computer-access/
├── .env                    # Active config (secrets, gitignored)
├── .env.example            # Configuration template
├── .github/workflows/ci.yml
├── package.json
├── tsconfig.json
├── eslint.config.js
├── agent-instructions.md   # Notion Custom Agent instructions
├── README.md
├── src/
│   ├── config.ts           # Environment parsing (single source of truth)
│   ├── security.ts         # Path sandbox, blocklist, confirmation gate
│   ├── exec.ts             # Shell-free process execution helpers
│   ├── audit.ts            # Audit logging + rotation
│   ├── runtime.ts          # Shared singletons (sessions, tasks, watchers, browser)
│   ├── start.ts            # Ngrok boot orchestrator
│   ├── server.ts           # Composition root: builds the server + transports
│   └── tools/              # One module per master tool
│       ├── types.ts        # Register / ToolResult types
│       ├── fsManage.ts     ├── fsSearch.ts     ├── sysManage.ts
│       ├── gitManage.ts    ├── mediaManage.ts  ├── docManage.ts
│       ├── browserManage.ts├── netManage.ts    ├── taskManage.ts
│       ├── watchManage.ts  ├── secretManage.ts ├── archiveManage.ts
│       ├── dbManage.ts     ├── diffManage.ts   ├── codeFormat.ts
│       ├── testManage.ts   ├── auditManage.ts  ├── envManage.ts
│       └── windowManage.ts
└── tests/
    ├── security.test.ts    # Path/blocklist/confirmation unit tests
    └── exec.test.ts        # Argument tokenizer unit tests
```

---

## 📋 Changelog

### v1.1
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
