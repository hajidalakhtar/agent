#!/usr/bin/env node
// sm — Sandbox Manager CLI (fokus: manage Instabox dari dalam sandbox ini)
// Berbicara ke server lokal manager (server.js) supaya cooldown, webhook,
// auto-revive, dan VNC proxy tetap ikut bekerja.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { spawn, execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const SM_HOME = process.env.SM_HOME || path.join(os.homedir(), '.sm');
const SESSION_PATH = path.join(SM_HOME, 'session.json');
const CRED_PATH = path.join(SM_HOME, 'credentials.json');

// ---------------------------------------------------------------- env / util
function loadDotEnv() {
  try {
    const p = path.join(PROJECT_ROOT, '.env');
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
      if (!m || process.env[m[1]]) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      process.env[m[1]] = v;
    }
  } catch {}
}
loadDotEnv();

const isTTY = !!process.stdout.isTTY && !process.env.NO_COLOR;
const colorFn = (code) => (s) => (isTTY ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const c = {
  bold: colorFn(1), dim: colorFn(2), red: colorFn(31), green: colorFn(32),
  yellow: colorFn(33), cyan: colorFn(36), magenta: colorFn(35),
};
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

function die(msg, hint, code = 1) {
  console.error(c.red('X ') + msg);
  if (hint) console.error(c.dim('  ' + hint));
  process.exit(code);
}
const ok = (msg) => console.log(c.green('v ') + msg);
const info = (msg) => console.log(c.cyan('> ') + msg);

function stateColor(st) {
  const s = String(st || '').toLowerCase();
  if (['running', 'reachable', 'ok', 'ready', 'active', 'started'].includes(s)) return c.green;
  if (['suspended', 'starting', 'stopping', 'pending', 'unknown', 'restarting'].includes(s)) return c.yellow;
  if (['stopped', 'unreachable', 'error', 'failed', 'not_found', 'none', 'deleted'].includes(s)) return c.red;
  return (x) => x;
}
const pad = (s, w) => {
  s = String(s ?? '');
  const diff = w - stripAnsi(s).length;
  return diff > 0 ? s + ' '.repeat(diff) : s;
};
function table(headers, rows) {
  if (!rows.length) return c.dim('  (kosong)');
  const widths = headers.map((h, i) =>
    Math.max(stripAnsi(h).length, ...rows.map((r) => stripAnsi(String(r[i] ?? '')).length)));
  const line = (cells) => '  ' + cells.map((cell, i) => pad(cell, widths[i])).join('  ').trimEnd();
  const out = [c.bold(line(headers)), c.dim('  ' + widths.map((w) => '-'.repeat(w)).join('  '))];
  for (const r of rows) out.push(line(r));
  return out.join('\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// sembunyikan secret di output --json
function redact(o) {
  if (Array.isArray(o)) return o.map(redact);
  if (o && typeof o === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(o)) {
      out[k] = /^(apiKey|api_key|secret|password|token)$/i.test(k) && typeof v === 'string' && v
        ? v.slice(0, 10) + '...' + v.slice(-4)
        : redact(v);
    }
    return out;
  }
  return o;
}

// ---------------------------------------------------------------- arg parser
const GLOBAL_FLAGS = {
  json: 'bool', base: 'str', password: 'str', timeout: 'num', wait: 'bool',
  'wait-timeout': 'num', all: 'bool', open: 'bool', label: 'str', proto: 'str',
  host: 'str', sandbox: 'str', n: 'num', f: 'bool', exec: 'bool', cmd: 'str',
  'no-save': 'bool', url: 'str', yes: 'bool', 'api-key': 'str', 'machine-id': 'str',
  ssh: 'str', provider: 'str', down: 'bool', up: 'bool', state: 'str',
  'ssh-only': 'bool',
  'dry-run': 'bool',
};
function parseArgs(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { rest.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let key = eq > -1 ? a.slice(2, eq) : a.slice(2);
      let val = eq > -1 ? a.slice(eq + 1) : undefined;
      const neg = key.startsWith('no-') && val === undefined;
      if (neg) key = key.slice(3);
      const type = GLOBAL_FLAGS[key] ?? GLOBAL_FLAGS[key.replace(/^no-/, '')];
      if (type === 'bool' || type === undefined) {
        val = val === undefined ? !neg : !/^(0|false|no)$/i.test(val);
      } else {
        if (val === undefined) {
          val = argv[++i];
          if (val === undefined) die(`Flag --${key} butuh nilai`);
        }
        if (type === 'num') val = Number(val);
      }
      flags[key] = val;
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      const letters = a.slice(1);
      for (let i2 = 0; i2 < letters.length; i2++) {
        const ch = letters[i2];
        if (ch === 'f') flags.f = true;
        else if (ch === 'v') flags.v = true;
        else if (ch === 'h') flags.help = true;
        else if (ch === 'n') {
          const inline = letters.slice(i2 + 1);
          if (inline) { flags.n = Number(inline); i2 = letters.length; }
          else flags.n = Number(argv[++i]);
        } else die(`Flag -${ch} tidak dikenal`);
      }
    } else rest.push(a);
  }
  return { flags, rest };
}

// ---------------------------------------------------------------- http client
let BASE = (process.env.SM_BASE || `http://127.0.0.1:${process.env.PORT || 4173}`).replace(/\/$/, '');
const TIMEOUT_MS = 60000;

class ApiError extends Error {
  constructor(msg, opts = {}) {
    super(msg);
    this.status = opts.status;
    this.hint = opts.hint;
    this.body = opts.body;
  }
}
function readSession() {
  try {
    const s = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
    if (s.base && s.cookie) return s;
  } catch {}
  return null;
}
function saveSession(s) {
  fs.mkdirSync(SM_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(SESSION_PATH, JSON.stringify(s, null, 2), { mode: 0o600 });
}
function clearSession() { try { fs.unlinkSync(SESSION_PATH); } catch {} }
function readPassword() {
  if (process.env.SM_PASSWORD) return process.env.SM_PASSWORD;
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    if (cred.password) return cred.password;
  } catch {}
  return null;
}
function savePassword(pw) {
  fs.mkdirSync(SM_HOME, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CRED_PATH, JSON.stringify({ password: pw, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
}
async function loginRequest(password) {
  const res = await fetch(`${BASE}/api/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return false;
  const sc = res.headers.get('set-cookie') || '';
  const m = sc.match(/sm_session=([^;]+)/);
  if (!m) return false;
  saveSession({ base: BASE, cookie: m[1], savedAt: new Date().toISOString(), expiresAt: Date.now() + 7 * 86400000 });
  return true;
}
async function autoLogin() {
  const pw = readPassword();
  if (!pw) return false;
  try { return await loginRequest(pw); } catch { return false; }
}
async function api(method, pathname, body, opts = {}) {
  const retries = opts.retries === undefined ? 1 : opts.retries;
  let session = readSession();
  if (session && (session.base !== BASE || (session.expiresAt && Date.now() > session.expiresAt))) {
    clearSession();
    session = null;
  }
  for (let attempt = 0; ; attempt++) {
    if (!session) {
      if (await autoLogin()) session = readSession();
      else throw new ApiError('Belum login ke Sandbox Manager.', {
        hint: `Jalankan: sm login   (atau set SM_PASSWORD)  ·  server: ${BASE}`,
      });
    }
    let res;
    try {
      res = await fetch(BASE + pathname, {
        method,
        headers: { 'Content-Type': 'application/json', Cookie: `sm_session=${session.cookie}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      if (attempt < retries) { await sleep(600); continue; }
      throw new ApiError(`Tidak bisa terhubung ke server manager (${BASE}): ${e.message}`, {
        hint: 'Server mati? Jalankan: sm server start',
      });
    }
    if (res.status === 401) {
      clearSession();
      if (attempt < 1 && (await autoLogin())) { session = readSession(); continue; }
      throw new ApiError('Sesi kedaluwarsa / password salah.', { status: 401, hint: 'Jalankan: sm login' });
    }
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }
    if (!res.ok && attempt < retries && res.status >= 500) { await sleep(600); continue; }
    if (!res.ok) {
      const detail = data?.result?.error || (typeof data?.result === 'object' ? data.result : null) || null;
      const msg = data?.message || data?.error?.message || detail?.message ||
        (typeof data?.error === 'string' ? data.error : null) || `HTTP ${res.status}`;
      const hint = detail?.code === 'machine_cooldown'
        ? `free plan cooldown - mesin bisa bangun lagi ${detail.until || detail.wakeAt || (detail.retryAfterSeconds ? `~${Math.ceil(detail.retryAfterSeconds / 60)} menit lagi` : 'nanti')}`
        : undefined;
      throw new ApiError(msg, { status: res.status, body: data, hint });
    }
    return data;
  }
}

// ---------------------------------------------------------------- local port helpers
function localListeners() {
  let out = '';
  try { out = execFileSync('ss', ['-H', '-tlnp'], { encoding: 'utf8', timeout: 5000 }); } catch { return []; }
  const rows = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^LISTEN\s+\d+\s+\d+\s+(\S+?):(\d+)\s+\S+\s*(.*)$/);
    if (!m) continue;
    const proc = m[3].match(/users:\(\("([^"]+)",pid=(\d+)/) || [];
    rows.push({ addr: m[1], port: Number(m[2]), process: proc[1] || '', pid: proc[2] || '' });
  }
  return rows.sort((a, b) => a.port - b.port);
}
function isListeningLocal(port) { return localListeners().some((r) => r.port === Number(port)); }
function probePort(host, port, timeout = 2500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port: Number(port) });
    const done = (v) => { try { sock.destroy(); } catch {} resolve(v); };
    sock.setTimeout(timeout, () => done(false));
    sock.on('connect', () => done(true));
    sock.on('error', () => done(false));
  });
}
function tailscaleIp() {
  if (process.env.TAILSCALE_IP) return process.env.TAILSCALE_IP;
  try { return execFileSync('tailscale', ['ip', '-4'], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/)[0] || ''; } catch {}
  try {
    const out = execFileSync('bash', ['-lc', "ip -4 addr show tailscale0 2>/dev/null | awk '/inet /{print $2}' | cut -d/ -f1"],
      { encoding: 'utf8', timeout: 3000 }).trim();
    return out || '';
  } catch {}
  return '';
}
function openUrl(url) {
  try {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
    return true;
  } catch { return false; }
}
function webBase() { return BASE.replace('127.0.0.1', tailscaleIp() || '127.0.0.1'); }

