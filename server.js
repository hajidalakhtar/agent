import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { execSync, execFile } from 'node:child_process';
import { handleOtakMcpRequest } from './mcp-otak.js';
import { getOtakConfig, runMem0Operation, otakStatus, sanitizeOtakError } from './mem0-core.js';
import { isOtakAuthorized, otakUnauthorized } from './otak-auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env (simple)
try {
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let value = m[2];
      // .env values may be quoted (e.g. MongoDB Atlas URI)
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  }
} catch {}

const PORT = parseInt(process.env.PORT || '4173', 10);
const HOST = process.env.HOST || '0.0.0.0';
const INSTABOX_API_URL = process.env.INSTABOX_API_URL || 'https://api.instabox.sh';
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || ''; // legacy fallback
const DIST_DIR = path.join(__dirname, 'dist');
const DATA_DIR = path.join(__dirname, 'data');
const WEBHOOKS_STATE_PATH = path.join(DATA_DIR, 'webhooks.json');
const WEBHOOK_EVENTS = [
  'sandbox.created','sandbox.started','sandbox.stopped','sandbox.suspended','sandbox.error','sandbox.deleted',
  'snapshot.created','snapshot.failed','snapshot.deleted',
];
const WEBHOOK_ENDPOINT_PATH = '/webhook/instabox';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}

// VNC TCP bridge ports per sandbox (Tailscale-accessible RFB/VNC, dynamic for all Instabox sandboxes)
const VNC_TCP_BASE_PORT = parseInt(process.env.VNC_TCP_BASE_PORT || '15901', 10);
let VNC_TCP_RUNTIME_DISABLED = /^(1|true|yes)$/i.test(String(process.env.VNC_TCP_DISABLED || ''));
let VNC_RUNTIME_DISABLED = /^(1|true|yes)$/i.test(String(process.env.VNC_DISABLED || ''));
const VNC_TCP_PORTS = {}; // lowercased name -> port
const vncTcpServers = new Map(); // lowercased name -> { port, server, machineId }

function getVncTcpPort(name) {
  if (!name) return null;
  const key = String(name).toLowerCase();
  return VNC_TCP_PORTS[key] != null ? VNC_TCP_PORTS[key] : null;
}

function stopAllVnc(reason = 'stopped', { emit = true } = {}) {
  let closedSessions = 0;
  for (const machineId of [...activeVnc.keys()]) { closeActiveVnc(machineId, reason); closedSessions++; }
  let closedServers = 0;
  for (const [key, srv] of [...vncTcpServers.entries()]) {
    try { srv.server.close(); } catch {}
    vncTcpServers.delete(key);
    delete VNC_TCP_PORTS[key];
    closedServers++;
  }
  if (emit && (closedSessions || closedServers || reason === 'manual_stop')) {
    pushEvent({ type: 'vnc_stopped_all', reason, closedSessions, closedServers });
  }
  return { ok: true, closedSessions, closedServers, tcpDisabled: VNC_TCP_RUNTIME_DISABLED, vncDisabled: VNC_RUNTIME_DISABLED };
}
function getTailscaleIpSync() {
  if (process.env.TAILSCALE_IP) return String(process.env.TAILSCALE_IP).trim();
  try { return execSync('tailscale ip -4 2>/dev/null', { encoding: 'utf8', timeout: 1500 }).trim().split(/\s+/)[0] || ''; } catch {}
  try {
    const out = execSync("ip -4 addr show tailscale0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1", { encoding: 'utf8', timeout: 1500 }).trim();
    if (out) return out.split(/\s+/)[0];
  } catch {}
  return '';
}
function vncTailscaleInfo(name) {
  const tcpPort = getVncTcpPort(name);
  const tsIp = getTailscaleIpSync();
  return {
    tailscaleIp: tsIp || null,
    httpBase: tsIp ? `http://${tsIp}:${PORT}` : null,
    wsProxy: `/vnc-proxy?name=${encodeURIComponent(name)}`,
    viewerUrl: `/vnc.html?name=${encodeURIComponent(name)}`,
    viewerRoute: `/vnc/${encodeURIComponent(name)}`,
    tcpVnc: tcpPort && tsIp ? `${tsIp}:${tcpPort}` : null,
    tcpVncPort: tcpPort,
  };
}

// --- VNC session manager ---
// Instabox VNC allows a single active upstream session per machine; extra connections get HTTP 409.
// We track the active downstream client per sandbox and close the previous one before opening a new upstream.
const activeVnc = new Map(); // key: machineId -> { kind, ws?, socket?, upstream, createdAt }

function closeActiveVnc(machineId, reason = 'replaced') {
  const cur = activeVnc.get(machineId);
  if (!cur) return;
  activeVnc.delete(machineId);
  try { cur.upstream?.close(1001, reason); } catch {}
  try { cur.ws?.close(4001, reason); } catch {}
  try { cur.socket?.destroy(); } catch {}
  pushEvent({ type: 'vnc_session_replaced', machineId, reason, kind: cur.kind, ageMs: Date.now() - (cur.createdAt||Date.now()) });
}

// Opens Instabox VNC websocket as documented:
// https://instabox.sh/docs/integrations/sdk-quickstart#open-the-vnc-websocket-from-node-js
// Uses ws client with required headers so WebSocket framing is handled correctly.
function connectUpstreamVnc(sb, { onOpen, onUnexpectedResponse, onError, onClose }) {
  const api = new URL(INSTABOX_API_URL || 'https://api.instabox.sh');
  const upstreamUrl = `${api.protocol === 'https:' ? 'wss:' : 'ws:'}//${api.host}/v1/machines/${sb.machineId}/vnc`;
  const upstream = new WebSocket(upstreamUrl, {
    headers: {
      'X-API-Key': sb.apiKey,
      'Authorization': `Bearer ${sb.apiKey}`,
    },
    handshakeTimeout: 12000,
  });
  let settled = false;
  upstream.on('open', () => { settled = true; onOpen?.(upstream, upstreamUrl); });
  upstream.on('unexpected-response', (req, res) => {
    settled = true;
    let body = '';
    try { res.on('data', c => body += c); res.on('end', () => {}); } catch {}
    onUnexpectedResponse?.(res.statusCode, upstream, upstreamUrl, body);
  });
  upstream.on('error', (e) => { if (!settled) settled = true; onError?.(e, upstream, upstreamUrl); });
  upstream.on('close', (code, reason) => onClose?.(code, reason, upstream, upstreamUrl));
  return { upstream, upstreamUrl };
}

const SSH_CONFIG_PATH = process.env.SSH_CONFIG_PATH || path.join(process.env.HOME || '/home/ubuntu', '.ssh', 'config');

function parseSshConfig(content) {
  const hosts = [];
  let cur = null;
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.replace(/#.*/, '').trim();
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'host') {
      const aliases = val.split(/\s+/).filter(a => a && !/[*?!]/.test(a));
      cur = { aliases, hostName: '', user: '', port: '', identityFile: '' };
      if (aliases.length) hosts.push(cur);
    } else if (cur) {
      if (key === 'hostname') cur.hostName = val;
      else if (key === 'user') cur.user = val;
      else if (key === 'port') cur.port = val;
      else if (key === 'identityfile') cur.identityFile = val;
    }
  }
  return hosts;
}

function parseSshDetailsFromCommand(ssh) {
  const s = String(ssh || '').trim();
  const out = { hostName: '', user: '', port: '', identityFile: '', hostAlias: '' };
  if (!s) return out;
  const parts = s.split(/\s+/).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p === '-p' && parts[i + 1]) { out.port = String(parts[++i]); continue; }
    if (p === '-i' && parts[i + 1]) { out.identityFile = String(parts[++i]); continue; }
    if (p.startsWith('-')) {
      // skip flags like -o Key=Val (consumes next token)
      if (p === '-o' || p === '-J' || p === '-l' || p === '-F') i++;
      continue;
    }
  }
  const target = parts.filter((p, idx) => !p.startsWith('-') && p !== 'ssh' && parts[idx - 1] !== '-p' && parts[idx - 1] !== '-i' && parts[idx - 1] !== '-o' && parts[idx - 1] !== '-J' && parts[idx - 1] !== '-l' && parts[idx - 1] !== '-F').pop() || '';
  if (target.includes('@')) {
    const at = target.lastIndexOf('@');
    out.user = target.slice(0, at);
    out.hostName = target.slice(at + 1);
  } else {
    out.hostName = target;
    out.hostAlias = target;
  }
  return out;
}

function readSshConfigText() {
  try { if (fs.existsSync(SSH_CONFIG_PATH)) return fs.readFileSync(SSH_CONFIG_PATH, 'utf8'); } catch {}
  return '';
}

function writeSshConfigText(content) {
  try { fs.mkdirSync(path.dirname(SSH_CONFIG_PATH), { recursive: true, mode: 0o700 }); } catch {}
  fs.writeFileSync(SSH_CONFIG_PATH, content, { mode: 0o600 });
}

function buildManagedSshBlock(name, details) {
  const alias = String(name || '').trim();
  const hostName = String(details.hostName || '').trim();
  if (!alias || !hostName) return '';
  const lines = [
    `# sandbox-manager:${alias} BEGIN`,
    `Host ${alias}`,
    `  HostName ${hostName}`,
  ];
  if (details.user) lines.push(`  User ${details.user}`);
  if (details.port) lines.push(`  Port ${details.port}`);
  if (details.identityFile) lines.push(`  IdentityFile ${details.identityFile}`);
  if (details.identityFile) lines.push(`  IdentitiesOnly yes`);
  lines.push('  StrictHostKeyChecking accept-new');
  lines.push('  UserKnownHostsFile ~/.ssh/known_hosts');
  lines.push(`# sandbox-manager:${alias} END`);
  return lines.join('\n') + '\n';
}

function resolveSshDetailsForSave(sb, existingHosts) {
  const name = String(sb.name || '').trim();
  if (!name) return null;
  const parsed = parseSshDetailsFromCommand(sb.ssh);
  const hosts = existingHosts || parseSshConfig(readSshConfigText());
  const existing = hosts.find(h => (h.aliases || []).some(a => a.toLowerCase() === name.toLowerCase()));
  const details = {
    hostName: parsed.hostName || '',
    user: parsed.user || '',
    port: parsed.port || '',
    identityFile: parsed.identityFile || '',
  };
  // If ssh command uses alias target (e.g. "ssh infra") try resolve from existing config
  if (parsed.hostAlias) {
    const ref = hosts.find(h => (h.aliases || []).some(a => a.toLowerCase() === parsed.hostAlias.toLowerCase()));
    if (ref) {
      details.hostName = details.hostName && details.hostName !== parsed.hostAlias ? details.hostName : (ref.hostName || '');
      details.user = details.user || ref.user || '';
      details.port = details.port || ref.port || '';
      details.identityFile = details.identityFile || ref.identityFile || '';
    }
  }
  // Merge with existing block/host for same alias to avoid losing fields on edit
  if (existing) {
    details.hostName = details.hostName || existing.hostName || '';
    details.user = details.user || existing.user || '';
    details.port = details.port || existing.port || '';
    details.identityFile = details.identityFile || existing.identityFile || '';
  }
  if (!details.hostName) return null;
  // If HostName ended up as alias itself and unresolved, skip
  if (details.hostName.toLowerCase() === name.toLowerCase() && !existing) return null;
  return details;
}

