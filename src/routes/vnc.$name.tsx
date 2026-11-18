import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

export const Route = createFileRoute('/vnc/$name')({ component: VncPage })

function VncPage() {
  const { name } = Route.useParams()
  const [info, setInfo] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    fetch(`/api/sandboxes/${encodeURIComponent(name)}/vnc`)
      .then(r => r.json())
      .then(j => { if (alive) { setInfo(j); setErr(null) } })
      .catch(e => { if (alive) setErr(e.message || 'Gagal memuat info VNC') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [name])

  const localWs =
    typeof window !== 'undefined'
      ? `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/vnc-proxy?name=${encodeURIComponent(name)}&force=1`
      : `/vnc-proxy?name=${encodeURIComponent(name)}&force=1`
  const wsUrl = info?.wsProxy ? `${info.wsProxy}${info.wsProxy.includes('?') ? '&' : '?'}force=1` : localWs
  const iframeSrc = useMemo(() => `/vnc.html?name=${encodeURIComponent(name)}&force=1`, [name])
  const statusOk = !loading && !!info?.ok
  const statusLabel = loading ? 'LOADING…' : statusOk ? 'READY' : 'UNAVAILABLE'

  const card = 'border-[3px] border-black rounded-lg shadow-[4px_4px_0_#000] bg-white'
  const label = 'text-xs font-bold uppercase tracking-wide text-black/70'

  return (
    <div className="space-y-6">
      <div className={`${card} bg-[#FFEB3B] p-5 sm:p-6`}>
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
          <div className="min-w-0">
            <p className="inline-block mb-2 px-2 py-0.5 border-2 border-black rounded bg-white text-[11px] font-bold uppercase tracking-wider">Remote Desktop</p>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-black break-words">
              VNC <span className="inline-block align-middle mx-1">·</span> <span className="underline decoration-4 decoration-[#2196F3] underline-offset-4">{name}</span>
            </h1>
            <p className="mt-2 text-sm sm:text-base font-medium text-black/80 max-w-2xl">
              Desktop sandbox via proxy WebSocket server. Koneksi baru <span className="font-bold">selalu force takeover</span> (sesi lama diputus).
            </p>
          </div>
          <Link
            to="/"
            className="shrink-0 inline-flex items-center justify-center px-4 py-2.5 border-[3px] border-black rounded-lg bg-white text-black font-bold shadow-[4px_4px_0_#000] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_#000] active:translate-x-[4px] active:translate-y-[4px] active:shadow-none transition-all"
          >
            ← Dashboard
          </Link>
        </div>
      </div>

      {err && (
        <div className="border-[3px] border-black rounded-lg shadow-[4px_4px_0_#000] bg-[#FF5252] text-black px-4 py-3 font-semibold">
          <span className="inline-block mr-2 px-2 py-0.5 bg-white border-2 border-black rounded text-xs font-extrabold uppercase">Error</span>
          {err}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        <div className={`${card} p-4`}>
          <p className={label}>Status</p>
          <div className={`mt-2 inline-flex items-center px-3 py-1.5 border-[3px] border-black rounded-md font-extrabold text-sm shadow-[2px_2px_0_#000] ${statusOk ? 'bg-[#B9FBC0]' : loading ? 'bg-white' : 'bg-[#FF5252]'}`}>
            <span className={`mr-2 inline-block w-2.5 h-2.5 rounded-full border-2 border-black ${statusOk ? 'bg-emerald-500' : loading ? 'bg-amber-400' : 'bg-white'}`} />
            {statusLabel}
          </div>
          <p className="mt-2 text-xs font-medium text-black/70">
            {statusOk ? `Port ${info?.port?.port || '-'} · upstream siap` : (info?.error || info?.message || (loading ? 'Memuat info…' : 'VNC belum tersedia'))}
          </p>
        </div>
        <div className={`${card} p-4 bg-[#2196F3] text-black sm:col-span-2`}>
          <p className="text-xs font-bold uppercase tracking-wide text-black/80">Endpoint</p>
          <div className="mt-2 space-y-2 text-sm">
            <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
              <span className="font-extrabold shrink-0 sm:w-28">WS Proxy</span>
              <code className="font-mono text-xs bg-white border-2 border-black rounded px-2 py-1 break-all shadow-[2px_2px_0_#000]">{wsUrl}</code>
            </div>
            {info?.tcpVnc && (
              <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
                <span className="font-extrabold shrink-0 sm:w-28">TCP (RealVNC)</span>
                <code className="font-mono text-xs bg-white border-2 border-black rounded px-2 py-1 break-all shadow-[2px_2px_0_#000]">{info.tcpVnc}</code>
              </div>
            )}
            {info?.publicUrl && (
              <div className="flex flex-col sm:flex-row sm:items-start gap-1 sm:gap-3">
                <span className="font-extrabold shrink-0 sm:w-28">Public URL</span>
                <a className="font-mono text-xs bg-[#FFEB3B] border-2 border-black rounded px-2 py-1 break-all shadow-[2px_2px_0_#000] underline decoration-2" href={info.publicUrl} target="_blank" rel="noreferrer">{info.publicUrl}</a>
              </div>
            )}
          </div>
        </div>
      </div>

      <section className={`${card} overflow-hidden`}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b-[3px] border-black bg-[#FFEB3B]">
          <div>
            <h2 className="text-lg font-extrabold tracking-tight">Viewer</h2>
            <p className="text-xs font-semibold text-black/70">noVNC · RFB over WebSocket · force=1</p>
          </div>
          <div className="flex gap-2">
            <a href={iframeSrc} target="_blank" rel="noreferrer" className="hidden sm:inline-flex px-3 py-1.5 border-[3px] border-black rounded-md bg-white text-xs font-bold shadow-[3px_3px_0_#000] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[1px_1px_0_#000] transition-all">Buka tab baru</a>
          </div>
        </div>
        <div className="bg-[#111] border-t-0">
          <iframe
            title={`VNC ${name}`}
            src={iframeSrc}
            className="w-full block"
            style={{ height: '72vh', minHeight: 520, border: 0 }}
            allow="clipboard-read; clipboard-write; fullscreen"
          />
        </div>
      </section>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className={`${card} p-4 bg-white`}>
          <p className={label}>Catatan</p>
          <ul className="mt-2 text-sm font-medium text-black/80 list-disc pl-5 space-y-1">
            <li>Pastikan sandbox <b>running</b> dan punya desktop/VNC.</li>
            <li>Koneksi baru mengambil alih sesi lama (Instabox: 1 sesi/mesin).</li>
            <li>Jika 409, tutup viewer yang buka URL Instabox langsung lalu Connect lagi.</li>
          </ul>
        </div>
        <div className={`${card} p-4 bg-[#FF5252]`}>
          <p className="text-xs font-bold uppercase tracking-wide text-black/80">Tips cepat</p>
          <p className="mt-2 text-sm font-semibold text-black">
            Pakai viewer di halaman ini (proxy server) supaya force takeover & retry otomatis jalan. Hindari connect langsung ke public VNC URL Instabox.
          </p>
        </div>
      </div>
    </div>
  )
}