// ---------------------------------------------------------------- sandbox helpers
async function listSandboxes() {
  const data = await api('GET', '/api/sandboxes');
  return data.sandboxes || [];
}
function pickSandbox(list, name) {
  const key = String(name || '').toLowerCase();
  return list.find((s) => String(s.name).toLowerCase() === key) || null;
}
async function resolveTargets(names, flags) {
  const list = await listSandboxes();
  if (flags.all) {
    const t = list.filter((s) => s.isInstabox);
    if (!t.length) die('Tidak ada sandbox Instabox terkonfigurasi.');
    return { list, targets: t };
  }
  if (!names.length) {
    die('Sebut nama sandbox (atau pakai --all).', 'Contoh: sm start infra  ·  sm stop --all');
  }
  const targets = [];
  for (const n of names) {
    const sb = pickSandbox(list, n);
    if (!sb) die(`Sandbox "${n}" tidak dikenal.`, `Yang ada: ${list.map((s) => s.name).join(', ')}`);
    targets.push(sb);
  }
  return { list, targets };
}
const EXPECT_STATE = {
  start: 'running', resume: 'running', restart: 'running', reboot: 'running',
  stop: 'stopped', suspend: 'suspended',
};
async function waitStates(names, want, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  const remaining = new Set(names.map((n) => n.toLowerCase()));
  const ever = new Map(); // name -> state terakhir yang terlihat
  const notes = [];
  while (remaining.size && Date.now() < deadline) {
    const list = await listSandboxes();
    for (const n of [...remaining]) {
      const sb = pickSandbox(list, n);
      if (!sb) continue;
      const st = String(sb.state).toLowerCase();
      const prev = ever.get(n);
      ever.set(n, st);
      if (st === want) { remaining.delete(n); continue; }
      // suspend sering langsung dibalik auto-revive/webhook -> anggap berhasil
      if (want === 'suspended' && ['suspending', 'suspended'].includes(prev) && st === 'running') {
        remaining.delete(n);
        notes.push(`${n}: sempat suspended lalu di-auto-revive ke running`);
      }
    }
    if (remaining.size) await sleep(2000);
  }
  for (const n of notes) info(n);
  return { reached: remaining.size === 0, pending: [...remaining] };
}

// ---------------------------------------------------------------- auth commands
async function promptPassword(q) {
  if (!process.stdin.isTTY) return null;
  process.stdout.write(q);
  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  try { stdin.setRawMode(true); } catch {}
  stdin.resume();
  return new Promise((resolve) => {
    let val = '';
    const cleanup = () => {
      stdin.off('data', onData);
      try { stdin.setRawMode(!!wasRaw); } catch {}
      stdin.pause();
    };
    function onData(buf) {
      for (const ch of buf.toString('utf8')) {
        const code = ch.charCodeAt(0);
        if (code === 13 || code === 10) { cleanup(); process.stdout.write('\n'); resolve(val); return; }
        if (code === 3) { cleanup(); process.stdout.write('\n'); resolve(null); return; }
        if (code === 127 || code === 8) { val = val.slice(0, -1); continue; }
        val += ch;
      }
    }
    stdin.on('data', onData);
  });
}
async function cmdLogin(flags) {
  const password = flags.password ?? readPassword() ?? (await promptPassword('Password dashboard: '));
  if (!password) die('Password kosong.');
  if (await loginRequest(password)) {
    if (flags['no-save']) {
      try { fs.unlinkSync(CRED_PATH); } catch {}
      ok(`Login sukses -> ${BASE} ${c.dim('(password tidak disimpan)')}`);
    } else {
      savePassword(password);
      ok(`Login sukses -> ${BASE} ${c.dim('(password disimpan di ' + CRED_PATH + ', mode 600)')}`);
    }
  } else die('Password salah.', 'Coba: sm login --password <pw>');
}
async function cmdLogout() {
  clearSession();
  try { fs.unlinkSync(CRED_PATH); } catch {}
  ok('Sesi & kredensial dihapus.');
}

