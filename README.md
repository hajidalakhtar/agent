Welcome to your new TanStack Start app!

# Getting Started

To run this application:

```bash
npm install
npm run dev
```

# Building For Production

To build this application for production:

```bash
npm run build
```

## Styling

This project uses [Tailwind CSS](https://tailwindcss.com/) for styling.

### Removing Tailwind CSS

If you prefer not to use Tailwind CSS:

1. Remove the demo pages in `src/routes/demo/`
2. Replace the Tailwind import in `src/styles.css` with your own styles
3. Remove `tailwindcss()` from the plugins array in `vite.config.ts`
4. Remove `@tailwindcss/vite` and `tailwindcss` from `package.json`



## Routing

This project uses [TanStack Router](https://tanstack.com/router) with file-based routing. Routes are managed as files in `src/routes`.

### Adding A Route

To add a new route to your application just add a new file in the `./src/routes` directory.

TanStack will automatically generate the content of the route file for you.

Now that you have two routes you can use a `Link` component to navigate between them.

### Adding Links

To use SPA (Single Page Application) navigation you will need to import the `Link` component from `@tanstack/react-router`.

```tsx
import { Link } from "@tanstack/react-router";
```

Then anywhere in your JSX you can use it like so:

```tsx
<Link to="/about">About</Link>
```

This will create a link that will navigate to the `/about` route.

More information on the `Link` component can be found in the [Link documentation](https://tanstack.com/router/v1/docs/framework/react/api/router/linkComponent).

### Using A Layout

In the File Based Routing setup the layout is located in `src/routes/__root.tsx`. Anything you add to the root route will appear in all the routes. The route content will appear in the JSX where you render `{children}` in the `shellComponent`.

Here is an example layout that includes a header:

```tsx
import { HeadContent, Scripts, createRootRoute } from '@tanstack/react-router'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: 'utf-8' },
      { name: 'viewport', content: 'width=device-width, initial-scale=1' },
      { title: 'My App' },
    ],
  }),
  shellComponent: ({ children }) => (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        <header>
          <nav>
            <Link to="/">Home</Link>
            <Link to="/about">About</Link>
          </nav>
        </header>
        {children}
        <Scripts />
      </body>
    </html>
  ),
})
```

More information on layouts can be found in the [Layouts documentation](https://tanstack.com/router/latest/docs/framework/react/guide/routing-concepts#layouts).

## Server Functions

TanStack Start provides server functions that allow you to write server-side code that seamlessly integrates with your client components.

```tsx
import { createServerFn } from '@tanstack/react-start'

const getServerTime = createServerFn({
  method: 'GET',
}).handler(async () => {
  return new Date().toISOString()
})

// Use in a component
function MyComponent() {
  const [time, setTime] = useState('')
  
  useEffect(() => {
    getServerTime().then(setTime)
  }, [])
  
  return <div>Server time: {time}</div>
}
```

## API Routes

You can create API routes by using the `server` property in your route definitions:

```tsx
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'

export const Route = createFileRoute('/api/hello')({
  server: {
    handlers: {
      GET: () => json({ message: 'Hello, World!' }),
    },
  },
})
```

## Data Fetching

There are multiple ways to fetch data in your application. You can use TanStack Query to fetch data from a server. But you can also use the `loader` functionality built into TanStack Router to load the data for a route before it's rendered.

For example:

```tsx
import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/people')({
  loader: async () => {
    const response = await fetch('https://swapi.dev/api/people')
    return response.json()
  },
  component: PeopleComponent,
})

function PeopleComponent() {
  const data = Route.useLoaderData()
  return (
    <ul>
      {data.results.map((person) => (
        <li key={person.name}>{person.name}</li>
      ))}
    </ul>
  )
}
```

Loaders simplify your data fetching logic dramatically. Check out more information in the [Loader documentation](https://tanstack.com/router/latest/docs/framework/react/guide/data-loading#loader-parameters).



# Learn More

You can learn more about all of the offerings from TanStack in the [TanStack documentation](https://tanstack.com).

For TanStack Start specific documentation, visit [TanStack Start](https://tanstack.com/start).

---

## Otak — mem0 API + MCP untuk Pi Agent

`Otak` adalah lapisan memory jangka panjang mem0 OSS yang jalan di server ini, backend-nya MongoDB Atlas, dan bisa dipanggil Pi lewat **MCP** maupun REST.

### Komponen

| File | Fungsi |
|---|---|
| `mem0-core.js` | Inisialisasi `Memory` dari `mem0ai/oss` dengan vector store MongoDB + SQLite history; semua operasi memory |
| `mem0-cloud.js` | Client hosted Mem0 REST API (`data-otak.hajid.dev`) untuk halaman `/memories`: login/refresh JWT, latensi, redaksi secret |
| `mcp-otak.js` | MCP server stateless (streamable HTTP) dengan 9 tools |
| `otak-auth.js` | Auth Bearer `OTAK_API_KEY` untuk REST & MCP |
| `server.js` | Endpoint REST `/api/mem0/*` dan MCP `/mcp` |
| `otak-extension/otak.ts` | **Pi extension `otak`** — register MCP server + command `/otak` |
| `.pi/mcp.json` | Konfigurasi MCP level project (lokal, berisi token; `gitignored`) |

Extension sudah **terpasang di Pi ini** lewat symlink:
`~/.pi/agent/extensions/otak.ts -> <project>/otak-extension/otak.ts`.
Konfigurasi MCP juga ada di `~/.pi/agent/mcp.json` (server `otak`, exposed langsung). Untuk memastikan:

```bash
pi mcp list          # otak: connected, 9 tools
pi -p '/otak help'   # perintah dari extension
pi -p '/otak'        # status koneksi MongoDB + konfigurasi
```

Di sesi Pi, tools tersedia sebagai `mcp__otak__add_memory`, `mcp__otak__search_memories`, dll.
Contoh prompt: *"Cari di otak apa yang kita putuskan soal sandbox qi, lalu simpan keputusan barunya."*

Secara default extension dan konfigurasi MCP memakai base URL **`https://agent.hajid.dev`**:
MCP di `https://agent.hajid.dev/mcp`, REST di `https://agent.hajid.dev/api/mem0/*`.
Override lewat env (di `.env` atau environment Pi):

```env
OTAK_API_BASE_URL=https://agent.hajid.dev   # base REST + MCP
OTAK_MCP_URL=https://agent.hajid.dev/mcp    # opsional, override URL MCP saja
OTAK_API_KEY=...                             # Bearer token untuk keduanya
```

Jika `OTAK_MCP_URL` diisi, endpoint REST tetap diambil dari `OTAK_API_BASE_URL`
apabila variabel itu diset; kalau tidak, base REST diturunkan dari URL MCP.

### Konfigurasi (`.env`)

```env
PORT=4173
MONGODB_URI="mongodb+srv://<user>:<pass>@<cluster-host>/"
MONGODB_DB_NAME=mem0
MONGODB_COLLECTION_NAME=mem0_memories
MEM0_EMBEDDING_DIMS=1024                # sesuaikan dengan dimensi model embedding
MEM0_HISTORY_DB=data/mem0-history.db

# Wajib agar add/search bisa jalan (dipakai LLM ekstraksi fakta + embedding)
MEM0_LLM_API_KEY=...
MEM0_LLM_BASE_URL=https://ai.hajid.dev/v1   # opsional, OpenAI-compatible
MEM0_LLM_MODEL=free
MEM0_EMBEDDER_BASE_URL=https://ai.hajid.dev/v1  # opsional, endpoint embedding khusus
MEM0_EMBEDDER_API_KEY=...                   # opsional, override API key embedding
MEM0_EMBEDDER_MODEL=jina/jina-embeddings-v5-text-small

OTAK_API_KEY=<token-acak>
```

Setelah mengubah `.env`: `pm2 restart sandbox-manager --update-env`.
Jangan commit `.env` atau `.pi/mcp.json` (keduanya sudah masuk `.gitignore`).

### Web UI `/memories` — Mem0 Cloud (data-otak.hajid.dev)

Halaman **https://agent.hajid.dev/memories** membaca data langsung dari hosted Mem0 REST API
**https://data-otak.hajid.dev** (lihat dokumentasi Swagger-nya di `/docs`).
Semua panggilan lewat proxy server `/api/mem0/cloud/*`, jadi kredensial dan JWT tidak pernah
masuk ke bundle browser (sekaligus menghindari CORS upstream).

Fitur halaman:

- **Memories** — list semua memory (admin) / filter `user_id`, `agent_id`, `run_id`, `top_k`, `show_expired`;
  semantic search + threshold; tambah/ubah/hapus memory; detail + riwayat (`history`).
- **Entity** — daftar user/agent/run + jumlah memory, klik untuk filter, hapus entity.
- **Latensi & Request** — log `/requests` dari Mem0 Cloud: avg / p50 / p95 / max, error rate,
  ringkasan per endpoint, auto-refresh 5 detik, plus tombol **Test latensi** yang mengukur
  `/auth/me`, `/memories`, `/entities`, `/requests`.
- **Konfigurasi** — `/configure` + provider (secret diredaksi) dan tombol reset semua memory.
- **API Keys** — list, buat (key hanya tampil sekali), dan revoke.

Variabel `.env` tambahan:

```env
OTAK_CLOUD_BASE=https://data-otak.hajid.dev
OTAK_CLOUD_EMAIL=hajidalakhtar@gmail.com
OTAK_CLOUD_PASSWORD=...            # akun admin Mem0 Cloud
OTAK_CLOUD_TIMEOUT_MS=60000        # opsional
```

Endpoint proxy (dipakai UI, bukan untuk publik):

| Method | Path | Fungsi |
|---|---|---|
| GET | `/api/mem0/cloud/status` | status login, user, expiry token, latensi login |
| POST | `/api/mem0/cloud/list` | list memory `{ userId, agentId, runId, topK, showExpired }` |
| POST | `/api/mem0/cloud/search` | semantic search (wajib salah satu scope) |
| POST | `/api/mem0/cloud/add` | tambah memory |
| GET/PUT/DELETE | `/api/mem0/cloud/memory/:id` | detail / update / hapus memory |
| GET | `/api/mem0/cloud/history/:id` | riwayat memory |
| POST | `/api/mem0/cloud/delete-all` | hapus semua memory dalam scope |
| GET | `/api/mem0/cloud/entities` | daftar entity |
| DELETE | `/api/mem0/cloud/entity/:type/:id` | hapus entity (`user`/`agent`/`run`) |
| GET | `/api/mem0/cloud/requests?limit=` | log request + latency |
| GET | `/api/mem0/cloud/config` · `/providers` | konfigurasi Mem0 Cloud (secret diredaksi) |
| GET/POST/DELETE | `/api/mem0/cloud/keys[/:id]` | API key Mem0 Cloud |
| POST | `/api/mem0/cloud/ping` | probe latensi multi-endpoint |
| POST | `/api/mem0/cloud/reset` | reset seluruh memory (hati-hati) |

Operasi baca (`status`, `list`, `search`, `ping`, entity/request/config/keys GET) terbuka seperti
proxy `view` lama. Operasi tulis (`add`, update, delete, delete-all, reset, create/revoke key)
butuh header `Authorization: Bearer $OTAK_API_KEY` — isi token itu di kolom yang tersedia di UI
(disimpan di `localStorage` browser).

### REST API

Semua endpoint butuh header `Authorization: Bearer $OTAK_API_KEY` (atau `X-Otak-Key`).

| Method | Path | Body / parameter |
|---|---|---|
| GET | `/api/mem0/status` | status koneksi Mongo + konfigurasi |
| GET | `/api/mem0/config` | konfigurasi tanpa secret |
| POST | `/api/mem0/add` | `{ "text": "...", "userId": "pi", "metadata": {} }` atau `{ "messages": [{role,content}] }` |
| POST | `/api/mem0/search` | `{ "query": "...", "topK": 5, "userId": "pi" }` |
| POST/GET | `/api/mem0/all` | `{ "userId": "pi", "topK": 20 }` / query string |
| GET | `/api/mem0/memory/:id` | detail memory |
| PATCH/PUT | `/api/mem0/memory/:id` | `{ "text": "...", "metadata": {} }` |
| DELETE | `/api/mem0/memory/:id` | hapus satu memory |
| POST/DELETE | `/api/mem0/delete-all` | `{ "userId": "pi" }` (wajib salah satu scope) |
| GET | `/api/mem0/history/:id` | riwayat perubahan memory |

Contoh:

```bash
KEY=$(grep '^OTAK_API_KEY=' .env | cut -d= -f2- | tr -d '"')
curl -H "Authorization: Bearer $KEY" http://127.0.0.1:4173/api/mem0/status
curl -X POST -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
  -d '{"text":"Keputusan utama: pakai MongoDB Atlas untuk mem0","userId":"pi"}' \
  http://127.0.0.1:4173/api/mem0/add
```

### MCP tools

`add_memory`, `search_memories`, `get_memories`, `get_memory`, `update_memory`,
`delete_memory`, `delete_all_memories`, `memory_history`, `mem0_status`.

Smoke test REST + MCP (tanpa butuh LLM key):

```bash
npm run otak:smoke
```

### Troubleshooting

- **`ready=false` / `OTAK_NOT_READY`**: isi `MEM0_LLM_API_KEY` dan `MEM0_EMBEDDER_API_KEY` lalu restart server. Tanpa ini, mem0 tidak bisa membuat embedding.
- **Ganti model embedding (mis. ke `jina/jina-embeddings-v5-text-small`, 1024 dimensi)**: `MEM0_EMBEDDING_DIMS` harus ikut diubah, dan vector search index di MongoDB dibuat ulang dengan dimensi tersebut. Memory lama yang masih 1536 dimensi perlu di-*re-add* (atau pakai collection baru lewat `MONGODB_COLLECTION_NAME`).
- **MongoDB SSL alert 80 / ENOTFOUND**: cek ulang connection string di Atlas (Connect → Drivers), pastikan cluster tidak di-pause, dan IP host ini masuk **Network Access → IP Access List**. `pi -p '/otak'` menampilkan error koneksi tanpa membocorkan password.
- **Pi tidak melihat tool**: jalankan `pi mcp list`; jika project belum trusted, konfigurasi global `~/.pi/agent/mcp.json` tetap dipakai. Setelah `/trust` di project, `.pi/mcp.json` yang dipakai (isi token harus sama).

---

# CLI `sm` — Sandbox Manager (Instabox)

CLI untuk mengelola sandbox **Instabox** dari dalam sandbox ini. Semua perintah lewat
server manager lokal (`server.js`), jadi cooldown, webhook, auto-revive, dan VNC proxy
tetap ikut bekerja.

Terinstall sebagai `sm` (symlink ke `~/.local/bin/sm`, sudah di `PATH`), atau lewat
`npm run sm -- <perintah>` / `node bin/sm.mjs <perintah>`.

```bash
sm login                 # sekali saja; sesi di ~/.sm, auto-relogin setelah server restart
sm status                # ringkas semua host + state (alias: sm ls)
sm sandboxes             # daftar SEMUA sandbox (instabox + ssh), filter di bawah
sm info infra            # detail: machine, port forward, VNC (atau: sm infra)
sm health                # cek server manager + ringkasan host
```

Filter `sm sandboxes` (bisa digabung):

```bash
sm sandboxes --down               # hanya yang mati (suspended/stopped/error/unreachable)
sm sandboxes --up                 # hanya yang hidup
sm sandboxes --instabox           # hanya mesin Instabox
sm sandboxes --ssh-only           # hanya host SSH biasa
sm sandboxes --state suspended    # state tertentu
```

### Aksi mesin Instabox

```bash
sm start infra            sm resume qa --wait
sm suspend agent-1        sm stop infra-2
sm restart infra-3        sm start --all --wait     # semua host Instabox

sm revive                 # nyalakan SEMUA Instabox yang mati (resume/start otomatis)
sm revive --dry-run       # lihat rencana dulu, tanpa eksekusi
sm revive infra agent-1   # hanya nama tertentu
sm revive --wait          # tunggu sampai running
```

`sm revive` (alias: `resume-down`, `wake`, `up`) memilih aksi per mesin: `suspended` →
`resume`, selain itu → `start` (dengan fallback `resume`→`start`). Mesin yang sudah
hidup atau sedang transisi dilewati. `--all` pada `start/resume/stop/suspend` juga
melewati sandbox yang sudah berada di state tujuan.

`--wait` menunggu state sesuai (`running`/`stopped`/`suspended`), timeout default 120s
(`--wait-timeout`). Catatan: kalau auto-revive nyala, `suspend` akan langsung dibalik
webhook menjadi `running` lagi.

### Port

```bash
sm ports infra                    # daftar port forward Instabox
sm open infra 3000 --label app    # expose port -> https://3000-xxx.instabox.tech
sm close infra 3000               # hapus (ref bisa nomor/id/nama)
sm local-ports                    # port listening di sandbox ini (ss -tlnp)
sm check 4173 --sandbox infra     # cek listening + connectable + status expose
sm open-local 8080 --open         # URL akses port lokal (loopback + tailscale)
```

### VNC, events, webhook

```bash
sm vnc infra --open               # siapkan port VNC + buka viewer
sm vnc-sessions                   sm vnc-stop
sm events -n 20                   sm events -f        # follow realtime
sm webhook                        sm webhook setup --url https://domain-kamu/...
sm auto-revive                    sm auto-revive infra off
```

### Config, SSH, server manager

```bash
sm config list                    sm config sync      # sinkron ~/.ssh/config
sm config add baru --api-key ibk_... --machine-id m_...
sm config rm lama
sm ssh infra                      sm ssh infra --cmd "uptime"
sm server status|start|stop|restart|log
```

### Flags global

`--json` (output JSON, secret otomatis disamarkan) · `--base URL` / `SM_BASE` ·
`--password` / `SM_PASSWORD` · `--open` · `-n <num>` · `-f` · `--yes`
