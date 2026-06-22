#!/usr/bin/env node
// email-verify MCP server (stdio transport) — entrypoint for `npx email-verify-mcp`.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { buildMcpServer } from "./mcpServer.js";

async function main() {
  const server = buildMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("email-verify MCP server running on stdio");
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