// ---------------------------------------------------------------- status
const UP_STATES = new Set(['running', 'reachable', 'ok', 'ready', 'active', 'started']);
const DEAD_STATES = new Set(['suspended', 'stopped', 'error', 'unreachable', 'not_found', 'failed', 'deleted', 'none']);
const TRANSIENT_STATES = new Set(['starting', 'stopping', 'restarting', 'suspending', 'resuming', 'pending']);
const isUpState = (st) => UP_STATES.has(String(st || '').toLowerCase());
const isDeadState = (st) => DEAD_STATES.has(String(st || '').toLowerCase());
const isTransientState = (st) => TRANSIENT_STATES.has(String(st || '').toLowerCase());

async function cmdStatus(flags, names) {
  const list = await listSandboxes();
  const rows = list.filter((s) =>
    !names.length || names.some((n) => n.toLowerCase() === String(s.name).toLowerCase()));
  if (flags.json) return console.log(JSON.stringify(redact(rows), null, 2));
  if (!rows.length) return info('Tidak ada sandbox.');
  console.log(c.bold('\n  Sandbox Manager - status\n'));
  console.log(table(
    ['NAME', 'PROVIDER', 'STATE', 'MACHINE', 'SSH', 'ERROR'],
    rows.map((s) => [
      s.name,
      s.isInstabox ? 'instabox' : 'ssh',
      stateColor(s.state)(String(s.state ?? '-')),
      s.machineId || s.sshHostName || s.sshHost || '-',
      s.ssh || '-',
      s.error ? c.red(String(s.error).slice(0, 44)) : '',
    ])
  ));
  const up = rows.filter((s) => ['running', 'reachable'].includes(String(s.state).toLowerCase())).length;
  const ib = rows.filter((s) => s.isInstabox).length;
  const down = rows.filter((s) => ['suspended', 'stopped'].includes(String(s.state).toLowerCase())).length;
  console.log(c.dim(`\n  ${rows.length} host · ${ib} instabox · ${up} aktif · ${down} mati\n`));
}

