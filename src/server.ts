import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { randomUUID, timingSafeEqual } from "crypto";
import type puppeteer from "puppeteer";

import {
  ALLOWED_DIRS, PORT, MCP_TOKEN, SESSION_IDLE_TTL_MS, SESSION_MAX_TTL_MS,
  SESSION_CLEANUP_INTERVAL_MS, CORS_ORIGINS, WEBHOOK_URL,
  RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX, TOOL_ALLOWLIST,
} from "./config.js";
import { requiresConfirmation } from "./security.js";
import { auditLog } from "./audit.js";
import {
  activeSessions, sessionsByResumeToken, backgroundTasks, fileWatchers,
  sendWebhook, isKillSwitchActive, closeBrowser,
} from "./runtime.js";
import type { Register } from "./tools/types.js";
import { registerFsManage } from "./tools/fsManage.js";
import { registerFsSearch } from "./tools/fsSearch.js";
import { registerSysManage } from "./tools/sysManage.js";
import { registerGitManage } from "./tools/gitManage.js";
import { registerMediaManage } from "./tools/mediaManage.js";
import { registerDocManage } from "./tools/docManage.js";
import { registerBrowserManage } from "./tools/browserManage.js";
import { registerNetManage } from "./tools/netManage.js";
import { registerTaskManage } from "./tools/taskManage.js";
import { registerWatchManage } from "./tools/watchManage.js";
import { registerSecretManage } from "./tools/secretManage.js";
import { registerArchiveManage } from "./tools/archiveManage.js";
import { registerDbManage } from "./tools/dbManage.js";
import { registerDiffManage } from "./tools/diffManage.js";
import { registerCodeFormat } from "./tools/codeFormat.js";
import { registerTestManage } from "./tools/testManage.js";
import { registerAuditManage } from "./tools/auditManage.js";
import { registerEnvManage } from "./tools/envManage.js";
import { registerWindowManage } from "./tools/windowManage.js";

if (ALLOWED_DIRS.length === 0) {
  console.error("CRITICAL ERROR: 'ALLOWED_DIRS' environment variable is missing or empty.");
  process.exit(1);
}

// ── MCP Server Factory ──────────────────────────────────────
function createMcpServer(sessionId: string) {
  const server = new McpServer({
    name: "computer-access",
    version: "1.1.0",
    description: "Universal cross-platform secure bridge for ANY cloud agent"
  });

  // Enforces the per-tool allowlist and the confirmation gate, and injects a
  // uniform `confirm` argument so the gate can be honoured. Passed to each
  // tool module, which calls it exactly like the old registerTool.
  const registerGuardedTool: Register = (name, config, handler) => {
    if (TOOL_ALLOWLIST.length > 0 && !TOOL_ALLOWLIST.includes(name)) return;
    const inputSchema = {
      ...config.inputSchema,
      confirm: z.boolean().optional().describe("Set true to authorise a dangerous action when the confirmation gate is enabled"),
    };
    server.registerTool(name, { ...config, inputSchema }, async (args: any) => {
      if (!args?.confirm) {
        const gate = requiresConfirmation(name, args?.action ?? "");
        if (gate.required) {
          await auditLog(name, { action: args?.action }, "BLOCKED", sessionId, "Confirmation required");
          return { content: [{ type: "text" as const, text: `CONFIRMATION REQUIRED: ${gate.reason}. Re-call ${name} with confirm:true to proceed.` }] };
        }
      }
      return handler(args);
    });
  };

  registerFsManage(registerGuardedTool, sessionId);
  registerFsSearch(registerGuardedTool, sessionId);
  registerSysManage(registerGuardedTool, sessionId);
  registerGitManage(registerGuardedTool, sessionId);
  registerMediaManage(registerGuardedTool, sessionId);
  registerDocManage(registerGuardedTool, sessionId);
  registerBrowserManage(registerGuardedTool, sessionId);
  registerNetManage(registerGuardedTool, sessionId);
  registerTaskManage(registerGuardedTool, sessionId);
  registerWatchManage(registerGuardedTool, sessionId);
  registerSecretManage(registerGuardedTool, sessionId);
  registerArchiveManage(registerGuardedTool, sessionId);
  registerDbManage(registerGuardedTool, sessionId);
  registerDiffManage(registerGuardedTool, sessionId);
  registerCodeFormat(registerGuardedTool, sessionId);
  registerTestManage(registerGuardedTool, sessionId);
  registerAuditManage(registerGuardedTool, sessionId);
  registerEnvManage(registerGuardedTool, sessionId);
  registerWindowManage(registerGuardedTool, sessionId);

  // ── MCP Prompts ──────────────────────────────────────────
  server.registerPrompt("check-codebase", {
    title: "Check Codebase",
    description: "Perform a high-level audit of the codebase structure and identify major components."
  }, async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Please use fs-manage/tree and fs-search/regex-search to audit this codebase. Identify the main entry points, configuration files, and core logic modules." }
      }
    ]
  }));

  server.registerPrompt("security-review", {
    title: "Security Review",
    description: "Scan the codebase for potential security vulnerabilities like hardcoded secrets or shell injection risks."
  }, async () => ({
    messages: [
      {
        role: "user",
        content: { type: "text", text: "Perform a security review. Search for 'exec(', 'process.env', 'apiKey', 'password', and 'token'. Check if inputs are sanitized before being passed to shell commands." }
      }
    ]
  }));

  return server;
}

