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

### Konfigurasi (`.env`)

```env
PORT=4173
MONGODB_URI="mongodb+srv://<user>:<pass>@<cluster-host>/"
MONGODB_DB_NAME=mem0
MONGODB_COLLECTION_NAME=mem0_memories
MEM0_EMBEDDING_DIMS=1536
MEM0_HISTORY_DB=data/mem0-history.db

# Wajib agar add/search bisa jalan (dipakai LLM ekstraksi fakta + embedding)
MEM0_LLM_API_KEY=...
MEM0_LLM_BASE_URL=          # opsional, OpenAI-compatible
MEM0_LLM_MODEL=gpt-4o-mini
MEM0_EMBEDDER_MODEL=text-embedding-3-small

OTAK_API_KEY=<token-acak>
```

Setelah mengubah `.env`: `pm2 restart sandbox-manager --update-env`.
Jangan commit `.env` atau `.pi/mcp.json` (keduanya sudah masuk `.gitignore`).

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

- **`ready=false` / `OTAK_NOT_READY`**: isi `MEM0_LLM_API_KEY` (atau `OPENAI_API_KEY`) lalu restart server. Tanpa ini, mem0 tidak bisa membuat embedding.
- **MongoDB SSL alert 80 / ENOTFOUND**: cek ulang connection string di Atlas (Connect → Drivers), pastikan cluster tidak di-pause, dan IP host ini masuk **Network Access → IP Access List**. `pi -p '/otak'` menampilkan error koneksi tanpa membocorkan password.
- **Pi tidak melihat tool**: jalankan `pi mcp list`; jika project belum trusted, konfigurasi global `~/.pi/agent/mcp.json` tetap dipakai. Setelah `/trust` di project, `.pi/mcp.json` yang dipakai (isi token harus sama).