function syncManagedSshConfig(savedList) {
  const list = Array.isArray(savedList) ? savedList : [];
  const savedNames = new Set(list.map(s => String(s.name || '').toLowerCase()).filter(Boolean));
  let content = readSshConfigText();
  const hosts = parseSshConfig(content);
  const updated = [];
  const skipped = [];

  // Remove managed blocks that are no longer in saved config
  content = content.replace(/(^|\n)# sandbox-manager:([^\n]+?) BEGIN\n[\s\S]*?# sandbox-manager:\2 END\n?/g, (m, lead, name) => {
    return savedNames.has(String(name || '').toLowerCase()) ? m : (lead || '');
  });

  for (const sb of list) {
    const name = String(sb.name || '').trim();
    if (!name) continue;
    const details = resolveSshDetailsForSave(sb, hosts);
    if (!details) { skipped.push({ name, reason: 'no_host_details' }); continue; }
    const block = buildManagedSshBlock(name, details);
    if (!block) { skipped.push({ name, reason: 'empty_block' }); continue; }
    const re = new RegExp(`(^|\\n)# sandbox-manager:${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} BEGIN\\n[\\s\\S]*?# sandbox-manager:${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')} END\\n?`, 'i');
    if (re.test(content)) {
      content = content.replace(re, (m, lead) => (lead || '') + '\n' + block);
    } else {
      if (content && !content.endsWith('\n')) content += '\n';
      content += '\n' + block;
    }
    updated.push(name);
  }

  // Normalize extra blank lines lightly
  content = content.replace(/\n{3,}/g, '\n\n');
  if (content && !content.endsWith('\n')) content += '\n';
  writeSshConfigText(content);
  pushEvent({ type: 'ssh_config_synced', path: SSH_CONFIG_PATH, updated, skipped, savedCount: list.length });
  return { ok: true, path: SSH_CONFIG_PATH, updated, skipped };
}

function execFileAsyncSyncStyle(cmd, args, opts = {}) {
  return execFileAsync(cmd, args, opts);
}

async function syncHerdrMachines(savedList) {
  if (process.env.HERDR_ENV !== '1') return { ok: false, skipped: true, reason: 'not_in_herdr' };
  const list = Array.isArray(savedList) ? savedList : [];
  let existing = [];
  try {
    const r = await execFileAsync('herdr', ['machine', 'list', '--json'], { timeout: 8000 });
    if (r.ok) {
      const j = JSON.parse(r.stdout || '{}');
      existing = Array.isArray(j) ? j : (j.machines || j.items || j.profiles || []);
    }
  } catch {}
  const existingLabels = new Set(existing.map(m => String(m.label || m.name || '').toLowerCase()).filter(Boolean));
  const added = []; const errors = []; const skipped = [];
  for (const sb of list) {
    const name = String(sb.name || '').trim();
    if (!name) continue;
    if (existingLabels.has(name.toLowerCase())) { skipped.push({ name, reason: 'already_exists' }); continue; }
    // Use SSH alias (written to config) as target
    try {
      const r = await execFileAsync('herdr', ['machine', 'add', name, '--label', name], { timeout: 120000, maxBuffer: 1024 * 512 });
      if (r.ok) added.push(name);
      else errors.push({ name, error: (r.stderr || r.stdout || r.error || 'failed').toString().slice(-300) });
    } catch (e) {
      errors.push({ name, error: String(e.message || e).slice(-300) });
    }
  }
  const result = { ok: errors.length === 0, added, errors, skipped };
  pushEvent({ type: 'herdr_machines_synced', ...result });
  return result;
}


function loadSshConfigHosts() {
  try {
    if (!fs.existsSync(SSH_CONFIG_PATH)) return [];
    return parseSshConfig(fs.readFileSync(SSH_CONFIG_PATH, 'utf8'));
  } catch { return []; }
}

function isInstaboxHost(h) {
  if (!h) return false;
  const hn = String(h.hostName || '').toLowerCase();
  const user = String(h.user || '').toLowerCase();
  return hn === 'ssh.instabox.sh' || user.startsWith('ibssh_');
}

function hostToSshCommand(h) {
  if (!h) return '';
  if (h.aliases && h.aliases[0]) return `ssh ${h.aliases[0]}`;
  return sshHostToCommand(h);
}

function parseSshCommand(ssh) {
  const s = String(ssh || '').trim();
  const r = { hostName: '', user: '', port: '', hostAlias: '' };
  if (!s) return r;
  // ssh [-p port] [user@]host
  const pm = s.match(/(?:^|\s)-p\s+(\d+)/);
  if (pm) r.port = pm[1];
  // last token that looks like target
  const parts = s.split(/\s+/).filter(Boolean);
  const target = parts.filter(p => !p.startsWith('-') && p !== 'ssh' && p !== r.port && parts[parts.indexOf(p)-1] !== '-p').pop() || '';
  if (target.includes('@')) { const [u,h] = target.split('@'); r.user = u; r.hostName = h; }
  else { r.hostName = target; r.hostAlias = target; }
  return r;
}

function sshHostToCommand(h) {
  if (!h) return '';
  if (h.aliases && h.aliases[0]) return `ssh ${h.aliases[0]}`;
  const host = h.hostName || '';
  const user = h.user ? `${h.user}@` : '';
  const port = h.port && String(h.port) !== '22' ? `-p ${h.port} ` : '';
  return host ? `ssh ${port}${user}${host}`.replace(/\s+/g,' ').trim() : '';
}

function rawSshCommandFromHost(h, fallbackAlias) {
  if (!h) return fallbackAlias ? `ssh ${fallbackAlias}` : '';
  const host = h.hostName || '';
  if (!host) return fallbackAlias ? `ssh ${fallbackAlias}` : (h.aliases && h.aliases[0] ? `ssh ${h.aliases[0]}` : '');
  const user = h.user ? `${h.user}@` : '';
  const port = h.port && String(h.port) !== '22' ? `-p ${h.port} ` : '';
  const ident = h.identityFile ? `-i ${h.identityFile} ` : '';
  return `ssh ${ident}${port}${user}${host}`.replace(/\s+/g, ' ').trim();
}

function resolveSshForSandbox(sb, hosts) {
  const name = String(sb.name || '').toLowerCase();
  const parsed = parseSshCommand(sb.ssh);
  // 1) exact alias match to sandbox name
  let match = hosts.find(h => (h.aliases || []).some(a => a.toLowerCase() === name));
  // 2) match by same HostName+User(+Port) as existing ssh
  if (!match && (parsed.user || parsed.hostName)) {
    match = hosts.find(h =>
      h.hostName && parsed.hostName && h.hostName.toLowerCase() === parsed.hostName.toLowerCase() &&
      (!parsed.user || (h.user || '').toLowerCase() === parsed.user.toLowerCase()) &&
      (!parsed.port || !h.port || String(h.port) === String(parsed.port))
    );
  }
  // 3) match by alias token inside ssh command
  if (!match && parsed.hostAlias) {
    match = hosts.find(h => (h.aliases || []).some(a => a.toLowerCase() === parsed.hostAlias.toLowerCase()));
  }
  if (match) {
    const alias = match.aliases[0] || '';
    // Display/API: raw ssh command (bukan alias). Execution uses sshHost/alias.
    const raw = rawSshCommandFromHost(match, alias);
    return { ssh: raw || sshHostToCommand(match), sshHost: alias, sshUser: match.user || '', sshHostName: match.hostName || '', sshPort: match.port || '' };
  }
  return null;
}

function enrichSandboxWithSsh(sb, hosts) {
  const h = hosts || loadSshConfigHosts();
  const resolved = resolveSshForSandbox(sb, h);
  if (resolved && resolved.ssh) return { ...sb, ...resolved };
  return { ...sb };
}

function enrichSandboxes(list) {
  const hosts = loadSshConfigHosts();
  return (list || []).map(sb => enrichSandboxWithSsh(sb, hosts));
}

function getAllManagedEntries() {
  const hosts = loadSshConfigHosts();
  const configured = enrichSandboxes(parseSandboxesRaw(process.env.SANDBOXES || ''));
  const byName = new Map(configured.map(s => [String(s.name || '').toLowerCase(), { ...s }]));

  // Ensure every SSH config host appears. Saved config entries keep their chosen provider/type;
  // hosts only in ~/.ssh/config are auto-added as status-only entries.
  for (const h of hosts) {
    const alias = (h.aliases || [])[0];
    if (!alias) continue;
    const key = alias.toLowerCase();
    const detectedInstabox = isInstaboxHost(h);
    const existing = byName.get(key);
    const sshCmd = rawSshCommandFromHost(h, alias);
    const sshAliasCmd = hostToSshCommand(h);
    if (existing) {
      // Prefer raw ssh command for display/API (agent.hajid.dev), keep alias in sshHost for execution
      existing.ssh = sshCmd || existing.ssh || sshAliasCmd;
      existing.sshHost = existing.sshHost || alias;
      existing.sshHostName = existing.sshHostName || h.hostName || '';
      existing.sshUser = existing.sshUser || h.user || '';
      existing.sshPort = existing.sshPort || h.port || '';
      // Respect saved provider/type; only infer if missing
      if (!existing.provider) existing.provider = (existing.isInstabox === false ? 'ssh' : (detectedInstabox || existing.apiKey ? 'instabox' : 'ssh'));
      existing.isInstabox = existing.provider !== 'ssh';
      existing.fromSshConfig = true;
      existing.saved = true;
    } else {
      byName.set(key, {
        name: alias,
        apiKey: '',
        machineId: '',
        ssh: sshCmd || sshAliasCmd,
        sshHost: alias,
        sshUser: h.user || '',
        sshHostName: h.hostName || '',
        sshPort: h.port || '',
        isInstabox: detectedInstabox,
        provider: detectedInstabox ? 'instabox' : 'ssh',
        fromSshConfig: true,
        saved: false,
      });
    }
  }

  // Mark any configured entries not in ssh config
  for (const sb of byName.values()) {
    if (sb.provider === 'ssh') sb.isInstabox = false;
    else if (sb.provider === 'instabox') sb.isInstabox = true;
    if (sb.isInstabox == null) sb.isInstabox = !!(sb.apiKey && sb.machineId);
    if (!sb.provider) sb.provider = sb.isInstabox ? 'instabox' : 'ssh';
    if (sb.provider === 'ssh') sb.isInstabox = false;
    if (!sb.fromSshConfig) sb.fromSshConfig = false;
    if (sb.saved == null) sb.saved = !sb.fromSshConfig; // in config but not from ssh config
  }

  return [...byName.values()];
}