// daftar SEMUA sandbox (instabox + ssh) dengan filter state/provider
async function cmdSandboxes(flags) {
  const list = await listSandboxes();
  let rows = list;
  if (flags.instabox) rows = rows.filter((s) => s.isInstabox);
  if (flags['ssh-only']) rows = rows.filter((s) => !s.isInstabox);
  if (flags.down) rows = rows.filter((s) => isDeadState(s.state));
  if (flags.up) rows = rows.filter((s) => isUpState(s.state));
  if (flags.state) {
    const want = String(flags.state).toLowerCase();
    rows = rows.filter((s) => String(s.state || '').toLowerCase() === want);
  }
  if (flags.json) return console.log(JSON.stringify(redact(rows), null, 2));
  if (!rows.length) return info('Tidak ada sandbox yang cocok dengan filter.');

  const sorted = [...rows].sort((a, b) => {
    const rank = (s) => (isUpState(s.state) ? 0 : isTransientState(s.state) ? 1 : 2);
    return rank(a) - rank(b) || String(a.name).localeCompare(String(b.name));
  });

  console.log(c.bold('\n  Semua sandbox\n'));
  console.log(table(
    ['NAME', 'PROVIDER', 'STATE', 'MACHINE', 'SSH', 'NOTE'],
    sorted.map((s) => [
      s.isInstabox ? s.name : c.dim(s.name),
      s.isInstabox ? 'instabox' : 'ssh',
      stateColor(s.state)(String(s.state ?? '-')),
      s.machineId || s.sshHostName || s.sshHost || '-',
      s.ssh || '-',
      s.error ? c.red(String(s.error).slice(0, 44)) : '',
    ])
  ));

  const count = (pred) => list.filter(pred).length;
  const byState = {};
  for (const s of list) {
    const k = String(s.state || 'unknown').toLowerCase();
    byState[k] = (byState[k] || 0) + 1;
  }
  const stateSummary = Object.entries(byState)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${stateColor(k)(k)}=${v}`)
    .join('  ');
  const ib = count((s) => s.isInstabox);
  const down = count((s) => s.isInstabox && isDeadState(s.state));
  console.log(c.dim(`\n  ${list.length} host · ${ib} instabox · ${down} instabox mati`));
  if (stateSummary) console.log(c.dim('  ' + stateSummary));
  if (flags.down || down) {
    console.log(c.dim('\n  nyalakan yang mati: ') + c.cyan('sm revive') + c.dim('   · filter: --down --up --instabox --ssh-only --state <s>'));
  } else {
    console.log(c.dim('\n  filter: --down --up --instabox --ssh-only --state <s>\n'));
  }
}

async function cmdInfo(flags, names) {
  const name = names[0];
  if (!name) die('Sebut nama sandbox.', 'Contoh: sm info infra');
  const list = await listSandboxes();
  const sb = pickSandbox(list, name);
  if (!sb) die(`Sandbox "${name}" tidak dikenal.`, `Yang ada: ${list.map((s) => s.name).join(', ')}`);
  if (flags.json) {
    const extra = sb.isInstabox
      ? await Promise.allSettled([
          api('GET', `/api/sandboxes/${encodeURIComponent(sb.name)}/ports`),
          api('GET', `/api/sandboxes/${encodeURIComponent(sb.name)}/vnc`),
        ])
      : [];
    return console.log(JSON.stringify(redact({ ...sb, ports: extra[0]?.value, vnc: extra[1]?.value }), null, 2));
  }
  console.log(c.bold(`\n  ${sb.name}`) + c.dim(`  (${sb.isInstabox ? 'instabox' : 'ssh'})`));
  const rows = [
    ['state', stateColor(sb.state)(String(sb.state ?? '-'))],
    ['machineId', sb.machineId || '-'],
    ['provider', sb.provider || (sb.isInstabox ? 'instabox' : 'ssh')],
    ['ssh', sb.ssh || '-'],
    ['sshHost', sb.sshHost || '-'],
    ['tailscale', sb.tailscaleIp || sb.tailscale?.hostIp || '-'],
    ['region', sb.machine?.region || sb.machine?.regionId || '-'],
    ['image', typeof sb.machine?.image === 'object'
      ? JSON.stringify(sb.machine.image).slice(0, 60)
      : (sb.machine?.image || sb.machine?.imageId || sb.machine?.template || '-')],
    ['error', sb.error ? c.red(sb.error) : '-'],
  ];
  for (const [k, v] of rows) console.log('  ' + c.dim(pad(k, 11)) + ' ' + v);

  if (sb.isInstabox) {
    try {
      const p = await api('GET', `/api/sandboxes/${encodeURIComponent(sb.name)}/ports`);
      const ports = p.ports || [];
      console.log(c.bold('\n  Port forward'));
      if (!ports.length) console.log(c.dim(`    (belum ada) - buka: sm open ${sb.name} <port>`));
      else console.log(table(['PORT', 'NAME', 'PROTO', 'ID', 'URL'],
        ports.map((x) => [x.port, x.name || '', x.protocol || '', x.id || '', x.url || ''])));
    } catch (e) { console.log(c.dim('  ports: ' + e.message)); }
    try {
      const v = await api('GET', `/api/sandboxes/${encodeURIComponent(sb.name)}/vnc`);
      console.log(c.bold('\n  VNC'));
      console.log('    viewer   ' + c.cyan(webBase() + (v.viewerRoute || `/vnc/${sb.name}`)));
      if (v.publicUrl) console.log('    public   ' + v.publicUrl);
      if (v.tcpVnc) console.log('    tcp      ' + v.tcpVnc);
      if (flags.open) { openUrl(webBase() + (v.viewerRoute || `/vnc/${sb.name}`)); info('membuka viewer...'); }
    } catch (e) { console.log(c.dim('  vnc: ' + e.message)); }
  }
  console.log('');
}

// ---------------------------------------------------------------- actions
async function cmdAction(action, flags, names) {
  const { targets } = await resolveTargets(names, flags);
  const nonIb = targets.filter((t) => !t.isInstabox || !t.apiKey);
  if (nonIb.length) {
    die(`Host non-Instabox tidak bisa diaksi: ${nonIb.map((t) => t.name).join(', ')}`,
      'Host SSH biasa hanya untuk lihat status.');
  }
  if (targets.length > 1 && !flags.json) {
    info(`${c.bold(action)} -> ${targets.map((t) => t.name).join(', ')}`);
  }
  const results = [];
  for (const sb of targets) {
    // lewati yang sudah berada di state tujuan (biar `--all` idempoten)
    const cur = String(sb.state || '').toLowerCase();
    const already = (action === 'start' || action === 'resume') ? cur === 'running'
      : action === 'stop' ? cur === 'stopped'
      : action === 'suspend' ? cur === 'suspended' : false;
    if (already) {
      results.push({ name: sb.name, ok: true, skipped: true, state: cur });
      if (!flags.json) console.log(c.dim('= ') + `${sb.name}: sudah ${cur}, dilewati`);
      continue;
    }
    try {
      const r = await api('POST', `/api/sandboxes/${encodeURIComponent(sb.name)}/action`, { action });
      results.push({ name: sb.name, ok: true, result: r.result ?? null });
      ok(`${action} -> ${c.bold(sb.name)}${r.result?.state ? c.dim('  state=' + r.result.state) : ''}`);
    } catch (e) {
      results.push({ name: sb.name, ok: false, error: e.message });
      console.error(c.red('X ') + `${action} -> ${sb.name}: ${e.message}` + (e.hint ? c.dim('\n    ' + e.hint) : ''));
    }
  }
  if (flags.json) console.log(JSON.stringify(results, null, 2));
  if (results.some((r) => !r.ok)) process.exitCode = 1;

  const want = EXPECT_STATE[action];
  if (flags.wait && want) {
    info(`menunggu state "${want}" (timeout ${flags['wait-timeout'] || 120}s)...`);
    const r = await waitStates(targets.map((t) => t.name), want, flags['wait-timeout'] || 120);
    if (r.reached) ok(`semua sudah "${want}"`);
    else {
      console.error(c.yellow('! ') + `masih menunggu: ${r.pending.join(', ')}`);
      process.exitCode = 1;
    }
  }
}

// resume/start SEMUA Instabox yang sedang mati (suspended/stopped/error/unreachable)
async function cmdRevive(flags, names) {
  const list = await listSandboxes();
  const skipped = [];
  let pool = list.filter((s) => s.isInstabox && s.apiKey);
  const noMachine = new Set(
    pool.filter((s) => !s.machineId).map((s) => String(s.name).toLowerCase()));
  for (const s of pool) {
    if (noMachine.has(String(s.name).toLowerCase())) skipped.push({ name: s.name, state: s.state, why: 'tanpa machineId' });
  }
  pool = pool.filter((s) => s.machineId);
  if (names.length) {
    const wanted = new Set(names.map((n) => n.toLowerCase()));
    const unknown = [...wanted].filter((n) => !list.some((s) => String(s.name).toLowerCase() === n));
    if (unknown.length) die(`Sandbox tidak dikenal: ${unknown.join(', ')}`, `Yang ada: ${list.map((s) => s.name).join(', ')}`);
    pool = pool.filter((s) => wanted.has(String(s.name).toLowerCase()));
  }

  const targets = [];
  for (const s of pool) {
    if (isUpState(s.state)) skipped.push({ name: s.name, state: s.state, why: 'sudah hidup' });
    else if (isTransientState(s.state)) skipped.push({ name: s.name, state: s.state, why: 'sedang transisi' });
    else targets.push(s);
  }

  const plan = targets.map((s) => ({
    name: s.name,
    state: s.state,
    action: String(s.state || '').toLowerCase() === 'suspended' ? 'resume' : 'start',
  }));

  if (flags.json && flags['dry-run']) {
    return console.log(JSON.stringify({ dryRun: true, plan, skipped }, null, 2));
  }
  if (flags['dry-run'] || !plan.length) {
    if (!plan.length) {
      ok(`Semua Instabox sudah hidup (${pool.length} dicek, tidak ada yang mati).`);
    } else {
      console.log(c.bold('\n  Dry run — Instabox yang akan dinyalakan\n'));
      console.log(table(['NAME', 'STATE', 'ACTION'], plan.map((p) => [p.name, stateColor(p.state)(String(p.state)), p.action])));
      console.log(c.dim('\n  tanpa --dry-run untuk eksekusi\n'));
    }
    if (skipped.length && !flags.json) {
      console.log(c.dim('  dilewati: ' + skipped.map((s) => `${s.name} (${s.state || '-'})`).join(', ') + '\n'));
    }
    if (flags.json) console.log(JSON.stringify({ dryRun: true, plan, skipped }, null, 2));
    return;
  }

  if (!flags.json) {
    info(`menyalakan ${c.bold(String(plan.length))} Instabox mati: ${plan.map((p) => p.name).join(', ')}`);
    if (skipped.length) console.log(c.dim('  dilewati: ' + skipped.map((s) => `${s.name} (${s.why})`).join(', ')));
  }

  const results = [];
  for (const p of plan) {
    try {
      const r = await api('POST', `/api/sandboxes/${encodeURIComponent(p.name)}/action`, { action: p.action });
      results.push({ name: p.name, from: p.state, action: p.action, ok: true, state: r.result?.state ?? null });
      ok(`${p.action} -> ${c.bold(p.name)}${c.dim(`  ${p.state || '?'} -> `)}${stateColor(r.result?.state)(r.result?.state || '...')}`);
    } catch (e) {
      // resume kadang ditolak kalau mesin sebenarnya stopped -> coba start
      if (p.action === 'resume') {
        try {
          const r2 = await api('POST', `/api/sandboxes/${encodeURIComponent(p.name)}/action`, { action: 'start' });
          results.push({ name: p.name, from: p.state, action: 'start', ok: true, fallback: true, state: r2.result?.state ?? null });
          ok(`start -> ${c.bold(p.name)}${c.dim('  (fallback dari resume)')}`);
          continue;
        } catch {}
      }
      results.push({ name: p.name, from: p.state, action: p.action, ok: false, error: e.message });
      console.error(c.red('X ') + `${p.name}: ${e.message}` + (e.hint ? c.dim('\n    ' + e.hint) : ''));
    }
  }

  if (flags.json) console.log(JSON.stringify({ plan, skipped, results }, null, 2));
  const good = results.filter((r) => r.ok);
  const bad = results.filter((r) => !r.ok);
  if (!flags.json) {
    console.log('');
    ok(`${good.length}/${results.length} berhasil dinyalakan` + (bad.length ? c.red(` · ${bad.length} gagal`) : ''));
  }
  if (bad.length) process.exitCode = 1;

  if (flags.wait && good.length) {
    info(`menunggu state "running" (timeout ${flags['wait-timeout'] || 180}s)...`);
    const r = await waitStates(good.map((g) => g.name), 'running', flags['wait-timeout'] || 180);
    if (r.reached) ok('semua sudah running');
    else {
      console.error(c.yellow('! ') + `masih belum running: ${r.pending.join(', ')}`);
      process.exitCode = 1;
    }
  }
}

// ---------------------------------------------------------------- ports
async function cmdPorts(flags, names) {
  const name = names[0];
  if (!name) die('Sebut nama sandbox.', 'Contoh: sm ports infra   ·  (port lokal: sm local-ports)');
  const p = await api('GET', `/api/sandboxes/${encodeURIComponent(name)}/ports`);
  const ports = p.ports || [];
  if (flags.json) return console.log(JSON.stringify(ports, null, 2));
  if (!ports.length) return info(`Tidak ada port forward di "${name}".  ${c.dim(`Buka: sm open ${name} <port>`)}`);
  console.log(c.bold(`\n  Port forward - ${name}\n`));
  console.log(table(['PORT', 'NAME', 'PROTO', 'ID', 'URL'],
    ports.map((x) => [x.port, x.name || '', x.protocol || '', x.id || '', x.url || x.publicUrl || ''])));
  console.log('');
}

async function cmdOpen(flags, args) {
  const [name, portArg] = args;
  if (!name || !portArg) die('Pemakaian: sm open <sandbox> <port> [--label nama] [--proto http|tcp]');
  const port = parseInt(portArg, 10);
  if (!port || port < 1 || port > 65535) die(`Port "${portArg}" tidak valid (1-65535).`);
  const r = await api('POST', `/api/sandboxes/${encodeURIComponent(name)}/ports`, {
    port,
    name: flags.label || `port-${port}`,
    protocol: flags.proto || 'http',
  });
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  const p = r.port || {};
  ok(`port ${c.bold(String(port))} dibuka di ${c.bold(name)}${p.id ? c.dim('  ' + p.id) : ''}`);
  if (p.url || p.publicUrl) console.log('  ' + c.cyan(p.url || p.publicUrl));
  else console.log(c.dim(`  lihat URL: sm ports ${name}`));
}

async function cmdClose(flags, args) {
  const [name, ref] = args;
  if (!name || !ref) die('Pemakaian: sm close <sandbox> <port|id|nama>');
  const r = await api('DELETE', `/api/sandboxes/${encodeURIComponent(name)}/ports/${encodeURIComponent(ref)}`);
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  ok(`port forward "${ref}" dihapus dari ${name}`);
}

async function cmdLocalPorts(flags) {
  const rows = localListeners();
  if (flags.json) return console.log(JSON.stringify(rows, null, 2));
  if (!rows.length) return info('Tidak ada port listening terdeteksi (ss tidak tersedia?).');
  console.log(c.bold('\n  Port listening - sandbox ini\n'));
  console.log(table(['PORT', 'ADDR', 'PROCESS', 'PID'],
    rows.map((r) => [r.port, r.addr, r.process, r.pid])));
  const ts = tailscaleIp();
  console.log(c.dim(`\n  tailscale: ${ts || '-'} · akses dari luar: http://${ts || '<tailscale-ip>'}:<port>\n`));
}

