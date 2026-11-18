// Otak = mem0 OSS memory service backed by MongoDB Atlas.
// This module is shared by the REST API in server.js and the MCP tools in mcp-otak.js.
import { Memory } from 'mem0ai/oss';
import { MongoClient } from 'mongodb';
import path from 'node:path';

const KEYLESS_PROVIDERS = new Set(['ollama', 'lmstudio']);

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : String(value).trim();
}

function bool(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return /^(1|true|yes)$/i.test(String(value));
}

export function sanitizeOtakError(err) {
  let message = err?.message || err?.error || String(err || 'unknown error');
  message = typeof message === 'string' ? message : JSON.stringify(message);
  const uri = str('MONGODB_URI');
  if (uri) message = message.split(uri).join('<mongodb-uri>');
  const password = str('MONGODB_PASSWORD');
  if (password) message = message.split(password).join('***');
  const apiKey = str('MEM0_LLM_API_KEY');
  if (apiKey) message = message.split(apiKey).join('***');
  return message.slice(0, 1200);
}

export function getOtakConfig() {
  const llmProvider = str('MEM0_LLM_PROVIDER', 'openai').toLowerCase();
  const embedderProvider = str('MEM0_EMBEDDER_PROVIDER', 'openai').toLowerCase();
  const llmKey = str('MEM0_LLM_API_KEY', str('OPENAI_API_KEY'));
  const embedderKey = str('MEM0_EMBEDDER_API_KEY', llmKey);
  const mongoUri = str('MONGODB_URI');
  const missing = [];
  if (!mongoUri) missing.push('MONGODB_URI');
  if (!KEYLESS_PROVIDERS.has(llmProvider) && !llmKey) missing.push('MEM0_LLM_API_KEY (atau OPENAI_API_KEY)');
  if (!KEYLESS_PROVIDERS.has(embedderProvider) && !embedderKey) missing.push('MEM0_EMBEDDER_API_KEY (atau MEM0_LLM_API_KEY)');

  return {
    backend: 'mem0 OSS (mem0ai)',
    vectorStore: {
      provider: 'mongodb',
      configured: !!mongoUri,
      database: str('MONGODB_DB_NAME', 'mem0'),
      collection: str('MONGODB_COLLECTION_NAME', 'mem0_memories'),
    },
    llm: {
      provider: llmProvider,
      model: str('MEM0_LLM_MODEL', 'gpt-4o-mini'),
      configured: !!llmKey || KEYLESS_PROVIDERS.has(llmProvider),
      baseURL: str('MEM0_LLM_BASE_URL') || null,
    },
    embedder: {
      provider: embedderProvider,
      model: str('MEM0_EMBEDDER_MODEL', 'text-embedding-3-small'),
      dimensions: Number(str('MEM0_EMBEDDING_DIMS', '1536')) || 1536,
      configured: !!embedderKey || KEYLESS_PROVIDERS.has(embedderProvider),
      baseURL: str('MEM0_EMBEDDER_BASE_URL', str('MEM0_LLM_BASE_URL')) || null,
    },
    historyDbPath: str('MEM0_HISTORY_DB', path.join('data', 'mem0-history.db')),
    ready: missing.length === 0,
    missing,
  };
}

export async function mongoPing(timeoutMs = 5000) {
  const uri = str('MONGODB_URI');
  if (!uri) return { ok: false, error: 'MONGODB_URI belum diisi' };
  let client;
  try {
    client = new MongoClient(uri, {
      appName: 'otak-health',
      serverSelectionTimeoutMS: timeoutMs,
      connectTimeoutMS: timeoutMs,
    });
    await client.connect();
    const db = client.db(str('MONGODB_DB_NAME', 'mem0'));
    await db.command({ ping: 1 });
    return { ok: true, database: db.databaseName };
  } catch (err) {
    return { ok: false, error: sanitizeOtakError(err) };
  } finally {
    try { await client?.close(); } catch {}
  }
}

export async function otakStatus() {
  const config = getOtakConfig();
  const mongo = await mongoPing();
  return {
    service: 'otak',
    ready: config.ready && mongo.ok,
    config,
    mongo,
    tools: OTAK_TOOLS,
    hint: config.ready
      ? 'Siap dipanggil lewat REST /api/mem0/* atau MCP tools mcp__otak__*.'
      : `Lengkapi ${config.missing.join(', ')} di .env lalu restart server.`,
  };
}

function requireReady() {
  const config = getOtakConfig();
  if (!config.ready) {
    const err = new Error(`Mem0 belum siap. Lengkapi ${config.missing.join(', ')} di .env lalu restart server.`);
    err.code = 'OTAK_NOT_READY';
    throw err;
  }
  return config;
}