function parseSandboxesRaw(raw) {
  return (raw || '').split(',').map(s => s.trim()).filter(Boolean).map(entry => {
    const [name, apiKey, machineId, ssh, provider] = entry.split('|');
    const prov = (provider || (apiKey ? 'instabox' : 'ssh')).trim().toLowerCase();
    return { name: name || '', apiKey: apiKey || '', machineId: machineId || '', ssh: ssh || '', provider: prov === 'ssh' ? 'ssh' : 'instabox' };
  }).filter(s => s.name && (s.provider === 'ssh' || s.apiKey));
}
function parseSandboxes() { return getAllManagedEntries(); }
let SANDBOXES = parseSandboxes();
let sandboxById = new Map();
let sandboxByName = new Map();
function startVncTcpBridgeForSandbox(sb) {
  if (VNC_TCP_RUNTIME_DISABLED) return;
  const key = String(sb.name || '').toLowerCase();
  const port = VNC_TCP_PORTS[key];
  if (!key || !port || !sb.machineId) return;
  const existing = vncTcpServers.get(key);
  if (existing) {
    if (existing.port === port && existing.machineId === sb.machineId) return; // already running correctly
    try { existing.server.close(); } catch {}
    vncTcpServers.delete(key);
  }
  const tcpServer = net.createServer((socket) => {
    const curSb = sandboxByName.get(key);
    if (!curSb || !curSb.machineId) { try { socket.destroy(); } catch {} return; }
    closeActiveVnc(curSb.machineId, 'replaced-by-tcp-realvnc');
    pushEvent({ type: 'vnc_tcp_connect', sandbox: curSb.name, port, machineId: curSb.machineId });
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return; cleaned = true;
      const cur = activeVnc.get(curSb.machineId);
      if (cur && cur.socket === socket) activeVnc.delete(curSb.machineId);
      try { socket.destroy(); } catch {}
    };
    const { upstream } = connectUpstreamVnc(curSb, {
      onOpen: (up, upUrl) => {
        activeVnc.set(curSb.machineId, { kind: 'tcp', socket, upstream: up, createdAt: Date.now() });
        pushEvent({ type: 'vnc_tcp_open', sandbox: curSb.name, upstreamUrl: upUrl });
        socket.on('data', (d) => { if (up.readyState === WebSocket.OPEN) up.send(d); });
        up.on('message', (d) => { if (!socket.destroyed) socket.write(Buffer.isBuffer(d) ? d : Buffer.from(d)); });
      },
      onUnexpectedResponse: (status, up, upUrl) => {
        pushEvent({ type: 'vnc_tcp_error', sandbox: curSb.name, status, error: `upstream HTTP ${status}${status===409?' (session conflict: close other VNC viewers/RealVNC and retry)':''}`, upstreamUrl: upUrl });
        try { up.terminate(); } catch {}
        cleanup();
      },
      onError: (e, up, upUrl) => {
        pushEvent({ type: 'vnc_tcp_error', sandbox: curSb.name, error: e.message, upstreamUrl: upUrl });
        cleanup();
      },
      onClose: () => cleanup(),
    });
    socket.on('error', () => { try { upstream.terminate(); } catch {} cleanup(); });
    socket.on('close', () => { try { upstream.terminate(); } catch {} cleanup(); });
  });
  tcpServer.on('error', (e) => {
    console.log(`[sandbox-manager] tcp bridge ${sb.name} error: ${e.message}`);
    pushEvent({ type: 'vnc_tcp_listen_error', sandbox: sb.name, port, error: e.message });
  });
  tcpServer.listen(port, HOST, () => {
    console.log(`[sandbox-manager] RealVNC TCP bridge ${sb.name}: ${HOST}:${port} -> ${sb.machineId}/vnc`);
    pushEvent({ type: 'vnc_tcp_listen', sandbox: sb.name, port, machineId: sb.machineId });
  });
  vncTcpServers.set(key, { port, server: tcpServer, machineId: sb.machineId });
}

function refreshVncTcpPorts() {
  if (VNC_TCP_RUNTIME_DISABLED) {
    stopAllVnc('tcp_disabled', { emit: false });
    for (const k of Object.keys(VNC_TCP_PORTS)) delete VNC_TCP_PORTS[k];
    return VNC_TCP_PORTS;
  }
  const instabox = SANDBOXES.filter(s => s.isInstabox && s.apiKey);
  // stable, unique port per sandbox name
  const used = new Set();
  const names = instabox.map(s => String(s.name || '').toLowerCase()).filter(Boolean).sort();
  for (const name of names) {
    let port = VNC_TCP_PORTS[name];
    if (!port || used.has(port)) {
      port = VNC_TCP_BASE_PORT;
      while (used.has(port)) port++;
      VNC_TCP_PORTS[name] = port;
    }
    used.add(port);
  }
  // remove ports for sandboxes no longer instabox
  for (const k of Object.keys(VNC_TCP_PORTS)) {
    if (!names.includes(k)) {
      delete VNC_TCP_PORTS[k];
      const srv = vncTcpServers.get(k);
      if (srv) { try { srv.server.close(); } catch {} vncTcpServers.delete(k); }
    }
  }
  // (re)start bridges for instabox sandboxes that have machineId
  for (const sb of instabox) {
    if (sb.machineId) startVncTcpBridgeForSandbox(sb);
  }
  return VNC_TCP_PORTS;
}

function rebuildSandboxMaps() {
  SANDBOXES = getAllManagedEntries();
  const instaboxOnly = SANDBOXES.filter(s => s.isInstabox && s.apiKey);
  sandboxById = new Map(instaboxOnly.filter(s => s.machineId).map(s => [s.machineId, s]));
  sandboxByName = new Map(SANDBOXES.map(s => [s.name.toLowerCase(), s]));
  try { refreshVncTcpPorts(); } catch (e) { console.log('[sandbox-manager] refreshVncTcpPorts error', e.message); }
}
rebuildSandboxMaps();

function savedSandboxesOnly() {
  // Read persisted app config entries from SANDBOXES env (without merging all ssh-config hosts as unsaved)
  return parseSandboxesRaw(process.env.SANDBOXES || '');
}

async function autoResolveInstaboxMachineIds(list, reason = 'auto') {
  const updated = (list || []).map(s => ({ ...s }));
  const resolved = [];
  const failed = [];
  let changed = false;
  const cache = new Map(); // apiKey -> machines[]

  for (const sb of updated) {
    if (!sb || sb.provider === 'ssh') continue;
    if (!sb.apiKey) continue;
    try {
      let machines = cache.get(sb.apiKey);
      if (!machines) {
        const r = await instaboxApiFetch(sb.apiKey, '/v1/machines');
        if (!r.ok) {
          failed.push({ name: sb.name, reason: r.data?.error?.message || r.data?.message || 'api_error', status: r.status });
          cache.set(sb.apiKey, []);
          continue;
        }
        machines = r.data?.machines || [];
        cache.set(sb.apiKey, machines);
      }

      const byId = sb.machineId ? machines.find(x => x.id === sb.machineId) : null;
      const byName = machines.find(x => String(x.name || '').toLowerCase() === String(sb.name || '').toLowerCase());
      let m = null;
      if (byName) m = byName; // prefer exact name match from API (source of truth)
      else if (byId) m = byId;
      else if (!sb.machineId && machines.length === 1) m = machines[0];

      if (m && m.id) {
        if (sb.machineId !== m.id) {
          const prev = sb.machineId || '';
          sb.machineId = m.id;
          changed = true;
          resolved.push({ name: sb.name, machineId: m.id, prev, machineName: m.name || null, source: byName ? 'name' : (byId ? 'id' : 'single') });
        }
      } else {
        failed.push({
          name: sb.name,
          reason: machines.length === 0 ? 'no_machines' : 'no_match',
          currentMachineId: sb.machineId || null,
          machines: machines.map(x => ({ id: x.id, name: x.name, state: x.state })),
        });
      }
    } catch (e) {
      failed.push({ name: sb.name, reason: e.message });
    }
  }

  if (resolved.length || failed.length || reason === 'api_sync' || reason === 'config_saved') {
    pushEvent({ type: 'machineid_synced_from_api', reason, changed, resolved, failed: failed.slice(0, 20) });
  }
  return { list: updated, changed, resolved, failed };
}

async function ensureTailscaleForSaved(list, reason = 'sync') {
  const authKey = (process.env.TAILSCALE_AUTHKEY || '').trim();
  const results = [];
  for (const sb of (list || [])) {
    const name = String(sb?.name || '').trim();
    if (!name) continue;
    try {
      const ip = await getRemoteTailscaleIp(sb, 6000);
      if (ip) { results.push({ name, ok: true, tailscaleIp: ip, status: 'present' }); continue; }
      if (!authKey) { results.push({ name, ok: false, status: 'missing', skipped: true, reason: 'no_authkey' }); continue; }
      const setup = await autoSetupTailscaleForSandbox(sb, `sync_${reason}`);
      let ipAfter = '';
      try { ipAfter = await getRemoteTailscaleIp(sb, 8000); } catch {}
      results.push({ name, ok: !!setup?.ok, status: ipAfter ? 'added' : (setup?.ok ? 'setup_triggered' : 'failed'), tailscaleIp: ipAfter || null, setup });
    } catch (e) {
      results.push({ name, ok: false, status: 'error', error: e.message });
    }
  }
  pushEvent({ type: 'tailscale_ensure_sync', reason, results });
  return { ok: results.every(r => r.ok || r.skipped), results };
}

async function syncSshWithApp(reason = 'manual') {
  // Bidirectional-ish sync between ~/.ssh/config and app config (agent.hajid.dev):
  // 1) Ensure every SSH config host exists in saved app config (so it appears/tersimpan di agent.hajid.dev)
  // 2) Persist merged saved config
  // 3) Write/update managed blocks in ~/.ssh/config for all saved entries
  const hosts = loadSshConfigHosts();
  const saved = savedSandboxesOnly();
  const byName = new Map(saved.map(s => [String(s.name || '').toLowerCase(), { ...s }]));
  let imported = 0;

  for (const h of hosts) {
    const alias = (h.aliases || [])[0];
    if (!alias) continue;
    const key = alias.toLowerCase();
    const detectedInstabox = isInstaboxHost(h);
    const raw = rawSshCommandFromHost(h, alias);
    const existing = byName.get(key);
    if (existing) {
      // Keep saved data, but ensure ssh/provider sane
      existing.ssh = raw || existing.ssh || hostToSshCommand(h);
      if (!existing.provider) existing.provider = (existing.isInstabox === false ? 'ssh' : (detectedInstabox || existing.apiKey ? 'instabox' : 'ssh'));
      if (existing.provider === 'ssh') { existing.apiKey = existing.apiKey || ''; existing.machineId = existing.machineId || ''; }
    } else {
      byName.set(key, {
        name: alias,
        apiKey: '',
        machineId: '',
        ssh: raw || hostToSshCommand(h),
        provider: detectedInstabox ? 'instabox' : 'ssh',
      });
      imported++;
    }
  }

  let merged = [...byName.values()].map(s => {
    const provider = (String(s.provider||'').toLowerCase() === 'ssh' || s.isInstabox === false) ? 'ssh' : 'instabox';
    return {
      name: String(s.name || '').trim(),
      apiKey: String(s.apiKey || '').trim(),
      machineId: String(s.machineId || '').trim(),
      ssh: String(s.ssh || '').trim(),
      provider,
    };
  }).filter(s => s.name && (s.provider === 'ssh' || s.apiKey));

  // Auto-resolve machineId untuk sandbox Instabox (setiap API key -> cocokkan mesin by name/id)
  let machineIdAutoFill = { changed: false, resolved: [], failed: [] };
  try {
    machineIdAutoFill = await autoResolveInstaboxMachineIds(merged, reason);
    if (machineIdAutoFill.changed) merged = machineIdAutoFill.list;
  } catch (e) {
    machineIdAutoFill = { changed: false, resolved: [], failed: [], error: e.message };
    pushEvent({ type: 'machineid_auto_resolve_error', error: e.message, reason });
  }

  const savedPersisted = persistSandboxes(merged);
  let sshConfigSync = null;
  try { sshConfigSync = syncManagedSshConfig(savedPersisted || []); } catch (e) { sshConfigSync = { ok: false, error: e.message }; }
  rebuildSandboxMaps();
  // Cek Tailscale untuk semua host tersimpan; jika belum ada/terhubung, coba auto-setup
  let tailscaleEnsure = null;
  try { tailscaleEnsure = await ensureTailscaleForSaved(savedPersisted || [], reason); } catch (e) { tailscaleEnsure = { ok: false, error: e.message }; pushEvent({ type: 'tailscale_ensure_error', error: e.message }); }
  // Best-effort: masukkan mesin tersimpan ke Herdr (jika berjalan di dalam Herdr)
  let herdrSync = null;
  try { herdrSync = await syncHerdrMachines(savedPersisted || []); } catch (e) { herdrSync = { ok: false, error: e.message }; pushEvent({ type: 'herdr_machines_sync_error', error: e.message }); }
  pushEvent({ type: 'ssh_app_synced', reason, imported, total: (savedPersisted || []).length, sshConfigSync, tailscaleEnsure, herdrSync, machineIdAutoFill: { changed: machineIdAutoFill.changed, resolved: machineIdAutoFill.resolved, failed: machineIdAutoFill.failed } });
  return { ok: true, imported, total: (savedPersisted || []).length, sshConfigSync, tailscaleEnsure, herdrSync, machineIdAutoFill };
}