async function cmdCheck(flags, args) {
  const portArg = args[0];
  if (!portArg) die('Pemakaian: sm check <port> [--sandbox <nama>]');
  const port = parseInt(portArg, 10);
  if (!port) die(`Port "${portArg}" tidak valid.`);
  const listening = isListeningLocal(port);
  const reachable = await probePort('127.0.0.1', port);
  if (flags.json) {
    return console.log(JSON.stringify(
      { port, listeningLocal: listening, connectable: reachable, sandbox: flags.sandbox || null }, null, 2));
  }
  console.log(`\n  Port ${c.bold(String(port))} di sandbox ini`);
  console.log('    listening   ' + (listening ? c.green('ya') : c.red('tidak')));
  console.log('    connectable ' + (reachable ? c.green('ya (127.0.0.1)') : c.red('tidak')));
  if (listening) {
    const r = localListeners().find((x) => x.port === port);
    console.log('    process     ' + (r ? `${r.process} (pid ${r.pid}) @ ${r.addr}` : '-'));
  }
  if (flags.sandbox) {
    try {
      const p = await api('GET', `/api/sandboxes/${encodeURIComponent(flags.sandbox)}/ports`);
      const hit = (p.ports || []).find((x) => Number(x.port) === port);
      console.log('    exposed     ' + (hit
        ? c.green(`ya di ${flags.sandbox} (${hit.id || hit.name || ''})`)
        : c.red(`tidak di ${flags.sandbox}`)));
      if (hit?.url || hit?.publicUrl) console.log('    url         ' + c.cyan(hit.url || hit.publicUrl));
    } catch (e) { console.log('    exposed     ' + c.dim('gagal: ' + e.message)); }
  }
  console.log('');
}

async function cmdOpenLocal(flags, args) {
  const port = parseInt(args[0], 10);
  if (!port) die('Pemakaian: sm open-local <port> [--open]');
  const listening = isListeningLocal(port);
  const ts = tailscaleIp();
  const urls = [`http://127.0.0.1:${port}`, ...(ts ? [`http://${ts}:${port}`] : [])];
  if (!listening) console.log(c.yellow('! ') + `port ${port} belum listening di sandbox ini - start dulu servicenya.`);
  else ok(`port ${port} listening`);
  for (const u of urls) console.log('  ' + c.cyan(u));
  if (flags.open) { openUrl(urls[urls.length - 1]); info('membuka browser...'); }
}

