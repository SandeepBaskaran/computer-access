// Shared tool types. Each tool module exports a register function that takes
// this `Register` (the guarded registrar built in server.ts) plus the session id.
import type { z } from "zod";

export type ToolConfig = {
  title: string;
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
};

export type ToolResult = { content: Array<{ type: "text"; text: string }> };

export type Register = (
  name: string,
  config: ToolConfig,
  handler: (args: any) => Promise<ToolResult>,
) => void;