// Boot: sync antara ~/.ssh/config dan app (agent.hajid.dev) setiap start (termasuk cek/tambah tailscale)
syncSshWithApp('boot').catch(e => { try { pushEvent({ type: 'ssh_app_sync_boot_error', error: e.message }); } catch {} });

// --- Instabox webhook provisioning (per org/account, using each sandbox API key) ---
function loadWebhookState() {
  try { if (fs.existsSync(WEBHOOKS_STATE_PATH)) return JSON.parse(fs.readFileSync(WEBHOOKS_STATE_PATH, 'utf8')) || {}; } catch {}
  return {};
}
function saveWebhookState(state) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(WEBHOOKS_STATE_PATH, JSON.stringify(state, null, 2)); } catch (e) { console.error('[webhook-state] save failed', e.message); }
}
function getAutoReviveConfig() {
  const st = loadWebhookState();
  const map = (st && typeof st.autoRevive === 'object' && st.autoRevive) ? st.autoRevive : {};
  return map;
}
function isAutoReviveEnabled(name) {
  if (!name) return false;
  const map = getAutoReviveConfig();
  const key = String(name).toLowerCase();
  if (Object.prototype.hasOwnProperty.call(map, key)) return !!map[key];
  if (Object.prototype.hasOwnProperty.call(map, name)) return !!map[name];
  return true; // default: nyalakan saat mati
}
function setAutoReviveConfig(updates) {
  const st = loadWebhookState();
  st.autoRevive = (st.autoRevive && typeof st.autoRevive === 'object') ? st.autoRevive : {};
  for (const [k, v] of Object.entries(updates || {})) {
    if (!k) continue;
    st.autoRevive[String(k).toLowerCase()] = !!v;
  }
  saveWebhookState(st);
  return st.autoRevive;
}
function allWebhookSecrets() {
  const st = loadWebhookState();
  const out = new Set();
  if (WEBHOOK_SECRET) out.add(WEBHOOK_SECRET);
  for (const v of Object.values(st.orgs || {})) {
    if (v?.secret) out.add(v.secret);
    if (Array.isArray(v?.secrets)) v.secrets.filter(Boolean).forEach(x=>out.add(x));
  }
  return [...out];
}
function getPublicBaseUrl(req) {
  if (process.env.WEBHOOK_PUBLIC_URL) return String(process.env.WEBHOOK_PUBLIC_URL).replace(/\/$/, '');
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  if (req) {
    const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
    const host = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
    if (host) return `${proto}://${host}`;
  }
  const tsIp = (typeof getTailscaleIpSync === 'function') ? getTailscaleIpSync() : '';
  if (tsIp) return `http://${tsIp}:${PORT}`;
  return `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;
}
async function instaboxApiFetch(apiKey, pth, opts = {}) {
  const url = `${INSTABOX_API_URL}${pth}`;
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  if (method === 'POST' && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
    headers['Idempotency-Key'] = `sm-wh-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }
  const resp = await fetch(url, { ...opts, method, headers });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const ok = resp.ok || resp.status === 202;
  return { ok, status: resp.status, data };
}
function groupSandboxesByApiKey() {
  const m = new Map();
  for (const sb of SANDBOXES) {
    if (!sb.apiKey) continue;
    const k = sb.apiKey;
    if (!m.has(k)) m.set(k, { apiKey: k, sandboxes: [] });
    m.get(k).sandboxes.push({ name: sb.name, machineId: sb.machineId });
  }
  return [...m.values()];
}
async function inspectWebhookForApiKey(apiKey, desiredUrl) {
  const me = await instaboxApiFetch(apiKey, '/v1/me');
  if (!me.ok) return { ok: false, apiKeyHint: apiKey.slice(0,8)+'…', error: me.data, status: me.status };
  const orgId = me.data?.org?.id || me.data?.orgId;
  if (!orgId) return { ok: false, apiKeyHint: apiKey.slice(0,8)+'…', error: 'no orgId in /v1/me', me: me.data };
  const hooks = await instaboxApiFetch(apiKey, `/v1/orgs/${orgId}/webhooks`);
  const state = loadWebhookState();
  const saved = state.orgs?.[orgId];
  const items = hooks.ok ? (hooks.data?.items || []) : [];
  const match = desiredUrl ? items.find(h => h.url === desiredUrl) : (saved?.webhookId ? items.find(h => h.id === saved.webhookId) : null);
  return {
    ok: hooks.ok,
    orgId,
    org: me.data?.org || null,
    webhooksEnabled: !!me.data?.webhooksEnabled,
    desiredUrl,
    existing: match || null,
    endpoints: items.map(h => ({ id: h.id, url: h.url, enabled: h.enabled, events: h.events, disabledReason: h.disabledReason })),
    saved: saved ? { webhookId: saved.webhookId, url: saved.url, hasSecret: !!saved.secret, updatedAt: saved.updatedAt } : null,
    error: hooks.ok ? null : hooks.data,
  };
}
async function setupWebhookForApiKey(apiKey, publicBaseUrl, sandboxes) {
  const desiredUrl = `${String(publicBaseUrl).replace(/\/$/, '')}${WEBHOOK_ENDPOINT_PATH}`;
  if (!/^https?:\/\//i.test(desiredUrl)) return { ok: false, error: 'publicBaseUrl must be http(s) URL' };
  const insp = await inspectWebhookForApiKey(apiKey, desiredUrl);
  if (!insp.orgId) return { ok: false, sandboxes, error: insp.error || 'failed to resolve org', status: insp.status };
  if (insp.webhooksEnabled === false) return { ok: false, sandboxes, orgId: insp.orgId, org: insp.org, error: 'webhooks not enabled for this org/account' };
  // Instabox requires https public URL; warn but still allow attempt if user insists? better report clearly.
  if (/^http:\/\//i.test(desiredUrl) && !/localhost|127\.0\.0\.1|100\.\d+\.\d+\.\d+/.test(desiredUrl)) {
    // not blocking; Instabox will reject if not acceptable
  }
  let hook = insp.existing;
  let created = false;
  let secret = null;
  if (hook) {
    // ensure events/url/enabled
    const needUpdate = !hook.enabled || hook.url !== desiredUrl || !WEBHOOK_EVENTS.every(e => (hook.events||[]).includes(e));
    if (needUpdate) {
      const upd = await instaboxApiFetch(apiKey, `/v1/orgs/${insp.orgId}/webhooks/${hook.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ url: desiredUrl, events: WEBHOOK_EVENTS, enabled: true, description: 'sandbox-manager auto-revive' }),
      });
      if (upd.ok) hook = upd.data; else return { ok: false, sandboxes, orgId: insp.orgId, action: 'update', error: upd.data, status: upd.status, existing: hook };
    }
  } else {
    const cr = await instaboxApiFetch(apiKey, `/v1/orgs/${insp.orgId}/webhooks`, {
      method: 'POST',
      body: JSON.stringify({ url: desiredUrl, events: WEBHOOK_EVENTS, enabled: true, description: 'sandbox-manager auto-revive' }),
    });
    if (!cr.ok) return { ok: false, sandboxes, orgId: insp.orgId, action: 'create', error: cr.data, status: cr.status };
    hook = cr.data;
    created = true;
    secret = cr.data?.secret || null;
  }
  const state = loadWebhookState();
  state.orgs = state.orgs || {};
  const prev = state.orgs[insp.orgId] || {};
  state.orgs[insp.orgId] = {
    ...prev,
    orgId: insp.orgId,
    org: insp.org || prev.org || null,
    webhookId: hook?.id || prev.webhookId,
    url: desiredUrl,
    secret: secret || prev.secret || null,
    events: WEBHOOK_EVENTS,
    sandboxes: sandboxes.map(s=>s.name),
    updatedAt: new Date().toISOString(),
  };
  saveWebhookState(state);
  pushEvent({ type: created ? 'webhook_provisioned' : 'webhook_ensured', orgId: insp.orgId, webhookId: hook?.id, url: desiredUrl, sandboxes: sandboxes.map(s=>s.name) });
  return { ok: true, sandboxes, orgId: insp.orgId, org: insp.org, webhook: { id: hook?.id, url: hook?.url || desiredUrl, enabled: hook?.enabled, events: hook?.events }, created, secretReturned: !!secret };
}
async function getWebhooksStatus(req) {
  const groups = groupSandboxesByApiKey();
  const desiredUrl = `${getPublicBaseUrl(req).replace(/\/$/, '')}${WEBHOOK_ENDPOINT_PATH}`;
  const results = [];
  for (const g of groups) results.push({ sandboxes: g.sandboxes, apiKeyHint: g.apiKey.slice(0,8)+'…', ...(await inspectWebhookForApiKey(g.apiKey, desiredUrl)) });
  const autoRevive = {};
  for (const sb of SANDBOXES) autoRevive[sb.name] = isAutoReviveEnabled(sb.name);
  return { desiredUrl, publicBaseUrl: getPublicBaseUrl(req), groups: results, state: loadWebhookState(), autoRevive, note: 'Instabox requires a public https webhook URL. Set WEBHOOK_PUBLIC_URL (or pass publicBaseUrl) to a publicly reachable https://... endpoint that forwards to this server.' };
}

function serializeSandboxes(list) {
  return list.map(s => [s.name||'', s.apiKey||'', s.machineId||'', s.ssh||'', s.provider||''].join('|')).join(',');
}
function persistSandboxes(list) {
  const envPath = path.join(__dirname, '.env');
  let content = '';
  try { if (fs.existsSync(envPath)) content = fs.readFileSync(envPath, 'utf8'); } catch {}
  const line = `SANDBOXES=${serializeSandboxes(list)}`;
  if (/^SANDBOXES=.*$/m.test(content)) content = content.replace(/^SANDBOXES=.*$/m, line);
  else content = content.replace(/\s*$/, '\n') + line + '\n';
  fs.writeFileSync(envPath, content);
  process.env.SANDBOXES = serializeSandboxes(list);
  SANDBOXES = parseSandboxes();
  rebuildSandboxMaps();
  return SANDBOXES;
}

function persistDiscoveredMachineId(name, machineId, prev = '') {
  const saved = savedSandboxesOnly();
  const key = String(name || '').toLowerCase();
  const sb = saved.find(s => String(s.name || '').toLowerCase() === key);
  if (!sb || !machineId) return false;
  if (sb.machineId === machineId) return false;
  sb.machineId = machineId;
  persistSandboxes(saved);
  pushEvent({ type: 'machineid_persisted', sandbox: name, machineId, prev: prev || null });
  return true;
}

function getConfiguredWebhookBaseUrl() {
  if (process.env.WEBHOOK_PUBLIC_URL) return String(process.env.WEBHOOK_PUBLIC_URL).replace(/\/$/, '');
  if (process.env.PUBLIC_BASE_URL) return String(process.env.PUBLIC_BASE_URL).replace(/\/$/, '');
  const st = loadWebhookState();
  if (st && st.publicBaseUrl) return String(st.publicBaseUrl).replace(/\/$/, '');
  return '';
}

async function autoSetupWebhooksForCurrentConfig(reason = 'config_changed') {
  const base = getConfiguredWebhookBaseUrl();
  if (!/^https:\/\//i.test(base)) {
    pushEvent({ type: 'webhook_auto_setup_skipped', reason: 'no_public_https_base_url', hint: 'Set WEBHOOK_PUBLIC_URL/PUBLIC_BASE_URL atau setup webhook sekali dengan publicBaseUrl HTTPS.' });
    return { ok: false, skipped: true, reason: 'no_public_https_base_url' };
  }
  const groups = groupSandboxesByApiKey();
  if (groups.length === 0) return { ok: false, skipped: true, reason: 'no_sandboxes' };
  const st = loadWebhookState(); st.publicBaseUrl = base; saveWebhookState(st);
  const results = [];
  for (const g of groups) results.push(await setupWebhookForApiKey(g.apiKey, base, g.sandboxes));
  const ok = results.length > 0 && results.every(r => r.ok);
  pushEvent({ type: 'webhook_auto_setup', reason, ok, desiredUrl: `${base}${WEBHOOK_ENDPOINT_PATH}`, results: results.map(r => ({ ok: r.ok, orgId: r.orgId, sandboxes: (r.sandboxes||[]).map(s=>s.name), error: r.ok ? null : (r.error?.error?.message || r.error?.message || r.error) })) });
  return { ok, results };
}

// In-memory webhook/status events
const events = [];
const MAX_EVENTS = 200;
function pushEvent(evt) {
  events.unshift({ ...evt, at: new Date().toISOString() });
  if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
}

// Dedupe webhook events
const processedEvents = new Map();
const DEDUPE_TTL_MS = 15 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [id, ts] of processedEvents.entries()) if (now - ts > DEDUPE_TTL_MS) processedEvents.delete(id);
}, 5 * 60 * 1000);

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(body);
}

async function readOtakBody(req, maxBytes = 1024 * 1024) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) {
      const err = new Error('Body terlalu besar (maks 1 MB)');
      err.status = 413;
      throw err;
    }
  }
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Body harus JSON object');
    return parsed;
  } catch (err) {
    err.status = 400;
    err.message = `JSON tidak valid: ${err.message}`;
    throw err;
  }
}

function idempotencyKey(prefix = 'sm') {
  return `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`.slice(0, 120);
}

async function instaboxFetch(sb, path, opts = {}) {
  const url = `${INSTABOX_API_URL}${path}`;
  const method = (opts.method || 'GET').toUpperCase();
  const headers = {
    'Authorization': `Bearer ${sb.apiKey}`,
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  // Instabox requires Idempotency-Key for mutating POST actions (start/stop/resume/suspend etc.)
  if (method === 'POST' && !headers['Idempotency-Key'] && !headers['idempotency-key']) {
    headers['Idempotency-Key'] = idempotencyKey(path.split('/').pop() || 'action');
  }
  const resp = await fetch(url, { ...opts, method, headers });
  const text = await resp.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  const ok = resp.ok || resp.status === 202;
  return { ok, status: resp.status, data };
}

function execFileAsync(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 4000, maxBuffer: 1024 * 64, ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err && err.code, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err ? err.message : null });
    });
  });
}

function shellSingleQuote(s) {
  return `'${String(s ?? '').replace(/'/g, `'\\''`)}'`;
}
function tailscaleHostnameFor(name) {
  return String(name || 'host').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 63) || 'host';
}
function tailscaleSetupCommand(authKey, hostname) {
  // Install + connect tailscale non-interactively. Safe to re-run.
  return [
    'set -e',
    'if ! command -v tailscale >/dev/null 2>&1; then',
    '  if command -v curl >/dev/null 2>&1; then curl -fsSL https://tailscale.com/install.sh | sh; ',
    '  elif command -v wget >/dev/null 2>&1; then wget -qO- https://tailscale.com/install.sh | sh; ',
    '  else echo "tailscale install: curl/wget not found"; exit 1; fi',
    'fi',
    'if command -v systemctl >/dev/null 2>&1; then sudo systemctl enable --now tailscaled >/dev/null 2>&1 || sudo systemctl start tailscaled >/dev/null 2>&1 || true; fi',
    `sudo tailscale up --auth-key=${shellSingleQuote(authKey)} --hostname=${shellSingleQuote(hostname)} --ssh --accept-routes --accept-dns=false 2>&1 || tailscale up --auth-key=${shellSingleQuote(authKey)} --hostname=${shellSingleQuote(hostname)} --ssh --accept-routes --accept-dns=false 2>&1`,
    'tailscale ip -4 2>/dev/null || true'
  ].join('\n');
}
function buildSshExecArgs(sb, remoteCmd) {
  const target = sb.sshHost || sb.name;
  return [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=8',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts',
    target,
    `bash -lc ${shellSingleQuote(remoteCmd)}`
  ];
}
async function runRemoteSshCommand(sb, remoteCmd, timeout = 240000) {
  const args = buildSshExecArgs(sb, remoteCmd);
  return await execFileAsync('ssh', args, { timeout, maxBuffer: 1024 * 256 });
}
async function autoSetupTailscaleForSandbox(sb, reason = 'config_added') {
  const authKey = (process.env.TAILSCALE_AUTHKEY || '').trim();
  if (!authKey) {
    pushEvent({ type: 'tailscale_auto_setup_skipped', sandbox: sb?.name, reason: 'no_authkey' });
    return { ok: false, skipped: true, reason: 'no_authkey' };
  }
  if (!sb || !sb.name) return { ok: false, error: 'invalid_sandbox' };
  // Use SSH to install/connect (works for plain SSH hosts and Instabox hosts with ssh access)
  const target = sb.sshHost || sb.name;
  if (!target) {
    pushEvent({ type: 'tailscale_auto_setup_skipped', sandbox: sb.name, reason: 'no_ssh_target' });
    return { ok: false, skipped: true, reason: 'no_ssh_target' };
  }
  pushEvent({ type: 'tailscale_auto_setup_start', sandbox: sb.name, reason, target });
  try {
    const hostname = tailscaleHostnameFor(sb.name);
    const cmd = tailscaleSetupCommand(authKey, hostname);
    const r = await runRemoteSshCommand({ ...sb, sshHost: target }, cmd, 300000);
    const tail = (r.stdout || r.stderr || r.error || '').trim().slice(-400);
    pushEvent({ type: r.ok ? 'tailscale_auto_setup_ok' : 'tailscale_auto_setup_failed', sandbox: sb.name, reason, target, hostname, ok: r.ok, output: tail });
    return { ok: r.ok, sandbox: sb.name, target, hostname, output: tail, stderr: (r.stderr || '').slice(-200) };
  } catch (e) {
    pushEvent({ type: 'tailscale_auto_setup_failed', sandbox: sb.name, reason, target, error: e.message });
    return { ok: false, sandbox: sb.name, error: e.message };
  }
}
async function autoSetupTailscaleForSandboxes(list, reason = 'config_added') {
  const results = [];
  for (const sb of (list || [])) {
    try { results.push(await autoSetupTailscaleForSandbox(sb, reason)); } catch (e) { results.push({ ok: false, sandbox: sb?.name, error: e.message }); }
  }
  return { ok: results.every(r => r && r.ok), results };
}

async function getRemoteTailscaleIp(sb, timeout = 6000) {
  const target = sb?.sshHost || sb?.name;
  if (!target) return '';
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=4',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts',
    target,
    "tailscale ip -4 2>/dev/null | head -n1 || ip -4 addr show tailscale0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1 || true"
  ];
  const r = await execFileAsync('ssh', args, { timeout, maxBuffer: 1024 * 32 });
  if (!r.ok) return '';
  return String(r.stdout || '').trim().split(/\s+/)[0] || '';
}

