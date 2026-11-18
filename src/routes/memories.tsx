import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useState, type FormEvent } from 'react'

export const Route = createFileRoute('/memories')({ component: MemoriesPage })

type MemoryItem = {
  id: string
  memory: string
  score?: number
  metadata?: Record<string, any>
  createdAt?: string | number
  updatedAt?: string | number
  userId?: string
  agentId?: string
  runId?: string
}

type OtakStatus = {
  ready: boolean
  config: {
    ready: boolean
    missing: string[]
    backend: string
    llm: { provider: string; model: string; configured: boolean }
    vectorStore: { provider: string; database: string; collection: string }
  }
  mongo: { ok: boolean; error?: string; database?: string }
  hint?: string
}

type Detail = { item: MemoryItem; history: any[] }

const fmtDate = (value?: string | number) => {
  if (!value) return '-'
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString('id-ID')
}

function MemoriesPage() {
  const [status, setStatus] = useState<OtakStatus | null>(null)
  const [items, setItems] = useState<MemoryItem[]>([])
  const [userId, setUserId] = useState('pi')
  const [agentId, setAgentId] = useState('')
  const [runId, setRunId] = useState('')
  const [topK, setTopK] = useState('50')
  const [query, setQuery] = useState('')
  const [appliedQuery, setAppliedQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [token, setToken] = useState(() =>
    typeof localStorage !== 'undefined' ? localStorage.getItem('otak-token') || '' : '',
  )
  const [detail, setDetail] = useState<Detail | null>(null)
  const [detailBusy, setDetailBusy] = useState(false)
  const [addText, setAddText] = useState('')
  const [addMeta, setAddMeta] = useState('')
  const [addBusy, setAddBusy] = useState(false)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [clearBusy, setClearBusy] = useState(false)

  const scope = () => ({
    userId: userId.trim() || undefined,
    agentId: agentId.trim() || undefined,
    runId: runId.trim() || undefined,
  })

  async function request(path: string, init: RequestInit = {}) {
    const method = (init.method || 'GET').toUpperCase()
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> || {}) }
    if (method !== 'GET' && token) headers.Authorization = `Bearer ${token}`
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    const res = await fetch(path, { ...init, headers })
    let data: any = {}
    try { data = await res.json() } catch {}
    if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`)
    return data
  }

  const loadStatus = useCallback(async () => {
    try { setStatus(await request('/api/mem0/view/status')) }
    catch (e: any) { setError(e?.message || 'Gagal memuat status Otak') }
  }, [token])

  const loadMemories = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const path = appliedQuery.trim() ? '/api/mem0/view/search' : '/api/mem0/view/list'
      const body = {
        ...scope(),
        topK: Number(topK) || 50,
        ...(appliedQuery.trim() ? { query: appliedQuery.trim() } : {}),
      }
      const data = await request(path, { method: 'POST', body: JSON.stringify(body) })
      setItems(data?.results || [])
    } catch (e: any) {
      setItems([])
      setError(e?.message || 'Gagal memuat memory')
    } finally {
      setLoading(false)
    }
  }, [token, userId, agentId, runId, topK, appliedQuery])

  useEffect(() => { loadStatus() }, [loadStatus])
  useEffect(() => { loadMemories() }, [loadMemories])

  function saveToken(value: string) {
    setToken(value)
    if (typeof localStorage !== 'undefined') {
      if (value) localStorage.setItem('otak-token', value)
      else localStorage.removeItem('otak-token')
    }
  }

  function doSearch(e: FormEvent) {
    e.preventDefault()
    setAppliedQuery(query)
  }

  function showAll() {
    setQuery('')
    setAppliedQuery('')
  }

  async function addMemory(e: FormEvent) {
    e.preventDefault()
    if (!addText.trim()) return
    if (!token) { setNotice({ kind: 'err', text: 'Isi OTAK_API_KEY dulu untuk menambah memory.' }); return }
    setAddBusy(true)
    setNotice(null)
    try {
      let metadata: Record<string, any> | undefined
      if (addMeta.trim()) metadata = JSON.parse(addMeta)
      await request('/api/mem0/add', {
        method: 'POST',
        body: JSON.stringify({ text: addText.trim(), ...scope(), ...(metadata ? { metadata } : {}) }),
      })
      setAddText('')
      setAddMeta('')
      setNotice({ kind: 'ok', text: 'Memory berhasil disimpan ke mem0.' })
      await loadMemories()
    } catch (err: any) {
      setNotice({ kind: 'err', text: `Gagal menyimpan: ${err?.message || err}` })
    } finally {
      setAddBusy(false)
    }
  }

  async function deleteMemory(item: MemoryItem) {
    if (!token) { setNotice({ kind: 'err', text: 'Isi OTAK_API_KEY dulu untuk menghapus memory.' }); return }
    if (!confirm(`Hapus memory ini?\n\n${item.memory.slice(0, 160)}`)) return
    setBusyId(item.id)
    setNotice(null)
    try {
      await request(`/api/mem0/memory/${encodeURIComponent(item.id)}`, { method: 'DELETE' })
      setNotice({ kind: 'ok', text: 'Memory dihapus.' })
      if (detail?.item.id === item.id) setDetail(null)
      await loadMemories()
    } catch (err: any) {
      setNotice({ kind: 'err', text: `Gagal menghapus: ${err?.message || err}` })
    } finally {
      setBusyId(null)
    }
  }

  async function clearAll() {
    if (!token) { setNotice({ kind: 'err', text: 'Isi OTAK_API_KEY dulu untuk menghapus semua memory.' }); return }
    const s = scope()
    if (!s.userId && !s.agentId && !s.runId) {
      setNotice({ kind: 'err', text: 'Isi scope (userId / agentId / runId) dulu.' })
      return
    }
    if (!confirm(`Hapus SEMUA memory untuk scope ${JSON.stringify(s)}? Tindakan ini tidak bisa dibatalkan.`)) return
    setClearBusy(true)
    setNotice(null)
    try {
      await request('/api/mem0/delete-all', { method: 'POST', body: JSON.stringify(s) })
      setNotice({ kind: 'ok', text: 'Semua memory dalam scope dihapus.' })
      await loadMemories()
    } catch (err: any) {
      setNotice({ kind: 'err', text: `Gagal menghapus: ${err?.message || err}` })
    } finally {
      setClearBusy(false)
    }
  }

  async function openDetail(item: MemoryItem) {
    setDetailBusy(true)
    setDetail({ item, history: [] })
    try {
      const [one, history] = await Promise.all([
        request(`/api/mem0/view/memory/${encodeURIComponent(item.id)}`),
        request(`/api/mem0/view/history/${encodeURIComponent(item.id)}`).catch(() => []),
      ])
      setDetail({ item: one?.memory ? one : item, history: Array.isArray(history) ? history : [] })
    } catch (err: any) {
      setNotice({ kind: 'err', text: `Gagal memuat detail: ${err?.message || err}` })
    } finally {
      setDetailBusy(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold tracking-tight">Otak · Memory</h1>
          <p className="text-sm font-semibold opacity-70 mt-1">
            Isi memori dari mem0 OSS (MongoDB Atlas) — dipakai Pi lewat MCP.
          </p>
        </div>
        <div className="flex gap-2">
          <button className="nb-btn nb-btn-blue" onClick={() => { loadStatus(); loadMemories() }} disabled={loading}>
            ↻ Refresh
          </button>
        </div>
      </div>

      {/* Status */}
      <div className={`nb-card p-4 ${status?.ready ? 'bg-[#B9FBC0]' : 'bg-[#FFF3C4]'}`}>
        <div className="flex flex-wrap items-center gap-2">
          <span className="nb-badge bg-white">{status?.ready ? 'READY' : 'BELUM SIAP'}</span>
          <span className="text-xs font-bold">
            {status?.config?.backend || 'mem0 OSS'} · MongoDB:{' '}
            {status?.mongo?.ok ? `terhubung (${status.mongo.database})` : 'gagal terhubung'}
          </span>
        </div>
        {status?.mongo?.ok === false && (
          <p className="mt-2 text-[11px] font-semibold break-all opacity-80">{status.mongo.error}</p>
        )}
        {!!status?.config?.missing?.length && (
          <p className="mt-2 text-xs font-bold">
            Kurang: {status.config.missing.join(', ')}. Isi di <code>.env</code> lalu{' '}
            <code>pm2 restart sandbox-manager --update-env</code>.
          </p>
        )}
      </div>

      {notice && (
        <div className={`nb-card p-3 text-sm font-bold ${notice.kind === 'ok' ? 'bg-[#B9FBC0]' : 'bg-[#FFCDD2]'}`}>
          {notice.text}
        </div>
      )}
      {error && <div className="nb-card p-3 text-sm font-bold bg-[#FFCDD2]">{error}</div>}

      {/* Toolbar */}
      <div className="nb-card p-4 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <label className="text-[11px] font-extrabold uppercase tracking-wide">
            userId
            <input className="nb-input mt-1 w-full" value={userId} onChange={e => setUserId(e.target.value)} placeholder="pi" />
          </label>
          <label className="text-[11px] font-extrabold uppercase tracking-wide">
            agentId
            <input className="nb-input mt-1 w-full" value={agentId} onChange={e => setAgentId(e.target.value)} placeholder="opsional" />
          </label>
          <label className="text-[11px] font-extrabold uppercase tracking-wide">
            runId
            <input className="nb-input mt-1 w-full" value={runId} onChange={e => setRunId(e.target.value)} placeholder="opsional" />
          </label>
          <label className="text-[11px] font-extrabold uppercase tracking-wide">
            Maksimal
            <select className="nb-select mt-1 w-full" value={topK} onChange={e => setTopK(e.target.value)}>
              {[10, 25, 50, 100, 200].map(n => <option key={n} value={n}>{n} memory</option>)}
            </select>
          </label>
        </div>
        <form onSubmit={doSearch} className="flex flex-wrap gap-2">
          <input
            className="nb-input flex-1 min-w-[200px]"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Cari memory (semantic search)..."
          />
          <button className="nb-btn nb-btn-primary" type="submit" disabled={loading}>Cari</button>
          <button className="nb-btn" type="button" onClick={showAll} disabled={loading}>Semua</button>
          {appliedQuery && <span className="self-center text-[11px] font-bold">filter: “{appliedQuery}”</span>}
        </form>
        <div className="flex flex-wrap items-center gap-2 border-t-2 border-black pt-3">
          <label className="text-[11px] font-extrabold uppercase tracking-wide">OTAK_API_KEY (untuk tambah/hapus)</label>
          <input
            type="password"
            className="nb-input flex-1 min-w-[180px]"
            value={token}
            onChange={e => saveToken(e.target.value)}
            placeholder="token disimpan lokal di browser ini"
            autoComplete="off"
          />
          {token && <button className="nb-btn !py-1 !px-2" onClick={() => saveToken('')}>Hapus</button>}
        </div>
      </div>

      {/* Add */}
      <form className="nb-card p-4 space-y-2" onSubmit={addMemory}>
        <div className="nb-section-title">Tambah memory</div>
        <textarea
          className="nb-input w-full min-h-[76px] resize-y"
          value={addText}
          onChange={e => setAddText(e.target.value)}
          placeholder="Contoh: Keputusan utama: pakai MongoDB Atlas untuk menyimpan memory mem0."
        />
        <div className="flex flex-wrap gap-2">
          <input
            className="nb-input flex-1 min-w-[200px]"
            value={addMeta}
            onChange={e => setAddMeta(e.target.value)}
            placeholder='Metadata JSON opsional, contoh: {"project":"otak"}'
          />
          <button className="nb-btn nb-btn-teal" type="submit" disabled={addBusy || !addText.trim()}>
            {addBusy ? 'Menyimpan...' : '+ Simpan'}
          </button>
          <button className="nb-btn nb-btn-red" type="button" onClick={clearAll} disabled={clearBusy}>
            {clearBusy ? 'Menghapus...' : 'Hapus semua (scope)'}
          </button>
        </div>
      </form>

      {/* List */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h2 className="nb-section-title !mb-0">
            Daftar memory {!loading && <span className="nb-badge bg-white ml-2">{items.length}</span>}
          </h2>
        </div>
        {loading && <div className="nb-card p-6 text-sm font-bold animate-pulse">Memuat memory dari mem0...</div>}
        {!loading && items.length === 0 && !error && (
          <div className="nb-card p-6 text-sm font-semibold">
            Belum ada memory dalam scope ini. Tambahkan lewat form di atas atau lewat Pi (tool <code>mcp__otak__add_memory</code>).
          </div>
        )}
        <div className="grid gap-3 md:grid-cols-2">
          {items.map((m) => {
            const meta = Object.entries(m.metadata || {}).filter(([, v]) =>
              v !== null && typeof v !== 'object',
            ).slice(0, 5)
            return (
              <div key={m.id} className="nb-card p-4 flex flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <span className="text-[10px] font-extrabold uppercase tracking-wider opacity-60">
                    {fmtDate(m.createdAt || m.updatedAt)}
                  </span>
                  <div className="flex gap-1">
                    {typeof m.score === 'number' && (
                      <span className="nb-badge bg-[#FFEB3B] !text-[9px]">skor {m.score.toFixed(2)}</span>
                    )}
                    {(m.userId || m.agentId || m.runId) && (
                      <span className="nb-badge bg-[#4ECDC4] !text-[9px]">
                        {m.userId || m.agentId || m.runId}
                      </span>
                    )}
                  </div>
                </div>
                <p className="text-sm font-semibold leading-snug whitespace-pre-wrap break-words">{m.memory}</p>
                {meta.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {meta.map(([k, v]) => (
                      <span key={k} className="nb-badge bg-white !text-[9px]">{k}: {String(v)}</span>
                    ))}
                  </div>
                )}
                <div className="mt-auto pt-1 flex items-center justify-between gap-2 border-t-2 border-dashed border-black/20">
                  <code className="text-[10px] opacity-60 truncate" title={m.id}>{m.id}</code>
                  <div className="flex gap-1">
                    <button className="nb-btn !py-1 !px-2 !text-[11px]" onClick={() => openDetail(m)}>Detail</button>
                    <button className="nb-btn nb-btn-red !py-1 !px-2 !text-[11px]" onClick={() => deleteMemory(m)} disabled={busyId === m.id}>
                      {busyId === m.id ? '...' : 'Hapus'}
                    </button>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Detail modal */}
      {detail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setDetail(null)}>
          <div className="nb-card w-full max-w-2xl max-h-[85vh] overflow-y-auto p-5" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between gap-3">
              <h2 className="nb-section-title !mb-0">Detail memory</h2>
              <button className="nb-btn !py-1 !px-2" onClick={() => setDetail(null)}>✕</button>
            </div>
            <p className="mt-3 text-sm font-semibold whitespace-pre-wrap break-words">{detail.item.memory}</p>
            <div className="mt-3 grid grid-cols-2 gap-2 text-[11px] font-bold">
              <div>ID: <code className="break-all">{detail.item.id}</code></div>
              <div>Dibuat: {fmtDate(detail.item.createdAt)}</div>
              <div>Diupdate: {fmtDate(detail.item.updatedAt)}</div>
              <div>Scope: {detail.item.userId || detail.item.agentId || detail.item.runId || '-'}</div>
            </div>
            <pre className="mt-3 p-2 bg-white border-2 border-black rounded-md text-[10px] overflow-x-auto">
              {JSON.stringify(detail.item.metadata || {}, null, 2)}
            </pre>
            <h3 className="nb-section-title mt-4">Riwayat perubahan</h3>
            {detailBusy ? (
              <p className="text-xs font-bold">Memuat riwayat...</p>
            ) : detail.history.length === 0 ? (
              <p className="text-xs font-semibold opacity-60">Tidak ada riwayat.</p>
            ) : (
              <div className="space-y-2">
                {detail.history.map((h: any, i: number) => (
                  <div key={h.id || i} className="border-2 border-black rounded-md p-2 text-[11px] font-semibold">
                    <span className="opacity-60">{fmtDate(h.createdAt || h.timestamp)}</span> · {h.event || h.action || h.operation || 'update'}
                    <pre className="mt-1 whitespace-pre-wrap break-all">{JSON.stringify(h, null, 2)}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