// ── Transport Layer (HTTP/SSE + Streamable HTTP) ────────────
const app = express();
app.set("trust proxy", 1);
// Parse JSON bodies so the parsed body can be handed to the MCP transports
// (which accept a pre-parsed body) and so the webhook can read the tool name.
app.use(express.json({ limit: "8mb" }));

app.use(cors({
  origin: CORS_ORIGINS.length > 0
    ? (origin, cb) => { if (!origin || CORS_ORIGINS.includes(origin)) cb(null, true); else cb(new Error("CORS: origin not allowed")); }
    : true,
  credentials: true,
}));

app.use(rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.url === "/health" || req.url === "/status",
}));

let totalRequests = 0;
app.use((req, _res, next) => { if (req.method === "POST") totalRequests++; next(); });

const SERVER_START_TIME = Date.now();
app.get("/health", (_req, res) => { res.json({ status: "running" }); });
app.get("/status", (_req, res) => res.json({
  status: "running",
  uptimeSeconds: Math.floor((Date.now() - SERVER_START_TIME) / 1000),
  activeSessions: activeSessions.size,
  backgroundTasks: { total: backgroundTasks.size, running: Array.from(backgroundTasks.values()).filter(t => t.status === "running").length },
  activeWatchers: fileWatchers.size,
  totalToolCalls: totalRequests,
  rateLimitWindow: RATE_LIMIT_WINDOW_MS,
  rateLimitMax: RATE_LIMIT_MAX,
  sessionIdleTtlMs: SESSION_IDLE_TTL_MS,
  sessionMaxTtlMs: SESSION_MAX_TTL_MS,
}));

// Constant-time bearer comparison; token is accepted ONLY via the
// Authorization header (never a query param, which leaks into proxy logs).
function tokenMatches(provided: string | undefined): boolean {
  if (!MCP_TOKEN) return true;
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(MCP_TOKEN.trim());
  return a.length === b.length && timingSafeEqual(a, b);
}

const authenticate = (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS" || req.method === "HEAD") return next();
  if (req.url === "/health" || req.url === "/status" || req.url.startsWith("/.well-known/")) return next();
  if (!MCP_TOKEN) return next();
  const authHeader = req.headers.authorization;
  const providedToken = authHeader?.startsWith("Bearer ") ? authHeader.substring(7).trim() : undefined;
  if (tokenMatches(providedToken)) return next();
  res.status(401).json({ error: "Unauthorized" });
};

const killSwitchGuard = async (req: Request, res: Response, next: NextFunction) => {
  if (req.method === "OPTIONS" || req.method === "HEAD") return next();
  if (req.url === "/health" || req.url === "/status") return next();
  if (await isKillSwitchActive()) {
    await auditLog("KILL_SWITCH", { url: req.url }, "BLOCKED");
    return res.status(503).json({ error: "KillSwitchActive", message: "Emergency kill switch is active. Remove ~/.mcp_kill to resume." });
  }
  next();
};

setInterval(() => {
  const now = Date.now();
  for (const [id, session] of activeSessions) {
    const idleTooLong = now - session.lastActivity > SESSION_IDLE_TTL_MS;
    const exceededMaxAge = now - session.createdAt > SESSION_MAX_TTL_MS;
    if (idleTooLong || exceededMaxAge) {
      if (session.page) session.page.close().catch(() => {});
      sessionsByResumeToken.delete(session.resumeToken);
      activeSessions.delete(id);
      session.server.close().catch(() => {});
    }
  }
}, SESSION_CLEANUP_INTERVAL_MS).unref();