async function getSshReachability(sb) {
  const target = sb.sshHost || sb.name;
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=4',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'UserKnownHostsFile=/home/ubuntu/.ssh/known_hosts',
    target,
    "echo __OK__; (tailscale ip -4 2>/dev/null | head -n1 || ip -4 addr show tailscale0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1 | head -n1 || true)"
  ];
  const r = await execFileAsync('ssh', args, { timeout: 7000 });
  if (r.ok && /__OK__/.test(r.stdout)) {
    const lines = String(r.stdout || '').split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
    const tsIp = (lines.find(l => l !== '__OK__' && /^\d{1,3}(\.\d{1,3}){3}$/.test(l)) || '');
    return { ...sb, machine: null, state: 'reachable', error: null, reachable: true, tailscaleIp: tsIp || null };
  }
  let err = (r.stderr || r.error || 'unreachable').split('\n').map(x => x.trim()).find(Boolean) || 'unreachable';
  // keep short
  if (err.length > 180) err = err.slice(0, 180) + '…';
  return { ...sb, machine: null, state: 'unreachable', error: err, reachable: false, tailscaleIp: null };
}

async function getSandboxStatus(sb) {
  try {
    // Non-instabox entries: status-only via SSH reachability
    if (!sb.isInstabox || !sb.apiKey) {
      return await getSshReachability(sb);
    }
    // Prefer fetching by machineId if known, else list
    let res;
    if (sb.machineId) {
      const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}`);
      if (r.ok) res = { ...sb, machine: r.data, state: r.data.state, error: null };
    }
    if (!res) {
      const r = await instaboxFetch(sb, '/v1/machines');
      if (!r.ok) return { ...sb, machine: null, state: 'unknown', error: r.data?.error?.message || 'api error', tailscaleIp: null };
      const machines = r.data?.machines || [];
      let m = null;
      if (sb.machineId) m = machines.find(x => x.id === sb.machineId);
      if (!m) m = machines.find(x => String(x.name || '').toLowerCase() === String(sb.name || '').toLowerCase());
      if (!m && machines.length === 1) m = machines[0];
      if (m && m.id && sb.machineId !== m.id) {
        const prev = sb.machineId || '';
        sb.machineId = m.id;
        try { persistDiscoveredMachineId(sb.name, m.id, prev); } catch {}
      }
      res = { ...sb, machine: m || null, state: m?.state || (machines.length > 1 ? 'not_found' : 'none'), error: null };
    }
    // Best-effort tailscale IP (instabox can also be reached via ssh alias/host)
    try { res.tailscaleIp = await getRemoteTailscaleIp(sb, 5000) || null; } catch { res.tailscaleIp = res.tailscaleIp || null; }
    return res;
  } catch (e) {
    return { ...sb, machine: null, state: 'error', error: e.message, tailscaleIp: null };
  }
}

function verifySignatureWithSecret(rawBody, headers, secret) {
  if (!secret) return { ok: true, matched: 'none' };
  const id = headers['webhook-id'];
  const timestamp = headers['webhook-timestamp'];
  const signatureHeader = headers['webhook-signature'];
  if (!id || !timestamp || !signatureHeader) return { ok: false, reason: 'missing-headers' };
  const ts = parseInt(timestamp, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(ts) || Math.abs(now - ts) > 300) return { ok: false, reason: 'timestamp-out-of-range' };
  try {
    const rawSecret = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret;
    const key = Buffer.from(rawSecret, 'base64');
    const want = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest();
    const ok = String(signatureHeader).split(/\s+/).filter(Boolean).some(s => {
      const got = Buffer.from(s.startsWith('v1,') ? s.slice(3) : s, 'base64');
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    });
    return ok ? { ok: true, reason: 'valid' } : { ok: false, reason: 'signature-mismatch' };
  } catch (e) { return { ok: false, reason: e.message }; }
}
function verifySignature(rawBody, headers, secretOrSecrets) {
  const secrets = Array.isArray(secretOrSecrets) ? secretOrSecrets.filter(Boolean) : [secretOrSecrets].filter(Boolean);
  if (secrets.length === 0) return { ok: true, reason: 'no-secret-configured' };
  let last = { ok: false, reason: 'signature-mismatch' };
  for (const sec of secrets) {
    const r = verifySignatureWithSecret(rawBody, headers, sec);
    if (r.ok) return r;
    if (r.reason === 'missing-headers' || r.reason === 'timestamp-out-of-range') return r;
    last = r;
  }
  return last;
}

async function reviveSandbox(sb, action = 'start') {
  if (!sb.machineId) return { ok: false, error: 'no machineId' };
  const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/${action}`, { method: 'POST', body: '{}' });
  if (r.ok) return { ok: true, action, result: r.data };
  // resume can fail on stopped machines; fallback to start
  if (action === 'resume') return reviveSandbox(sb, 'start');
  return { ok: false, action, error: r.data, status: r.status };
}

