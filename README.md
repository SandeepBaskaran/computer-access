# Computer Access MCP v1.0

> **v1.0** — Universal cross-platform MCP server for local machine access via cloud AI agents

Secure bridge for any cloud agent (Notion Custom Agents, Claude, GPT-4, Gemini) to access your local machine's terminal, filesystem, git, macOS system controls, media processing, documents, and networking — all over MCP with ngrok HTTPS tunneling.

---

## ✨ Features

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

---

## 📦 Project Structure

```
computer-access/
├── .env                    # Active config (secrets, gitignored)
├── .env.example            # Configuration template
├── .gitignore
├── package.json
├── tsconfig.json
├── agent-instructions.md   # Notion Custom Agent instructions
├── README.md
└── src/
    ├── start.ts            # Ngrok boot orchestrator
    └── server.ts           # MCP server with 8 master tools
```

---

## 📋 Changelog

### v1.0 — 2026-04-24
- Standardized terminal print pattern (consistent with browser-access)
- Added tunnel health check monitoring (30s interval)
- Renamed from "Agent Smith" to "Computer Access"
- Updated ngrok boot message format

---

## 📄 License

MIT