// ── Legacy SSE transport ────────────────────────────────────
const sseHandler = async (req: Request, res: Response) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");

  const incomingResumeToken = req.query.resumeToken as string | undefined;
  let resumedPage: puppeteer.Page | null = null;
  if (incomingResumeToken) {
    const existingId = sessionsByResumeToken.get(incomingResumeToken);
    if (existingId) {
      const existingSession = activeSessions.get(existingId);
      if (existingSession) {
        resumedPage = existingSession.page;
        existingSession.page = null;
        sessionsByResumeToken.delete(incomingResumeToken);
        activeSessions.delete(existingId);
        existingSession.server.close().catch(() => {});
      }
    }
  }

  const transport = new SSEServerTransport("/messages", res);
  const server = createMcpServer(transport.sessionId);
  const resumeToken = randomUUID();
  const now = Date.now();

  const writeEvent = (msg: string) => {
    try { res.write(`: ${msg}\n\n`); } catch { /* connection already gone */ }
  };

  activeSessions.set(transport.sessionId, {
    transport, server, createdAt: now, lastActivity: now, resumeToken, page: resumedPage, writeEvent,
  });
  sessionsByResumeToken.set(resumeToken, transport.sessionId);

  res.setHeader("X-Session-Resume-Token", resumeToken);
  res.setHeader("X-Session-Id", transport.sessionId);

  const keepAlive = setInterval(() => {
    try {
      const ok = res.write(": heartbeat\n\n");
      if (!ok) res.destroy();
    } catch {
      cleanup();
    }
  }, 10000);

  const cleanup = async () => {
    clearInterval(keepAlive);
    const session = activeSessions.get(transport.sessionId);
    if (session?.page) await session.page.close().catch(() => {});
    sessionsByResumeToken.delete(resumeToken);
    activeSessions.delete(transport.sessionId);
    await server.close().catch(() => {});
  };

  res.on("close", cleanup);

  await server.connect(transport);
};

app.get(["/", "/sse", "/message", "/messages"], authenticate, killSwitchGuard, sseHandler);

app.post(["/messages", "/message", "/sse", "/"], authenticate, killSwitchGuard, async (req, res) => {
  const sessionId = req.query.sessionId as string;
  if (!sessionId) return res.status(405).send("Method Not Allowed");

  const session = activeSessions.get(sessionId);
  if (!session) return res.status(400).json({ error: "Unknown session" });

  session.lastActivity = Date.now();

  try {
    await session.transport.handlePostMessage(req, res, req.body);
    if (WEBHOOK_URL) {
      const tool = (req.body as any)?.params?.name ?? "unknown";
      const action = (req.body as any)?.params?.arguments?.action ?? "";
      sendWebhook(tool, action, "completed").catch(() => {});
    }
  } catch {
    if (!res.headersSent) res.status(500).json({ error: "Handling error" });
  }
});

// ── Modern Streamable HTTP transport ────────────────────────
interface StreamableEntry { transport: StreamableHTTPServerTransport; server: McpServer; }
const streamableTransports = new Map<string, StreamableEntry>();

const streamableHandler = async (req: Request, res: Response) => {
  const sid = req.headers["mcp-session-id"] as string | undefined;
  const existing = sid ? streamableTransports.get(sid) : undefined;

  if (existing) {
    if (WEBHOOK_URL && req.method === "POST") {
      const tool = (req.body as any)?.params?.name ?? "unknown";
      const action = (req.body as any)?.params?.arguments?.action ?? "";
      sendWebhook(tool, action, "completed").catch(() => {});
    }
    return existing.transport.handleRequest(req, res, req.body);
  }

  // No session yet — create one (the client's first request is `initialize`).
  const server = createMcpServer(randomUUID());
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id: string) => { streamableTransports.set(id, { transport, server }); },
  });
  transport.onclose = () => {
    if (transport.sessionId) streamableTransports.delete(transport.sessionId);
    server.close().catch(() => {});
  };
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
};

app.all("/mcp", authenticate, killSwitchGuard, streamableHandler);

export function startServer() {
  return new Promise<void>((resolve, reject) => {
    const httpServer = app.listen(PORT, "0.0.0.0", () => {
      console.error(`🚀 Computer Access MCP started on http://localhost:${PORT}`);
      resolve();
    }).on("error", reject);

    async function gracefulShutdown(_signal: string) {
      for (const [, session] of activeSessions) {
        if (session.page) { try { await session.page.close(); } catch { /* */ } }
        try { await session.server.close(); } catch { /* */ }
      }
      await closeBrowser();
      httpServer.close(() => process.exit(0));
    }
    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().catch(() => process.exit(1));
}