// ---------------------------------------------------------------- vnc
async function cmdVnc(flags, names) {
  const name = names[0];
  if (!name) die('Sebut nama sandbox.', 'Contoh: sm vnc infra --open');
  const v = await api('GET', `/api/sandboxes/${encodeURIComponent(name)}/vnc`);
  if (flags.json) return console.log(JSON.stringify(v, null, 2));
  ok(`VNC ${c.bold(name)} siap ${v.created ? c.dim('(port dibuat)') : c.dim('(port sudah ada)')}`);
  const viewer = webBase() + (v.viewerRoute || `/vnc/${name}`);
  console.log('  viewer  ' + c.cyan(viewer));
  if (v.publicUrl) console.log('  public  ' + v.publicUrl);
  if (v.wsProxy) console.log('  ws      ' + c.dim(webBase() + v.wsProxy + '&force=1'));
  if (v.tcpVnc) console.log('  tcp     ' + v.tcpVnc);
  if (flags.open) { openUrl(viewer); info('membuka viewer...'); }
}
async function cmdVncSessions(flags) {
  const r = await api('GET', '/api/vnc/active');
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  if (!r.sessions?.length) return info('Tidak ada sesi VNC aktif lewat proxy ini.');
  console.log(table(['SANDBOX', 'KIND', 'AGE', 'REMOTE'],
    r.sessions.map((s) => [
      s.sandbox || s.machineId,
      s.kind + (s.pending ? ' (pending)' : ''),
      `${Math.round((s.ageMs || 0) / 1000)}s`,
      s.remoteAddress || '-',
    ])));
}
async function cmdVncStop() {
  const r = await api('POST', '/api/vnc/stop', {});
  ok(`sesi VNC dihentikan: ${r.closedSessions || 0} sesi, ${r.closedServers || 0} bridge`);
  info('VNC runtime nonaktif sampai server restart (sm server restart).');
}

// ---------------------------------------------------------------- events / webhook
async function cmdEvents(flags) {
  const limit = flags.n || 20;
  const data = await api('GET', '/api/events');
  const events = data.events || [];
  if (flags.json && !flags.f) return console.log(JSON.stringify(events.slice(0, limit), null, 2));
  const key = (e) => `${e.at}|${e.type}|${e.sandbox || ''}|${e.action || ''}|${e.machineId || ''}`;
  const print = (e) => {
    const t = c.dim(String(e.at || '').slice(11, 19));
    const type = c.magenta(e.type);
    const who = e.sandbox ? ' ' + c.bold(e.sandbox) : '';
    const act = e.action ? ' ' + e.action : '';
    const res = e.ok === false ? c.red(' fail') : e.ok === true ? c.green(' ok') : '';
    const extra = Object.entries(e)
      .filter(([k]) => !['type', 'sandbox', 'action', 'ok', 'at', 'machineId', 'result'].includes(k))
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' ');
    console.log(`${t} ${type}${who}${act}${res} ${c.dim(extra.slice(0, 150))}`);
  };
  events.slice(0, limit).forEach(print);
  if (!flags.f) return;
  const seen = new Set(events.slice(0, 500).map(key));
  info('mengikuti event... (Ctrl+C untuk berhenti)');
  for (;;) {
    await sleep(2500);
    try {
      const d = await api('GET', '/api/events');
      const fresh = (d.events || []).filter((e) => !seen.has(key(e)));
      fresh.reverse().forEach(print);
      for (const e of (d.events || []).slice(0, 500)) seen.add(key(e));
    } catch (e) { console.error(c.yellow('! ') + e.message); }
  }
}

async function cmdWebhook(sub, flags) {
  if (sub === 'setup') {
    const body = {};
    if (flags.url || flags.base) body.publicBaseUrl = flags.url || flags.base;
    const r = await api('POST', '/api/webhooks/setup', body);
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    if (r.ok) ok(`webhook siap -> ${r.desiredUrl}`);
    else {
      console.error(c.red('X ') + (r.message || JSON.stringify(r.error) || 'setup gagal'));
      process.exitCode = 1;
    }
    for (const g of r.results || []) {
      console.log(`  ${g.ok ? c.green('v') : c.red('x')} org ${g.orgId || '?'} ${c.dim((g.sandboxes || []).join(', '))}${g.error ? ' - ' + JSON.stringify(g.error).slice(0, 120) : ''}`);
    }
    return;
  }
  const r = await api('GET', '/api/webhooks/status');
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  console.log(c.bold('\n  Webhook Instabox'));
  console.log('  desired  ' + c.cyan(r.desiredUrl || '-'));
  console.log('  base     ' + (r.publicBaseUrl || c.yellow('(belum di-set)')));
  for (const g of r.groups || []) {
    const names = (g.sandboxes || []).map((s) => (typeof s === 'string' ? s : s?.name || s?.machineId || '?')).join(', ');
    console.log(`  org ${g.orgId || '?'}  ${g.existing ? c.green('ada') : c.red('belum')}  ${c.dim(names)}`);
  }
  const ar = Object.entries(r.autoRevive || {})
    .map(([k, v]) => `${k}=${v ? c.green('on') : c.dim('off')}`).join('  ');
  console.log('  auto-revive  ' + ar);
  console.log(c.dim('  setup: sm webhook setup --url https://domain-kamu/...\n'));
}

async function cmdAutoRevive(flags, args) {
  const [name, stateArg] = args;
  if (!name) {
    const r = await api('GET', '/api/webhooks/status');
    if (flags.json) return console.log(JSON.stringify(r.autoRevive || {}, null, 2));
    console.log(c.bold('\n  Auto-revive'));
    for (const [k, v] of Object.entries(r.autoRevive || {})) {
      console.log('  ' + pad(k, 16) + (v ? c.green('on') : c.dim('off')));
    }
    console.log(c.dim('\n  ubah: sm auto-revive <nama> on|off\n'));
    return;
  }
  if (!stateArg || !/^(on|off|true|false|1|0)$/i.test(stateArg)) {
    die('Pemakaian: sm auto-revive <nama> on|off');
  }
  const on = /^(on|true|1)$/i.test(stateArg);
  const cur = (await api('GET', '/api/webhooks/status')).autoRevive || {};
  const updates = { ...Object.fromEntries(Object.entries(cur).map(([k, v]) => [k, !!v])), [name]: on };
  const r = await api('POST', '/api/webhooks/auto-revive', { autoRevive: updates });
  if (flags.json) return console.log(JSON.stringify(r, null, 2));
  ok(`auto-revive ${c.bold(name)} -> ${on ? c.green('on') : c.dim('off')}`);
}

