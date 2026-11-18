import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import fs from "node:fs";
import path from "node:path";

const SERVER_NAME = "otak";

function readDotEnv(cwd: string): Record<string, string> {
  const values: Record<string, string> = {};
  const file = path.join(cwd, ".env");
  if (!fs.existsSync(file)) return values;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let value = m[2];
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[m[1]] = value;
  }
  return values;
}

function resolveOtak(cwd: string) {
  const env = { ...readDotEnv(cwd), ...process.env } as Record<string, string>;
  const url = env.OTAK_MCP_URL || `http://127.0.0.1:${env.PORT || "4173"}/mcp`;
  const token = env.OTAK_API_KEY || "";
  return {
    url,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    description: "Mem0 long-term memory (OSS + MongoDB Atlas) untuk project ini",
    exposure: "direct" as const,
    timeout: 120,
  };
}

function fileDefinesOtak(file: string): boolean {
  try {
    if (!fs.existsSync(file)) return false;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return Boolean(parsed?.mcpServers?.[SERVER_NAME]);
  } catch {
    return false;
  }
}

function hasMcpConfig(cwd: string): boolean {
  const agentDir = process.env.PI_AGENT_DIR || path.join(process.env.HOME || "", ".pi", "agent");
  return fileDefinesOtak(path.join(agentDir, "mcp.json")) || fileDefinesOtak(path.join(cwd, ".pi", "mcp.json"));
}

/** Pi extension "otak": registers the Otak MCP server and exposes /otak for status. */
export default function (pi: ExtensionAPI) {
  let registered = false;

  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;
    const cwd = ctx.cwd || process.cwd();
    // A user/project mcp.json entry wins; don't duplicate it.
    if (hasMcpConfig(cwd)) return;
    pi.registerMcpServer(SERVER_NAME, resolveOtak(cwd));
    registered = true;
  });

  pi.registerCommand("otak", {
    description: "Status Otak: koneksi MongoDB, konfigurasi mem0, dan MCP tools",
    handler: async (args, ctx) => {
      const cwd = ctx.cwd || process.cwd();
      const config = resolveOtak(cwd);
      const base = config.url.replace(/\/mcp\/?$/, "");

      if (String(args || "").trim() === "help") {
        const help = [
          "Otak = mem0 OSS + MongoDB Atlas, dipakai Pi lewat MCP.",
          "Tools MCP: mcp__otak__add_memory, search_memories, get_memories, get_memory,",
          "           update_memory, delete_memory, delete_all_memories, memory_history, mem0_status",
          "REST API:  POST /api/mem0/add, /api/mem0/search, GET /api/mem0/status (Bearer OTAK_API_KEY)",
          "Perintah:  /otak (status), /otak help (bantuan ini)",
        ].join("\n");
        if (ctx.hasUI) ctx.ui.notify(help, "info");
        else console.log(help);
        return;
      }

      try {
        const res = await fetch(`${base}/api/mem0/status`, {
          headers: config.headers,
          signal: AbortSignal.timeout(15000),
        });
        const data: any = await res.json();
        const lines = [
          `Otak: ${data.ready ? "READY" : "BELUM SIAP"}`,
          `mem0: ${data.config?.backend || "-"} | vector store: ${data.config?.vectorStore?.provider || "-"}`,
          `MongoDB: ${data.mongo?.ok ? `terhubung (${data.mongo.database})` : `gagal (${data.mongo?.error || "unknown"})`}`,
          `LLM: ${data.config?.llm?.provider}/${data.config?.llm?.model} (${data.config?.llm?.configured ? "configured" : "missing key"})`,
          data.config?.missing?.length ? `Kurang: ${data.config.missing.join(", ")}` : "",
          data.hint || "",
        ].filter(Boolean);
        if (ctx.hasUI) ctx.ui.notify(lines.join("\n"), data.ready ? "info" : "warning");
        else console.log(lines.join("\n"));
      } catch (err: any) {
        const message = `Gagal menghubungi Otak di ${config.url}: ${err?.message || err}`;
        if (ctx.hasUI) ctx.ui.notify(message, "error");
        else console.error(message);
      }
    },
  });
}