// Cooldown auto-revive scheduling
const pendingCooldowns = new Map();
function cancelPendingCooldown(machineId) {
  const p = pendingCooldowns.get(machineId);
  if (p) { clearTimeout(p.timeoutId); pendingCooldowns.delete(machineId); }
}
function scheduleCooldownRevive(sb, action, seconds) {
  if (!sb.machineId) return;
  cancelPendingCooldown(sb.machineId);
  const delay = Math.max(Math.ceil(seconds || 60), 3) + 2;
  pushEvent({ type: 'cooldown_scheduled', sandbox: sb.name, machineId: sb.machineId, action, delaySec: delay });
  const timeoutId = setTimeout(async () => {
    pendingCooldowns.delete(sb.machineId);
    const res = await reviveSandbox(sb, action);
    pushEvent({ type: 'cooldown_revive', sandbox: sb.name, machineId: sb.machineId, action, result: res });
  }, delay * 1000);
  pendingCooldowns.set(sb.machineId, { timeoutId, action, at: Date.now() + delay * 1000 });
}

async function handleWebhook(payload) {
  const eventType = payload.type || payload.event || 'unknown';
  const data = payload.data || payload;
  const machine = data.machine || data;
  const machineId = machine.id || data.machineId || data.id;
  const sb = sandboxById.get(machineId) || [...SANDBOXES].find(s => s.name.toLowerCase() === (machine.name||'').toLowerCase());
  pushEvent({ type: 'webhook', eventType, machineId, sandbox: sb?.name, state: machine.state });
  if (!sb) return; // not managed
  const state = machine.state;
  const shouldRevive = (state === 'suspended' || state === 'stopped' || state === 'error');
  if (!shouldRevive) return;
  if (!isAutoReviveEnabled(sb.name)) {
    pushEvent({ type: 'webhook_skipped_auto_revive', eventType, machineId, sandbox: sb.name, state, reason: 'auto-revive disabled' });
    return;
  }
  if (state === 'suspended') await reviveSandbox(sb, 'resume');
  else if (state === 'stopped' || state === 'error') await reviveSandbox(sb, 'start');
  // also handle cooldown errors via generic error? state doesn't show cooldown; API calls do
}

async function ensureVncPort(sb) {
  if (!sb.machineId) return { ok: false, error: 'no machineId' };
  // list ports
  const list = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports`);
  if (list.ok) {
    const ports = list.data?.ports || [];
    const existing = ports.find(p => p.port === 6901 || p.port === 8444 || (p.name||'').toLowerCase().includes('vnc') || (p.name||'').toLowerCase().includes('kasm'));
    if (existing) return { ok: true, port: existing, created: false };
  }
  // try create kasmvnc on 8444 (common) or 6901
  for (const port of [8444, 6901]) {
    const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports`, { method: 'POST', body: JSON.stringify({ port, name: `vnc-${port}`, protocol: 'http' }) });
    if (r.ok) return { ok: true, port: r.data, created: true };
  }
  return { ok: false, error: 'could not create vnc port' };
}