let memory = null;
function getMemory() {
  requireReady();
  if (!memory) {
    const config = getOtakConfig();
    const llmConfig = {
      model: config.llm.model,
      ...(config.llm.baseURL ? { baseURL: config.llm.baseURL } : {}),
      ...(config.llm.configured && !KEYLESS_PROVIDERS.has(config.llm.provider)
        ? { apiKey: str('MEM0_LLM_API_KEY', str('OPENAI_API_KEY')) } : {}),
    };
    const embedderConfig = {
      model: config.embedder.model,
      embeddingDims: config.embedder.dimensions,
      ...(config.embedder.baseURL ? { baseURL: config.embedder.baseURL } : {}),
      ...(config.embedder.configured && !KEYLESS_PROVIDERS.has(config.embedder.provider)
        ? { apiKey: str('MEM0_EMBEDDER_API_KEY', str('MEM0_LLM_API_KEY', str('OPENAI_API_KEY'))) } : {}),
    };
    memory = new Memory({
      version: 'v1.1',
      llm: { provider: config.llm.provider, config: llmConfig },
      embedder: { provider: config.embedder.provider, config: embedderConfig },
      vectorStore: {
        provider: 'mongodb',
        config: {
          url: str('MONGODB_URI'),
          dbName: config.vectorStore.database,
          collectionName: config.vectorStore.collection,
          embeddingModelDims: config.embedder.dimensions,
        },
      },
      historyDbPath: config.historyDbPath,
    });
  }
  return memory;
}

function scope(args = {}) {
  const result = {};
  if (args.userId || args.user_id) result.userId = String(args.userId || args.user_id);
  if (args.agentId || args.agent_id) result.agentId = String(args.agentId || args.agent_id);
  if (args.runId || args.run_id) result.runId = String(args.runId || args.run_id);
  return result;
}

function filters(args = {}) {
  const result = { ...(args.filters && typeof args.filters === 'object' ? args.filters : {}) };
  const s = scope(args);
  if (s.userId) result.user_id = s.userId;
  if (s.agentId) result.agent_id = s.agentId;
  if (s.runId) result.run_id = s.runId;
  return result;
}

function normalizeMessages(input) {
  if (typeof input === 'string') return input;
  if (Array.isArray(input)) {
    return input.map((item) => {
      if (typeof item === 'string') return { role: 'user', content: item };
      if (!item || typeof item !== 'object') throw new Error('Setiap message harus string atau objek {role, content}');
      const role = String(item.role || 'user');
      const content = item.content ?? item.text ?? '';
      if (!content) throw new Error('Message tidak boleh kosong');
      return { role, content };
    });
  }
  if (input && typeof input === 'object') return normalizeMessages([input]);
  return input;
}

function requireMemoryId(args) {
  const id = args.memoryId || args.memory_id || args.id;
  if (!id) throw new Error('memoryId wajib diisi');
  return String(id);
}

export const OTAK_TOOLS = [
  'add_memory', 'search_memories', 'get_memories', 'get_memory',
  'update_memory', 'delete_memory', 'delete_all_memories', 'memory_history', 'mem0_status',
];

// Single entry point used by both REST and MCP.
export async function runMem0Operation(operation, args = {}) {
  switch (operation) {
    case 'add_memory': {
      const messages = normalizeMessages(args.messages ?? args.text ?? args.message ?? args.content);
      if (!messages || (Array.isArray(messages) && messages.length === 0)) {
        throw new Error('Isi messages atau text wajib diisi');
      }
      const options = {
        ...scope(args),
        ...(args.metadata ? { metadata: args.metadata } : {}),
        ...(args.infer !== undefined ? { infer: !!args.infer } : {}),
        ...(args.filters ? { filters: args.filters } : {}),
      };
      return getMemory().add(messages, options);
    }
    case 'search_memories': {
      if (!args.query || typeof args.query !== 'string') throw new Error('query wajib diisi');
      const options = { filters: filters(args) };
      if (args.topK !== undefined) options.topK = Number(args.topK);
      if (args.threshold !== undefined) options.threshold = Number(args.threshold);
      if (args.rerank !== undefined) options.rerank = !!args.rerank;
      return getMemory().search(args.query, options);
    }
    case 'get_memories': {
      const options = { filters: filters(args) };
      if (args.topK !== undefined) options.topK = Number(args.topK);
      return getMemory().getAll(options);
    }
    case 'get_memory':
      return getMemory().get(requireMemoryId(args));
    case 'update_memory': {
      const payload = {};
      if (args.text === undefined && args.data === undefined && !args.metadata) {
        throw new Error('text atau metadata wajib diisi');
      }
      if (args.text !== undefined) payload.text = String(args.text);
      else if (args.data !== undefined) payload.data = String(args.data);
      if (args.metadata) payload.metadata = args.metadata;
      return getMemory().update(requireMemoryId(args), payload);
    }
    case 'delete_memory':
      return getMemory().delete(requireMemoryId(args));
    case 'delete_all_memories': {
      const s = scope(args);
      if (!s.userId && !s.agentId && !s.runId) {
        throw new Error('delete_all_memories butuh salah satu dari userId / agentId / runId');
      }
      return getMemory().deleteAll(s);
    }
    case 'memory_history':
      return getMemory().history(requireMemoryId(args));
    case 'mem0_status':
      return otakStatus();
    default:
      throw new Error(`Operasi tidak dikenal: ${operation}`);
  }
}
