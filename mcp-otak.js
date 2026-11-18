// Streamable HTTP MCP server exposing Otak (mem0 + MongoDB) tools to Pi / any MCP client.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { isOtakAuthorized, otakUnauthorized } from './otak-auth.js';
import { runMem0Operation, sanitizeOtakError } from './mem0-core.js';

const scopeShape = {
  userId: z.string().optional().describe('Scope memory ke user (user_id)'),
  agentId: z.string().optional().describe('Scope memory ke agent (agent_id)'),
  runId: z.string().optional().describe('Scope memory ke run/sesi (run_id)'),
};

const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const writeHint = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const deleteHint = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };

function textResult(data) {
  return { content: [{ type: 'text', text: JSON.stringify(data ?? { ok: true }, null, 2) }] };
}

function errorResult(err) {
  const code = err?.code ? `${err.code}: ` : '';
  return {
    isError: true,
    content: [{ type: 'text', text: `${code}${sanitizeOtakError(err)}` }],
  };
}

function tool(server, name, config, operation) {
  server.registerTool(name, config, async (args) => {
    try {
      return textResult(await runMem0Operation(operation, args));
    } catch (err) {
      return errorResult(err);
    }
  });
}

export function createOtakMcpServer() {
  const server = new McpServer(
    { name: 'otak-mem0', version: '1.0.0' },
    {
      instructions: [
        'Long-term memory (mem0 OSS) yang tersimpan di MongoDB Atlas.',
        'Simpan fakta penting dengan add_memory, cari dengan search_memories sebelum menjawab pertanyaan tentang riwayat/proyek.',
        'Selalu gunakan userId yang sama untuk scope yang sama (default Pi: gunakan "pi" atau nama project).',
      ].join(' '),
    },
  );

  tool(server, 'add_memory', {
    title: 'Simpan memory',
    description: 'Simpan satu atau beberapa percakapan/fakta ke mem0. Gunakan userId/agentId/runId untuk scope.',
    inputSchema: {
      ...scopeShape,
      text: z.string().optional().describe('Teks tunggal yang ingin diingat'),
      messages: z.array(z.object({
        role: z.string().optional(),
        content: z.string().optional(),
      })).optional().describe('Riwayat percakapan [{role, content}]'),
      metadata: z.record(z.any()).optional(),
      infer: z.boolean().optional().describe('true = biarkan mem0 mengekstrak fakta via LLM'),
    },
    annotations: writeHint,
  }, 'add_memory');

  tool(server, 'search_memories', {
    title: 'Cari memory',
    description: 'Pencarian semantic mem0 berdasarkan query, dengan filter scope opsional.',
    inputSchema: {
      query: z.string().describe('Apa yang ingin dicari'),
      topK: z.number().int().min(1).max(100).optional(),
      threshold: z.number().min(0).max(1).optional(),
      filters: z.record(z.any()).optional(),
      ...scopeShape,
    },
    annotations: readOnly,
  }, 'search_memories');

  tool(server, 'get_memories', {
    title: 'Daftar memory',
    description: 'Ambil semua memory dalam scope (userId/agentId/runId), opsional dibatasi topK.',
    inputSchema: { topK: z.number().int().min(1).max(200).optional(), filters: z.record(z.any()).optional(), ...scopeShape },
    annotations: readOnly,
  }, 'get_memories');

  tool(server, 'get_memory', {
    title: 'Ambil satu memory',
    description: 'Ambil detail memory berdasarkan memory_id.',
    inputSchema: { memoryId: z.string().describe('ID memory') },
    annotations: readOnly,
  }, 'get_memory');

  tool(server, 'update_memory', {
    title: 'Update memory',
    description: 'Ubah teks dan/atau metadata memory yang sudah ada.',
    inputSchema: {
      memoryId: z.string().describe('ID memory'),
      text: z.string().optional(),
      metadata: z.record(z.any()).optional(),
    },
    annotations: writeHint,
  }, 'update_memory');

  tool(server, 'delete_memory', {
    title: 'Hapus satu memory',
    description: 'Hapus satu memory berdasarkan memory_id.',
    inputSchema: { memoryId: z.string().describe('ID memory') },
    annotations: deleteHint,
  }, 'delete_memory');

  tool(server, 'delete_all_memories', {
    title: 'Hapus semua memory dalam scope',
    description: 'Hapus semua memory untuk userId / agentId / runId tertentu (wajib salah satu).',
    inputSchema: scopeShape,
    annotations: deleteHint,
  }, 'delete_all_memories');

  tool(server, 'memory_history', {
    title: 'Riwayat memory',
    description: 'Lihat riwayat perubahan sebuah memory.',
    inputSchema: { memoryId: z.string().describe('ID memory') },
    annotations: readOnly,
  }, 'memory_history');

  server.registerTool('mem0_status', {
    title: 'Status Otak',
    description: 'Cek konfigurasi mem0, koneksi MongoDB, dan tools yang tersedia.',
    inputSchema: {},
    annotations: readOnly,
  }, async () => {
    try {
      return textResult(await runMem0Operation('mem0_status', {}));
    } catch (err) {
      return errorResult(err);
    }
  });

  return server;
}

// Stateless streamable-HTTP handler. One transport per request, so no session state to keep.
export async function handleOtakMcpRequest(req, res) {
  if (!isOtakAuthorized(req)) return otakUnauthorized(res);

  const server = createOtakMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let closed = false;
  const cleanup = async () => {
    if (closed) return;
    closed = true;
    try { await transport.close(); } catch {}
    try { await server.close(); } catch {}
  };
  res.once('close', cleanup);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (err) {
    await cleanup();
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ error: 'mcp_error', message: sanitizeOtakError(err) }));
    }
  }
}