function serveStatic(req, res) {
  let reqPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (reqPath === '/') reqPath = '/index.html';
  let filePath = path.join(DIST_DIR, reqPath);
  if (!filePath.startsWith(DIST_DIR)) return json(res, 403, { error: 'forbidden' });
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html');
  }
  if (!fs.existsSync(filePath)) {
    return json(res, 503, { error: 'UI not built', hint: 'Run: cd /home/ubuntu/sandbox-manager-app && npm run build' });
  }
  const ext = path.extname(filePath);
  const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.json':'application/json', '.svg':'image/svg+xml', '.png':'image/png' };
  res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Otak-Key, X-API-Key, Mcp-Session-Id, MCP-Protocol-Version',
    });
    return res.end();
  }

  // API
  if (pathname === '/api/sandboxes' && req.method === 'GET') {
    rebuildSandboxMaps();
    const statuses = await Promise.all(SANDBOXES.map(getSandboxStatus));
    const tsIp = getTailscaleIpSync();
    const sandboxes = statuses.map(sb => ({
      ...sb,
      tailscaleIp: sb.tailscaleIp || null,
      tailscale: sb.isInstabox ? { ...(vncTailscaleInfo(sb.name) || {}), hostIp: sb.tailscaleIp || null } : (sb.tailscaleIp ? { hostIp: sb.tailscaleIp } : null),
      capabilities: sb.isInstabox
        ? { canView: true, canAdd: true, canAction: true, canVnc: !VNC_RUNTIME_DISABLED, canSuspend: true }
        : { canView: true, canAdd: true, canAction: false, canVnc: false, canSuspend: false },
    }));
    return json(res, 200, { sandboxes, tailscaleIp: tsIp || null, cooldowns: [...pendingCooldowns.entries()].map(([id,v])=>({machineId:id,...v})), serverTime: new Date().toISOString() });
  }
  if (pathname === '/api/events' && req.method === 'GET') {
    return json(res, 200, { events });
  }
  if (pathname === '/api/vnc/stop' && req.method === 'POST') {
    VNC_RUNTIME_DISABLED = true;
    VNC_TCP_RUNTIME_DISABLED = true;
    const result = stopAllVnc('manual_stop');
    return json(res, 200, result);
  }
  if (pathname === '/api/vnc/active' && req.method === 'GET') {
    rebuildSandboxMaps();
    const sessions = [];
    for (const [machineId, s] of activeVnc.entries()) {
      const sb = sandboxById.get(machineId) || SANDBOXES.find(x => x.machineId === machineId);
      const remote = s.ws?._socket?.remoteAddress || s.socket?.remoteAddress || null;
      sessions.push({
        machineId,
        sandbox: sb?.name || null,
        kind: s.kind,
        pending: !!s.pending,
        createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null,
        ageMs: Date.now() - (s.createdAt || Date.now()),
        remoteAddress: remote,
      });
    }
    return json(res, 200, { ok: true, sessions, count: sessions.length, note: 'Hanya sesi VNC yang melewati proxy/bridge server ini (web /vnc-proxy atau TCP bridge). Koneksi langsung ke URL VNC Instabox/public tidak terdeteksi server ini tapi tetap bisa menyebabkan 409.' });
  }
  if (pathname === '/api/sandboxes/config' && req.method === 'GET') {
    rebuildSandboxMaps();
    const enriched = getAllManagedEntries();
    return json(res, 200, { sandboxes: enriched.map(s => ({
      name: s.name,
      apiKey: s.apiKey || '',
      machineId: s.machineId || '',
      ssh: s.ssh || '',
      sshHost: s.sshHost || '',
      isInstabox: !!s.isInstabox,
      provider: s.provider || (s.isInstabox ? 'instabox' : 'ssh'),
      fromSshConfig: !!s.fromSshConfig,
      saved: !!s.saved,
    })) });
  }
  if (pathname === '/api/sandboxes/sync-ssh' && req.method === 'POST') {
    try {
      const result = await syncSshWithApp('api_sync');
      const all = getAllManagedEntries();
      return json(res, 200, { ok: true, ...result, sandboxes: all.map(s => ({ name:s.name, apiKey:s.apiKey||'', machineId:s.machineId||'', ssh:s.ssh||'', sshHost: s.sshHost || '', isInstabox: !!s.isInstabox, provider: s.provider || (s.isInstabox?'instabox':'ssh'), fromSshConfig: !!s.fromSshConfig, saved: !!s.saved })) });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }
  if (pathname === '/api/sandboxes/config' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    for await (const c of req) body += c;
    let p={}; try{p=JSON.parse(body||'{}')}catch{}
    const list = Array.isArray(p.sandboxes) ? p.sandboxes : null;
    if (!list) return json(res, 400, { ok:false, error:'invalid_body', message:'Body harus { sandboxes: [...] }' });
    // Simpan sandbox Instabox (butuh apiKey) dan entry SSH biasa (provider=ssh) ke config.
    // Host dari ~/.ssh/config yang tidak ada di config tetap muncul otomatis (status-only).
    const cleaned = list.map(s => {
      const provider = (String(s.provider||'').toLowerCase() === 'ssh' || s.isInstabox === false) ? 'ssh' : 'instabox';
      return {
        name: String(s.name||'').trim(),
        apiKey: String(s.apiKey||'').trim(),
        machineId: String(s.machineId||'').trim(),
        ssh: String(s.ssh||'').trim(),
        provider,
      };
    }).filter(s => s.name && (s.provider === 'ssh' || s.apiKey));
    const prevNames = new Set(savedSandboxesOnly().map(s => String(s.name || '').toLowerCase()));
    // Persist posted config, then run full SSH <-> app sync so SSH config hosts & app (agent.hajid.dev) stay in sync
    persistSandboxes(cleaned.map(({name,apiKey,machineId,ssh,provider})=>({name,apiKey,machineId,ssh,provider})));
    let syncResult = null;
    try { syncResult = await syncSshWithApp('config_saved'); } catch (e) { syncResult = { ok: false, error: e.message }; pushEvent({ type: 'ssh_app_sync_error', error: e.message }); }
    const saved = savedSandboxesOnly();
    pushEvent({ type: 'config_updated', count: saved.length, names: saved.map(s=>s.name) });
    autoSetupWebhooksForCurrentConfig('sandbox_config_updated').catch(e => pushEvent({ type: 'webhook_auto_setup_error', error: e.message }));
    // Auto install+connect Tailscale on newly added hosts (ssh + instabox)
    const added = saved.filter(s => !prevNames.has(String(s.name || '').toLowerCase()));
    if (added.length) autoSetupTailscaleForSandboxes(added, 'config_added').catch(e => pushEvent({ type: 'tailscale_auto_setup_error', error: e.message }));
    // Best-effort: masukkan mesin baru ke Herdr (jika berjalan di dalam Herdr)
    let herdrSync = null;
    try { herdrSync = await syncHerdrMachines(saved || []); } catch (e) { herdrSync = { ok: false, error: e.message }; }
    const all = getAllManagedEntries();
    return json(res, 200, {
      ok:true,
      tailscaleSetup: added.length ? 'triggered' : 'none',
      sshConfigSync: syncResult?.sshConfigSync || null,
      appSync: syncResult,
      herdrSync,
      sandboxes: all.map(s => ({ name:s.name, apiKey:s.apiKey||'', machineId:s.machineId||'', ssh:s.ssh||'', sshHost: s.sshHost || '', isInstabox: !!s.isInstabox, provider: s.provider || (s.isInstabox?'instabox':'ssh'), fromSshConfig: !!s.fromSshConfig, saved: !!s.saved })),
      webhookAutoSetup: /^https:\/\//i.test(getConfiguredWebhookBaseUrl()) ? 'triggered' : 'skipped_no_public_https',
      note: 'Setiap save: sinkron antara ~/.ssh/config dan app (agent.hajid.dev). Host dari SSH config diimpor ke app, dan entri app ditulis ke ~/.ssh/config (managed block). SSH ditampilkan raw (bukan alias).'
    });
  }
  if (pathname.startsWith('/api/sandboxes/') && pathname.endsWith('/action') && req.method === 'POST') {
    rebuildSandboxMaps();
    const name = decodeURIComponent(pathname.split('/')[3] || '');
    const sb = sandboxByName.get(name.toLowerCase());
    let body = '';
    for await (const c of req) body += c;
    let p={}; try{p=JSON.parse(body||'{}')}catch{}
    if (!sb) return json(res, 404, { error: 'not found', message: `Host "${name}" tidak ditemukan` });
    if (!sb.isInstabox || !sb.apiKey) {
      return json(res, 403, { ok: false, error: 'forbidden_non_instabox', message: `Host "${name}" bukan Instabox — hanya bisa lihat status (tidak bisa action/suspend/start/stop).` });
    }
    if (!sb.machineId) return json(res, 400, { error: 'no_machine', message: 'Sandbox belum punya machineId' });
    const action = (p.action || 'start').toString().toLowerCase();
    const allowed = new Set(['start', 'stop', 'resume', 'suspend', 'restart', 'reboot']);
    if (!allowed.has(action)) return json(res, 400, { error: 'invalid_action', message: `Action "${action}" tidak didukung`, allowed: [...allowed] });
    const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/${action}`, { method:'POST', body:'{}' });
    pushEvent({ type: 'action', sandbox: sb.name, machineId: sb.machineId, action, ok: r.ok, status: r.status, result: r.data });
    return json(res, r.ok ? 200 : r.status, { ok: r.ok, action, sandbox: sb.name, machineId: sb.machineId, result: r.data });
  }
  if (pathname.startsWith('/api/sandboxes/') && pathname.endsWith('/vnc') && req.method === 'GET') {
    rebuildSandboxMaps();
    const name = decodeURIComponent(pathname.split('/')[3] || '');
    const sb = sandboxByName.get(name.toLowerCase());
    if (!sb) return json(res, 404, { error: 'not found' });
    if (!sb.isInstabox || !sb.apiKey) {
      return json(res, 403, { ok: false, error: 'forbidden_non_instabox', message: `Host "${name}" bukan Instabox — VNC tidak tersedia (hanya bisa lihat status).` });
    }
    const r = await ensureVncPort(sb);
    // Also check direct kasmvnc URL guess
    const vncPort = r.port?.port || 8444;
    const publicUrl = r.port?.url || `https://${vncPort}-${(sb.machineId||'').replace(/^m_/,'')}.instabox.tech`;
    const wsProxy = `/vnc-proxy?name=${encodeURIComponent(sb.name)}`;
    return json(res, 200, { ...r, publicUrl, wsProxy, vncPort });
  }

  // Instabox port forwarding
  if (pathname.startsWith('/api/sandboxes/') && pathname.endsWith('/ports') && req.method === 'GET') {
    rebuildSandboxMaps();
    const name = decodeURIComponent(pathname.split('/')[3] || '');
    const sb = sandboxByName.get(name.toLowerCase());
    if (!sb) return json(res, 404, { ok: false, error: 'not found', message: `Host "${name}" tidak ditemukan` });
    if (!sb.isInstabox || !sb.apiKey) return json(res, 403, { ok: false, error: 'forbidden_non_instabox', message: `Host "${name}" bukan Instabox.` });
    if (!sb.machineId) return json(res, 400, { ok: false, error: 'no_machine', message: 'Sandbox belum punya machineId' });
    const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports`);
    if (!r.ok) return json(res, r.status || 502, { ok: false, error: r.data, message: r.data?.error?.message || 'Gagal mengambil daftar port' });
    return json(res, 200, { ok: true, ports: r.data?.ports || r.data?.items || r.data || [] });
  }
  if (pathname.startsWith('/api/sandboxes/') && pathname.endsWith('/ports') && req.method === 'POST') {
    rebuildSandboxMaps();
    const name = decodeURIComponent(pathname.split('/')[3] || '');
    const sb = sandboxByName.get(name.toLowerCase());
    if (!sb) return json(res, 404, { ok: false, error: 'not found', message: `Host "${name}" tidak ditemukan` });
    if (!sb.isInstabox || !sb.apiKey) return json(res, 403, { ok: false, error: 'forbidden_non_instabox', message: `Host "${name}" bukan Instabox.` });
    if (!sb.machineId) return json(res, 400, { ok: false, error: 'no_machine', message: 'Sandbox belum punya machineId' });
    let body = '';
    for await (const c of req) body += c;
    let p = {}; try { p = JSON.parse(body || '{}'); } catch {}
    const portNum = parseInt(p.port, 10);
    if (!portNum || portNum < 1 || portNum > 65535) return json(res, 400, { ok: false, error: 'invalid_port', message: 'Port harus angka 1-65535' });
    const payload = { port: portNum, name: String(p.name || `port-${portNum}`).slice(0, 64), protocol: String(p.protocol || 'http') };
    const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports`, { method: 'POST', body: JSON.stringify(payload) });
    pushEvent({ type: 'port_forward_create', sandbox: sb.name, machineId: sb.machineId, port: portNum, ok: r.ok, status: r.status, result: r.data });
    if (!r.ok) return json(res, r.status || 502, { ok: false, error: r.data, message: r.data?.error?.message || r.data?.message || 'Gagal membuat port forward' });
    return json(res, 200, { ok: true, port: r.data, created: payload });
  }
  if (pathname.match(/^\/api\/sandboxes\/[^/]+\/ports\/[^/]+$/) && req.method === 'DELETE') {
    rebuildSandboxMaps();
    const parts = pathname.split('/');
    const name = decodeURIComponent(parts[3] || '');
    const portRef = decodeURIComponent(parts[5] || '');
    const sb = sandboxByName.get(name.toLowerCase());
    if (!sb) return json(res, 404, { ok: false, error: 'not found', message: `Host "${name}" tidak ditemukan` });
    if (!sb.isInstabox || !sb.apiKey) return json(res, 403, { ok: false, error: 'forbidden_non_instabox', message: `Host "${name}" bukan Instabox.` });
    if (!sb.machineId) return json(res, 400, { ok: false, error: 'no_machine', message: 'Sandbox belum punya machineId' });

    const attempts = [];
    const tryDelete = async (ref, label) => {
      const r = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports/${encodeURIComponent(ref)}`, { method: 'DELETE' });
      attempts.push({ label, ref, status: r.status, ok: r.ok, data: r.data });
      return r;
    };

    // Try as-is (usually exposure/port id like pv-...)
    let r = await tryDelete(portRef, 'by_ref');
    // Some APIs expect port number; if ref looks like id and failed, try resolving by listing ports
    if (!r.ok) {
      try {
        const list = await instaboxFetch(sb, `/v1/machines/${sb.machineId}/ports`);
        if (list.ok) {
          const ports = list.data?.ports || list.data?.items || (Array.isArray(list.data) ? list.data : []);
          const match = ports.find(p => String(p.id) === String(portRef) || String(p.port) === String(portRef) || String(p.name) === String(portRef));
          const altRefs = [];
          if (match) {
            if (match.id && String(match.id) !== String(portRef)) altRefs.push({ ref: String(match.id), label: 'by_id' });
            if (match.port && String(match.port) !== String(portRef)) altRefs.push({ ref: String(match.port), label: 'by_port' });
          }
          for (const alt of altRefs) {
            r = await tryDelete(alt.ref, alt.label);
            if (r.ok) break;
          }
        }
      } catch (e) {
        attempts.push({ label: 'resolve_error', error: e.message });
      }
    }

    const ok = !!r && r.ok;
    pushEvent({ type: 'port_forward_delete', sandbox: sb.name, machineId: sb.machineId, portRef, ok, status: r?.status, attempts: attempts.map(a => ({ label: a.label, ref: a.ref, status: a.status, ok: a.ok })) });
    if (!ok) {
      const last = attempts[attempts.length - 1] || {};
      const msg = last?.data?.error?.message || last?.data?.message || last?.data?.error?.code || last?.data?.error || (last?.status ? `HTTP ${last.status}` : 'Gagal menghapus port forward');
      return json(res, r?.status || 502, { ok: false, error: last?.data || r?.data, message: typeof msg === 'string' ? msg : JSON.stringify(msg), attempts: attempts.map(a => ({ label: a.label, ref: a.ref, status: a.status, ok: a.ok, message: a?.data?.error?.message || a?.data?.message || a?.error || null })) });
    }
    return json(res, 200, { ok: true, attempts: attempts.map(a => ({ label: a.label, ref: a.ref, status: a.status, ok: a.ok })) });
  }

  if (pathname === '/api/webhook-info' && req.method === 'GET') {
    return json(res, 200, await getWebhooksStatus(req));
  }
  if (pathname === '/api/webhooks/status' && req.method === 'GET') {
    return json(res, 200, await getWebhooksStatus(req));
  }
  if (pathname === '/api/webhooks/setup' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let p={}; try{p=JSON.parse(body||'{}')}catch{}
    const publicBaseUrl = (p.publicBaseUrl || p.publicUrl || getPublicBaseUrl(req)).toString().trim();
    const desiredUrl = `${publicBaseUrl.replace(/\/$/, '')}${WEBHOOK_ENDPOINT_PATH}`;
    const groups = groupSandboxesByApiKey();
    if (groups.length === 0) return json(res, 400, { ok:false, error:'no_sandboxes', message:'Belum ada sandbox/API key terkonfigurasi.' });
    if (!/^https:\/\//i.test(desiredUrl)) {
      return json(res, 400, {
        ok: false,
        error: 'public_https_required',
        message: 'Instabox butuh URL webhook publik dengan HTTPS. Isi publicBaseUrl (contoh: https://domain-kamu/webhook-proxy) atau set env WEBHOOK_PUBLIC_URL. Kalau server ini belum publik, expose dulu via tunnel/reverse proxy HTTPS.',
        desiredUrl,
      });
    }
    const st = loadWebhookState(); st.publicBaseUrl = publicBaseUrl.replace(/\/$/, ''); saveWebhookState(st);
    const results = [];
    for (const g of groups) results.push(await setupWebhookForApiKey(g.apiKey, publicBaseUrl, g.sandboxes));
    const ok = results.length > 0 && results.every(r => r.ok);
    return json(res, ok ? 200 : 207, { ok, desiredUrl, results, state: loadWebhookState(), autoRevive: (()=>{const m={}; for(const sb of SANDBOXES) m[sb.name]=isAutoReviveEnabled(sb.name); return m;})() });
  }
  if (pathname === '/api/webhooks/auto-revive' && (req.method === 'POST' || req.method === 'PUT')) {
    let body = '';
    for await (const c of req) body += c;
    let p={}; try{p=JSON.parse(body||'{}')}catch{}
    const updates = {};
    if (p.autoRevive && typeof p.autoRevive === 'object') {
      for (const [k,v] of Object.entries(p.autoRevive)) updates[k] = !!v;
    } else if (Array.isArray(p.enabled)) {
      const enabledSet = new Set(p.enabled.map(x=>String(x).toLowerCase()));
      for (const sb of SANDBOXES) updates[sb.name] = enabledSet.has(sb.name.toLowerCase());
    } else {
      return json(res, 400, { ok:false, error:'invalid_body', message:'Body harus { autoRevive: {name: boolean} } atau { enabled: ["name", ...] }' });
    }
    const autoRevive = setAutoReviveConfig(updates);
    const effective = {}; for (const sb of SANDBOXES) effective[sb.name] = isAutoReviveEnabled(sb.name);
    pushEvent({ type: 'auto_revive_config_updated', autoRevive: effective });
    return json(res, 200, { ok:true, autoRevive: effective });
  }

  // --- Otak: mem0 OSS REST API + MCP endpoint ---
  // MCP (streamable HTTP). Pi extension "otak" dan klien MCP lain memanggil ini.
  if (pathname === '/mcp') {
    if (req.method !== 'POST') {
      return json(res, 405, { error: 'method_not_allowed', message: 'Gunakan POST /mcp (MCP streamable HTTP, stateless).' });
    }
    return await handleOtakMcpRequest(req, res);
  }

  // Read-only proxy used by the web UI (no token in the browser bundle).
  // Write operations still go through the authenticated /api/mem0/* endpoints.
  if (pathname.startsWith('/api/mem0/view/')) {
    try {
      const sub = pathname.slice('/api/mem0/view/'.length);
      if (sub === 'status' && req.method === 'GET') return json(res, 200, await otakStatus());
      if ((sub === 'list' || sub === 'search') && req.method === 'POST') {
        const body = await readOtakBody(req);
        return json(res, 200, await runMem0Operation(sub === 'list' ? 'get_memories' : 'search_memories', body));
      }
      const memoryMatch = sub.match(/^memory\/([^/]+)$/);
      if (memoryMatch && req.method === 'GET') {
        return json(res, 200, await runMem0Operation('get_memory', { memoryId: decodeURIComponent(memoryMatch[1]) }));
      }
      const historyMatch = sub.match(/^history\/([^/]+)$/);
      if (historyMatch && req.method === 'GET') {
        return json(res, 200, await runMem0Operation('memory_history', { memoryId: decodeURIComponent(historyMatch[1]) }));
      }
      return json(res, 404, { error: 'not_found', message: 'Endpoint view tidak dikenal.' });
    } catch (err) {
      if (err?.code === 'OTAK_NOT_READY') {
        return json(res, 503, { error: 'not_configured', message: sanitizeOtakError(err), config: getOtakConfig() });
      }
      return json(res, err?.status || 500, { error: err?.code || 'mem0_error', message: sanitizeOtakError(err) });
    }
  }

  if (pathname.startsWith('/api/mem0/')) {
    if (!isOtakAuthorized(req)) return otakUnauthorized(res);
    try {
      const config = getOtakConfig();
      if (pathname === '/api/mem0/status' && req.method === 'GET') {
        return json(res, 200, await otakStatus());
      }
      if (pathname === '/api/mem0/config' && req.method === 'GET') {
        return json(res, 200, config);
      }
      if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method)) {
        return json(res, 405, { error: 'method_not_allowed' });
      }
      const body = ['GET', 'DELETE'].includes(req.method) ? {} : await readOtakBody(req);
      const idMatch = pathname.match(/^\/api\/mem0\/(?:memory|memories)\/([^/]+)$/);
      let operation = null;
      let args = body;

      if (pathname === '/api/mem0/add' && req.method === 'POST') operation = 'add_memory';
      else if (pathname === '/api/mem0/search' && req.method === 'POST') operation = 'search_memories';
      else if (pathname === '/api/mem0/all' && (req.method === 'POST' || req.method === 'GET')) {
        operation = 'get_memories';
        args = { ...Object.fromEntries(url.searchParams), ...body };
      }
      else if (idMatch && req.method === 'GET') { operation = 'get_memory'; args = { memoryId: decodeURIComponent(idMatch[1]) }; }
      else if (idMatch && (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST')) { operation = 'update_memory'; args = { ...body, memoryId: decodeURIComponent(idMatch[1]) }; }
      else if (idMatch && req.method === 'DELETE') { operation = 'delete_memory'; args = { memoryId: decodeURIComponent(idMatch[1]) }; }
      else if (pathname === '/api/mem0/delete-all' && req.method === 'DELETE') operation = 'delete_all_memories';
      else if (pathname === '/api/mem0/delete-all' && req.method === 'POST') operation = 'delete_all_memories';
      else if (pathname.match(/^\/api\/mem0\/history\/[^/]+$/) && req.method === 'GET') { operation = 'memory_history'; args = { memoryId: decodeURIComponent(pathname.split('/').pop()) }; }

      if (!operation) return json(res, 404, { error: 'not_found', message: 'Endpoint mem0 tidak dikenal.' });
      const result = await runMem0Operation(operation, args);
      return json(res, 200, result ?? { ok: true });
    } catch (err) {
      if (err?.code === 'OTAK_NOT_READY') {
        return json(res, 503, { error: 'not_configured', message: sanitizeOtakError(err), config: getOtakConfig() });
      }
      return json(res, err?.status || 500, { error: err?.code || 'mem0_error', message: sanitizeOtakError(err) });
    }
  }

  // Webhook (Instabox)
  if (pathname === WEBHOOK_ENDPOINT_PATH && req.method === 'POST') {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 2*1024*1024) return json(res,413,{error:'too large'}); }
    const v = verifySignature(raw, req.headers, allWebhookSecrets());
    if (!v.ok) { pushEvent({type:'webhook_rejected', reason:v.reason, hasAnySecret: allWebhookSecrets().length > 0}); return json(res, 401, { error: 'unauthorized', reason: v.reason }); }
    let payload; try { payload = JSON.parse(raw); } catch { return json(res,400,{error:'invalid_json'}); }
    const eventId = payload.id || req.headers['webhook-id'];
    if (eventId && processedEvents.has(eventId)) return json(res,200,{ok:true,deduplicated:true});
    if (eventId) processedEvents.set(eventId, Date.now());
    json(res, 200, { ok: true, accepted: true });
    handleWebhook(payload).catch(e => pushEvent({type:'webhook_error', error:e.message}));
    return;
  }

  if (pathname === '/health') return json(res, 200, { ok: true, sandboxes: SANDBOXES.map(s=>s.name) });

  // Static SPA
  return serveStatic(req, res);
});

// WebSocket proxy: /vnc-proxy?name=infra  -> proxies to Instabox VNC websocket (RFB over WS).
// Instabox VNC allows only ONE active session per machine; new connects while busy return HTTP 409.
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname !== '/vnc-proxy') { socket.destroy(); return; }
  const name = url.searchParams.get('name') || '';
  const force = url.searchParams.get('force') === '1';
  rebuildSandboxMaps();
  const sb = sandboxByName.get(name.toLowerCase());
  if (!sb || !sb.machineId || !sb.isInstabox || !sb.apiKey) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    // Always force-takeover: replace any session tracked by this server, and retry on upstream 409
    // (Instabox allows 1 active session per machine and may take a few seconds to release).
    if (activeVnc.has(sb.machineId)) {
      closeActiveVnc(sb.machineId, 'replaced-by-new-web-client');
    }
    const sessionId = crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    activeVnc.set(sb.machineId, { id: sessionId, kind: 'web', ws, upstream: null, createdAt: Date.now(), pending: true });
    pushEvent({ type: 'vnc_proxy_connect', sandbox: sb.name, machineId: sb.machineId, force: true });

    let cleaned = false;
    const isActive = () => !cleaned && activeVnc.get(sb.machineId)?.id === sessionId && ws.readyState !== WebSocket.CLOSED;
    const cleanup = (reason) => {
      if (cleaned) return; cleaned = true;
      const cur = activeVnc.get(sb.machineId);
      if (cur && cur.id === sessionId) activeVnc.delete(sb.machineId);
      try { if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000, String(reason||'').slice(0,120)); } catch {}
    };

    const attemptConnect = (attempt = 1) => {
      if (!isActive()) return;
      const { upstream, upstreamUrl } = connectUpstreamVnc(sb, {
        onOpen: (up, upUrl) => {
          const cur = activeVnc.get(sb.machineId);
          if (!cur || cur.id !== sessionId || cur.ws !== ws) { try { up.terminate(); } catch {} return; }
          cur.upstream = up; cur.pending = false;
          pushEvent({ type: 'vnc_proxy_open', sandbox: sb.name, upstreamUrl: upUrl, attempt });
          ws.on('message', (d, isBin) => { if (up.readyState === WebSocket.OPEN) up.send(d, { binary: isBin }); });
          up.on('message', (d, isBin) => { if (ws.readyState === WebSocket.OPEN) ws.send(d, { binary: isBin }); });
        },
        onUnexpectedResponse: (status, up, upUrl) => {
          if (status === 409 && attempt < 8 && isActive()) {
            pushEvent({ type: 'vnc_proxy_retry', sandbox: sb.name, status, attempt, upstreamUrl: upUrl });
            try { up.terminate(); } catch {}
            setTimeout(() => attemptConnect(attempt + 1), 1500);
            return;
          }
          const msg = status === 409
            ? 'VNC session conflict (409): upstream Instabox masih memegang sesi VNC lama. Server sudah mencoba takeover beberapa kali. Pastikan tidak ada viewer yang membuka URL VNC Instabox langsung (public URL), lalu klik Connect lagi.'
            : `Upstream VNC error: HTTP ${status}`;
          pushEvent({ type: 'vnc_proxy_error', sandbox: sb.name, status, error: msg, upstreamUrl: upUrl, attempt });
          try { ws.send(JSON.stringify({ type: 'error', status, message: msg })); } catch {}
          try { ws.close(status === 409 ? 4409 : 1011, msg.slice(0,120)); } catch {}
          try { up.terminate(); } catch {}
          const cur = activeVnc.get(sb.machineId); if (cur && cur.id === sessionId) activeVnc.delete(sb.machineId);
        },
        onError: (e, up, upUrl) => {
          pushEvent({ type: 'vnc_proxy_error', sandbox: sb.name, error: e?.message || String(e), upstreamUrl: upUrl, attempt });
          try { ws.close(1011, (e?.message||'upstream error').slice(0,120)); } catch {}
          const cur = activeVnc.get(sb.machineId); if (cur && cur.id === sessionId) activeVnc.delete(sb.machineId);
        },
        onClose: () => cleanup('upstream-close'),
      });
      const cur = activeVnc.get(sb.machineId);
      if (cur && cur.id === sessionId) cur.upstream = upstream; else { try { upstream.terminate(); } catch {} }
      ws.on('close', () => { try { upstream.terminate(); } catch {} cleanup('ws-close'); });
      ws.on('error', () => { try { upstream.terminate(); } catch {} cleanup('ws-error'); });
    };

    try {
      // small delay to let Instabox release any previous session before first attempt
      setTimeout(() => attemptConnect(1), 250);
    } catch (e) {
      pushEvent({ type: 'vnc_proxy_exception', sandbox: sb.name, error: e?.message || String(e) });
      const cur = activeVnc.get(sb.machineId); if (cur && cur.id === sessionId) activeVnc.delete(sb.machineId);
      try { ws.close(1011, 'proxy exception'); } catch {}
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[sandbox-manager] http://${HOST}:${PORT}`);
  console.log(`[sandbox-manager] webhooks: POST ${WEBHOOK_ENDPOINT_PATH} (setup: POST /api/webhooks/setup)`);
  const tsIp = getTailscaleIpSync();
  console.log(`[sandbox-manager] vnc proxy: ws /vnc-proxy?name=...`);
  if (tsIp) console.log(`[sandbox-manager] tailscale: http://${tsIp}:${PORT}  vnc tcp: ${Object.entries(VNC_TCP_PORTS).map(([n,p])=>n+'='+tsIp+':'+p).join(', ')}`);
  console.log(`[sandbox-manager] managing: ${SANDBOXES.map(s=>s.name).join(', ')}`);
  const otakCfg = getOtakConfig();
  console.log(`[sandbox-manager] otak: REST /api/mem0/* + MCP /mcp (mem0 ${otakCfg.vectorStore.provider}, ready=${otakCfg.ready}${otakCfg.ready ? '' : `, missing=${otakCfg.missing.join(', ')}`})`);
});

// TCP VNC bridges (RFB over raw TCP) are managed dynamically by refreshVncTcpPorts()
// so every Instabox sandbox gets a dedicated Tailscale-accessible port. A new TCP/web
// connect replaces any existing active VNC session for the same machine (Instabox allows 1).
