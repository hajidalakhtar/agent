// Smoke test for Otak REST + MCP. Does not require an LLM key.
import fs from 'node:fs';

const envText = fs.readFileSync(new URL('../.env', import.meta.url), 'utf8');
function envValue(name) {
  const match = envText.match(new RegExp(`^\\s*${name}\\s*=\\s*(.*?)\\s*$`, 'm'));
  let value = match?.[1] || '';
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

const port = process.env.PORT || envValue('PORT') || '4173';
const key = process.env.OTAK_API_KEY || envValue('OTAK_API_KEY');
const base = `http://127.0.0.1:${port}`;
const headers = { Authorization: `Bearer ${key}` };

const statusRes = await fetch(`${base}/api/mem0/status`, { headers });
const status = await statusRes.json();
console.log(`REST /api/mem0/status: HTTP ${statusRes.status}, ready=${status.ready}`);
console.log(`  Mongo: ${status.mongo?.ok ? `connected (${status.mongo.database})` : status.mongo?.error}`);
console.log(`  Missing config: ${status.config?.missing?.join(', ') || '-'}`);

const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const client = new Client({ name: 'otak-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers } });
await client.connect(transport);
const tools = await client.listTools();
console.log(`MCP /mcp: connected, ${tools.tools.length} tools`);
console.log(`  ${tools.tools.map((t) => t.name).join(', ')}`);
await client.close();

if (statusRes.status !== 200 || tools.tools.length === 0) process.exit(1);