// ---------------------------------------------------------------- config / ssh
async function cmdConfig(sub, flags, args) {
  if (sub === 'sync') {
    const r = await api('POST', '/api/sandboxes/sync-ssh', {});
    if (flags.json) return console.log(JSON.stringify(r, null, 2));
    ok(`sync selesai (${r.sandboxes?.length || 0} entri) - ${r.path || '~/.ssh/config'}`);
    return;
  }
  const cur = (await api('GET', '/api/sandboxes/config')).sandboxes || [];
  if (!sub || sub === 'list') {
    if (flags.json) return console.log(JSON.stringify(redact(cur), null, 2));
    console.log(table(['NAME', 'PROVIDER', 'MACHINE', 'APIKEY', 'SSH', 'SAVED'],
      cur.map((s) => [
        s.name, s.provider, s.machineId || '-',
        s.apiKey ? s.apiKey.slice(0, 10) + '...' : '-',
        s.ssh || '-', s.saved ? 'yes' : s.fromSshConfig ? 'ssh-config' : '',
      ])));
    return;
  }
  if (sub === 'add') {
    const name = args[0];
    if (!name) die('Pemakaian: sm config add <nama> --api-key <key> --machine-id <id> [--ssh "ssh ..."]');
    const next = [...cur.filter((s) => s.name.toLowerCase() !== name.toLowerCase()), {
      name,
      apiKey: flags['api-key'] || '',
      machineId: flags['machine-id'] || '',
      ssh: flags.ssh || '',
      provider: flags.provider || 'instabox',
    }];
    const r = await api('POST', '/api/sandboxes/config', { sandboxes: next });
    ok(`sandbox "${name}" ditambahkan${r.sshConfigSync ? ' + sinkron ~/.ssh/config' : ''}`);
    return;
  }
  if (sub === 'rm' || sub === 'remove') {
    const name = args[0];
    if (!name) die('Pemakaian: sm config rm <nama>');
    const next = cur.filter((s) => s.name.toLowerCase() !== name.toLowerCase());
    if (next.length === cur.length) die(`"${name}" tidak ada di config.`);
    await api('POST', '/api/sandboxes/config', { sandboxes: next });
    ok(`sandbox "${name}" dihapus dari config`);
    return;
  }
  die(`Subcommand config "${sub}" tidak dikenal.`, 'list | add | rm | sync');
}

