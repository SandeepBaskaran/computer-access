/**
 * ============================================================================
 * COMPUTER ACCESS MCP - MASTER ORCHESTRATOR
 * ============================================================================
 * This file replaces the legacy Bash scripts. It is a pure Node.js bootstrapper
 * that ensures cross-platform compatibility (Windows, macOS, Linux).
 * 
 * Responsibilities:
 * 1. Load environment variables.
 * 2. Boot the Express MCP Server.
 * 3. Dynamically discover Ngrok Auth Tokens (or load from .env).
 * 4. Bind the Ngrok tunnel to the local Express port and print the connection URL.
 */
import ngrok from "@ngrok/ngrok";
import { startServer } from "./server.js";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import os from "os";

// Resolve the __dirname context even when compiled to ES Modules
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env explicitly from the project root
dotenv.config({ path: path.resolve(__dirname, "../.env") });

async function boot() {
  console.log("🚀 Starting Computer Access MCP...");

  const PORT = parseInt(process.env.PORT || "8123", 10);
  const DOMAIN = process.env.NGROK_DOMAIN;

  try {
    // 1. Start the actual Express MCP Server logic (which registers the tools)
    await startServer();
  } catch (error) {
    console.error("❌ Failed to start local server:", error);
    process.exit(1);
  }

  try {
    // 2. Start Ngrok Tunnel
    // Ngrok is required to pipe the local localhost:8123 environment directly into the
    // SSE stream required by cloud-based MCP clients.
    console.log("📡 Initializing Ngrok HTTPS tunnel...");
    
    // Attempt automatic discovery of ngrok authtoken if not explicitly provided in .env
    // This allows seamless zero-config boots for developers who already use Ngrok system-wide.
    let token = process.env.NGROK_AUTHTOKEN;
    if (!token) {
      const configPaths = [
        path.join(os.homedir(), "Library/Application Support/ngrok/ngrok.yml"),
        path.join(os.homedir(), ".config/ngrok/ngrok.yml")
      ];
      for (const cp of configPaths) {
        try {
          const yaml = await fs.readFile(cp, "utf-8");
          const match = yaml.match(/(?:authtoken|token):\s*([A-Za-z0-9_]+)/);
          if (match) {
            token = match[1];
            break;
          }
        } catch { /* Ignore missing files */ }
      }
    }

    // Configure Ngrok
    const ngrokOptions: any = { addr: PORT };
    if (DOMAIN) ngrokOptions.domain = DOMAIN;
    if (token) ngrokOptions.authtoken = token;

    const listener = await ngrok.forward(ngrokOptions);
    const url = listener.url();

    console.log(`\n==================================================`);
    console.log(`✅ COMPUTER ACCESS MCP READY`);
    console.log(`==================================================\n`);
    console.log(`🔗 CONNECTION URL (paste into your MCP client's connector settings):`);
    console.log(`\x1b[36m${url}/sse\x1b[0m\n`);
    
    const authToken = process.env.BRIDGE_AUTH_TOKEN || process.env.MCP_TOKEN;
    if (authToken) {
      console.log(`🔑 AUTHORIZATION HEADER:`);
      console.log(`Bearer ${authToken}\n`);
    }

    console.log(`==================================================`);
    console.log(`Watching for incoming agent requests...`);
    console.log(`Press CTRL+C to stop.`);
    console.log(`==================================================\n`);

    // Monitor tunnel health — auto-reconnect after 3 consecutive failures
    let consecutiveFailures = 0;
    let currentUrl = url;
    let currentListener = listener;

    const tunnelHealthCheck = setInterval(async () => {
      try {
        const resp = await fetch(`${currentUrl}/health`, {
          signal: AbortSignal.timeout(10000),
          headers: process.env.MCP_TOKEN ? { 'Authorization': `Bearer ${process.env.MCP_TOKEN}` } : {}
        });
        if (!resp.ok) {
          consecutiveFailures++;
          console.error(`[TUNNEL] Health check returned ${resp.status} (failure ${consecutiveFailures}/3)`);
        } else {
          consecutiveFailures = 0;
        }
      } catch (err: any) {
        consecutiveFailures++;
        console.error(`[TUNNEL] Health check failed: ${err.message} (failure ${consecutiveFailures}/3)`);
      }

      if (consecutiveFailures >= 3) {
        console.error(`[TUNNEL] 3 consecutive failures — attempting tunnel reconnect...`);
        consecutiveFailures = 0;
        try {
          await currentListener.close();
        } catch { /* ignore close errors */ }
        try {
          const newOptions: any = { addr: PORT };
          if (DOMAIN) newOptions.domain = DOMAIN;
          if (token) newOptions.authtoken = token;
          currentListener = await ngrok.forward(newOptions);
          currentUrl = currentListener.url()!;
          console.log(`[TUNNEL] Reconnected → ${currentUrl}/sse`);
        } catch (reconnectErr: any) {
          console.error(`[TUNNEL] Reconnect failed: ${reconnectErr.message}`);
        }
      }
    }, 30000);
    tunnelHealthCheck.unref();

  } catch (error: any) {
    console.error("\n❌ Error starting Ngrok tunnel.");
    if (error.message && error.message.includes("ERR_NGROK_108")) {
      console.error("   ACCOUNT LIMIT: You have another ngrok session running.");
      console.error("   Please run 'killall ngrok' or close your other terminal window and try again.");
    } else {
      console.error(error);
    }
    process.exit(1);
  }
}

// Global cleanup handlers
process.on("SIGINT", async () => {
  await ngrok.disconnect();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await ngrok.disconnect();
  process.exit(0);
});

boot();