async function cmdSsh(flags, args) {
  const name = args[0];
  if (!name) die('Pemakaian: sm ssh <nama> [--cmd "perintah"] [--exec]');
  const list = await listSandboxes();
  const sb = pickSandbox(list, name);
  if (!sb) die(`Sandbox "${name}" tidak dikenal.`);
  const target = sb.sshHost || sb.name;
  if (flags.cmd) {
    const argv = ['ssh', ...(sb.sshPort && sb.sshPort !== '22' ? ['-p', String(sb.sshPort)] : []), target, flags.cmd];
    info(argv.join(' '));
    const child = spawn(argv[0], argv.slice(1), { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  if (flags.exec) {
    const child = spawn('ssh', [target], { stdio: 'inherit' });
    child.on('exit', (code) => process.exit(code ?? 1));
    return;
  }
  if (flags.json) return console.log(JSON.stringify({ name: sb.name, ssh: sb.ssh, sshHost: sb.sshHost, state: sb.state }, null, 2));
  console.log('  ' + c.cyan(sb.ssh || `ssh ${target}`));
  console.log(c.dim('  connect: sm ssh ' + sb.name + ' --exec'));
}

// ---------------------------------------------------------------- server manager
function serverPid() {
  try {
    const out = execFileSync('ss', ['-H', '-tlnp', `sport = :${process.env.PORT || 4173}`], { encoding: 'utf8', timeout: 5000 });
    const m = out.match(/users:\(\("([^"]+)",pid=(\d+)/);
    if (m) return { pid: Number(m[2]), process: m[1] };
  } catch {}
  return null;
}
async function cmdServer(sub, flags) {
  const pidInfo = serverPid();
  const alive = !!pidInfo;
  if (sub === 'status') {
    if (flags.json) return console.log(JSON.stringify({ running: alive, ...pidInfo, base: BASE }, null, 2));
    if (alive) ok(`server berjalan - pid ${pidInfo.pid} (${pidInfo.process}) di ${BASE}`);
    else console.log(c.red('X ') + `server TIDAK berjalan di ${BASE}`);
    try {
      await api('GET', '/health', undefined, { retries: 0 });
      ok('health endpoint merespons');
    } catch (e) { console.log(c.dim('  health: ' + e.message)); }
    return;
  }
  if (sub === 'log' || sub === 'logs') {
    const logPath = path.join(PROJECT_ROOT, 'server.log');
    if (!fs.existsSync(logPath)) die('server.log tidak ada.');
    const lines = fs.readFileSync(logPath, 'utf8').split('\n');
    console.log(lines.slice(Math.max(0, lines.length - (flags.n || 40))).join('\n'));
    return;
  }
  if (sub === 'start') {
    if (alive) return ok(`sudah berjalan (pid ${pidInfo.pid})`);
    const logPath = path.join(PROJECT_ROOT, 'server.log');
    const fd = fs.openSync(logPath, 'a');
    const child = spawn(process.execPath, ['server.js'], {
      cwd: PROJECT_ROOT, detached: true, stdio: ['ignore', fd, fd], env: process.env,
    });
    child.unref();
    fs.closeSync(fd);
    await sleep(1500);
    const p = serverPid();
    if (p) ok(`server dimulai - pid ${p.pid} · log: ${logPath}`);
    else {
      console.error(c.yellow('! ') + 'server belum terdeteksi listen - cek: sm server log');
      process.exitCode = 1;
    }
    return;
  }
  if (sub === 'stop') {
    if (!alive) return info('server memang tidak berjalan.');
    try { process.kill(pidInfo.pid, 'SIGTERM'); } catch (e) { die(`gagal kill: ${e.message}`); }
    for (let i = 0; i < 20 && serverPid(); i++) await sleep(500);
    if (serverPid()) { try { process.kill(pidInfo.pid, 'SIGKILL'); } catch {} await sleep(500); }
    ok(`server dihentikan (pid ${pidInfo.pid})`);
    return;
  }
  if (sub === 'restart') {
    if (alive) { await cmdServer('stop', flags); await sleep(500); }
    await cmdServer('start', flags);
    return;
  }
  die(`Subcommand server "${sub}" tidak dikenal.`, 'status | start | stop | restart | log');
}

async function cmdHealth(flags) {
  const out = { base: BASE, server: null, listeners: localListeners().length, sandboxes: null };
  try { out.server = await api('GET', '/health', undefined, { retries: 0 }); }
  catch (e) { out.server = { error: e.message }; }
  try {
    const list = await listSandboxes();
    const st = (x) => list.filter((s) => String(s.state).toLowerCase() === x).length;
    out.sandboxes = {
      total: list.length,
      instabox: list.filter((s) => s.isInstabox).length,
      running: st('running'), suspended: st('suspended'), stopped: st('stopped'), unreachable: st('unreachable'),
    };
  } catch (e) { out.sandboxes = { error: e.message }; }
  if (flags.json) return console.log(JSON.stringify(out, null, 2));
  console.log(c.bold('\n  Health'));
  console.log('  server     ' + (out.server?.ok ? c.green('ok') : c.red(out.server?.error || 'error')) + c.dim(`  ${BASE}`));
  console.log('  sandboxes  ' + (out.sandboxes?.total != null
    ? `${out.sandboxes.total} total · ${c.green(out.sandboxes.running + ' running')} · ${c.yellow(out.sandboxes.suspended + ' suspended')} · ${c.red(out.sandboxes.stopped + ' stopped')} · ${c.red(out.sandboxes.unreachable + ' unreachable')}`
    : c.red(out.sandboxes?.error || 'error')));
  console.log('  listeners  ' + out.listeners + c.dim(' port listening di sandbox ini'));
  console.log('');
}

// ---------------------------------------------------------------- help
function helpText() {
  return `
${c.bold('sm')} — Sandbox Manager CLI ${c.dim('(manage Instabox dari sandbox ini)')}

${c.bold('AUTH')}
  login [--password pw] [--no-save]   login ke server manager (sesi di ~/.sm)
  logout                              hapus sesi + kredensial

${c.bold('STATUS')}
  status [nama...]                    ringkas semua sandbox + state  (alias: ls, list)
  sandboxes [--down|--up]             daftar SEMUA sandbox (instabox + ssh) + filter
            [--instabox|--ssh-only] [--state <s>]
  info <nama>                         detail: state, machine, port forward, VNC
  health                              cek server manager + ringkasan host
  events [-n 20] [-f]                 riwayat event; -f = follow (watch)

${c.bold('AKSI MESIN INSTABOX')}
  revive [nama...] [--dry-run] [--wait]   resume/start SEMUA instabox yang mati
                                          (alias: resume-down, wake, up)
  start   <nama...> [--all] [--wait]  nyalakan
  resume  <nama...> [--all] [--wait]  lanjutkan dari suspend
  suspend <nama...> [--all]           jeda
  stop    <nama...> [--all]           matikan
  restart <nama...> [--all]           restart
  reboot  <nama...> [--all]           reboot
  --wait                  tunggu state sesuai (running/stopped/suspended)
  --wait-timeout <detik>  default 120
  ${c.dim('catatan: `--all` melewati sandbox yang sudah di state tujuan')}
  ${c.dim('catatan: suspend + auto-revive ON = mesin langsung dibangun lagi oleh webhook')}

${c.bold('PORT')}
  ports <nama>                        daftar port forward Instabox
  open <nama> <port> [--label x] [--proto http]   expose port di mesin Instabox
  close <nama> <port|id|nama>         hapus port forward
  local-ports                         port listening di sandbox ini (ss -tlnp)
  check <port> [--sandbox <nama>]     cek listening + connectable + status expose
  open-local <port> [--open]          URL akses port lokal (loopback + tailscale)

${c.bold('VNC')}
  vnc <nama> [--open]                 siapkan port VNC + URL viewer
  vnc-sessions                        sesi VNC aktif lewat proxy
  vnc-stop                            hentikan semua sesi VNC

${c.bold('WEBHOOK / AUTO-REVIVE')}
  webhook [status|setup] [--url https://...]   status/setup webhook Instabox
  auto-revive [nama] [on|off]                  lihat/ubah auto-revive

${c.bold('CONFIG & SSH')}
  config [list|add <nama>|rm <nama>|sync]      kelola daftar sandbox + sync ~/.ssh/config
  ssh <nama> [--exec] [--cmd "..."]            lihat/perintah SSH ke sandbox

${c.bold('SERVER MANAGER')}
  server [status|start|stop|restart|log]       kelola server.js lokal

${c.bold('GLOBAL FLAGS')}
  --json          output JSON        ·  --base URL (default ${BASE})
  --password pw   password login     ·  SM_PASSWORD / SM_BASE env juga didukung
  --open          buka browser       ·  -n <num>   ·  -f (follow)

${c.dim('Contoh:')}
  sm sandboxes --down
  sm revive --wait
  sm status
  sm resume infra --wait
  sm open infra 3000 --label app
  sm check 4173 --sandbox infra
  sm start --all --wait
  sm events -f
`;
}

// ---------------------------------------------------------------- dispatch
const ALIASES = {
  ls: 'status', list: 'status', ps: 'status', watch: 'events',
  'local-ports': 'localports', serve: 'server', vncs: 'vnc-sessions',
  all: 'sandboxes', 'resume-down': 'revive', 'resume-all': 'revive',
  wake: 'revive', up: 'revive', reviveall: 'revive',
};
const ACTIONS = new Set(['start', 'stop', 'suspend', 'resume', 'restart', 'reboot']);
const KNOWN = new Set([
  'login', 'logout', 'status', 'sandboxes', 'revive', 'info', 'ports', 'open', 'close', 'localports', 'check',
  'open-local', 'vnc', 'vnc-sessions', 'vnc-stop', 'events', 'webhook', 'auto-revive',
  'config', 'ssh', 'server', 'health', ...ACTIONS,
]);

async function main() {
  const { flags, rest } = parseArgs(process.argv.slice(2));
  if (flags.base) BASE = String(flags.base).replace(/\/$/, '');
  let cmd = rest.shift();
  if (!cmd || cmd === 'help' || flags.help) { console.log(helpText()); return; }
  cmd = ALIASES[cmd] || cmd;

  if (!KNOWN.has(cmd)) {
    // shortcut: `sm infra` -> info infra
    try {
      const list = await api('GET', '/api/sandboxes', undefined, { retries: 0 });
      if ((list.sandboxes || []).some((s) => String(s.name).toLowerCase() === cmd.toLowerCase())) {
        return await cmdInfo(flags, [cmd, ...rest]);
      }
    } catch {}
    die(`Perintah "${cmd}" tidak dikenal.`, 'Lihat bantuan: sm help');
  }

  switch (cmd) {
    case 'login': return await cmdLogin(flags);
    case 'logout': return await cmdLogout();
    case 'status': return await cmdStatus(flags, rest);
    case 'sandboxes': return await cmdSandboxes(flags);
    case 'revive': return await cmdRevive(flags, rest);
    case 'info': return await cmdInfo(flags, rest);
    case 'ports': return await cmdPorts(flags, rest);
    case 'open': return await cmdOpen(flags, rest);
    case 'close': return await cmdClose(flags, rest);
    case 'localports': return await cmdLocalPorts(flags);
    case 'check': return await cmdCheck(flags, rest);
    case 'open-local': return await cmdOpenLocal(flags, rest);
    case 'vnc': return await cmdVnc(flags, rest);
    case 'vnc-sessions': return await cmdVncSessions(flags);
    case 'vnc-stop': return await cmdVncStop();
    case 'events': return await cmdEvents(flags);
    case 'webhook': return await cmdWebhook(rest[0] || 'status', flags);
    case 'auto-revive': return await cmdAutoRevive(flags, rest);
    case 'config': return await cmdConfig(rest.shift() || 'list', flags, rest);
    case 'ssh': return await cmdSsh(flags, rest);
    case 'server': return await cmdServer(rest.shift() || 'status', flags);
    case 'health': return await cmdHealth(flags);
    default:
      if (ACTIONS.has(cmd)) return await cmdAction(cmd, flags, rest);
      die(`Perintah "${cmd}" tidak dikenal.`, 'Lihat bantuan: sm help');
  }
}

main().catch((e) => {
  if (e instanceof ApiError) {
    console.error(c.red('X ') + e.message);
    if (e.hint) console.error(c.dim('  ' + e.hint));
  } else {
    console.error(c.red('X ') + (e?.stack || e?.message || String(e)));
  }
  process.exit(1);
});
