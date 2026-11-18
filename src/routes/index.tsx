import { createFileRoute, Link } from '@tanstack/react-router'
import { useEffect, useMemo, useState } from 'react'

type Machine = { id: string; name: string; state: string; desiredState?: string; readyAt?: string; template?: {id:string}; spec?: {vcpus?:number; memMiB?:number}; updatedAt?: string; cooldownUntil?: string|null }
type SB = { name: string; apiKey?: string; machineId?: string; ssh: string; state: string; machine: Machine|null; error: string|null; isInstabox?: boolean; provider?: string; fromSshConfig?: boolean; capabilities?: { canView?: boolean; canAdd?: boolean; canAction?: boolean; canVnc?: boolean; canSuspend?: boolean }; tailscale?: any; sshHost?: string }
type SBConfig = { name: string; apiKey: string; machineId: string; ssh: string; isInstabox?: boolean; provider?: string; fromSshConfig?: boolean; saved?: boolean }

export const Route = createFileRoute('/')({ component: Home })

type StateKind = 'on' | 'suspended' | 'off' | 'unknown'
const ON_STATES = ['running', 'reachable', 'active', 'started', 'ready', 'healthy']
const OFF_STATES = ['stopped', 'stopping', 'error', 'unreachable', 'not_found', 'none', 'failed', 'terminated', 'off']
function stateKind(state?: string): StateKind {
  const s = (state || '').toLowerCase()
  if (ON_STATES.includes(s)) return 'on'
  if (s === 'suspended') return 'suspended'
  if (OFF_STATES.includes(s)) return 'off'
  return 'unknown'
}

function StatCard({ label, value, tone, hint, active, onClick }: { label: string; value: number; tone: string; hint: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint}
      aria-pressed={active}
      className={`nb-card ${tone} p-3 sm:p-4 text-left cursor-pointer transition-all hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-[2px_2px_0_#000] ${active ? 'outline outline-[4px] outline-black outline-offset-[3px]' : ''}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] sm:text-[11px] font-extrabold uppercase tracking-wider">{label}</span>
        {active && <span className="nb-badge bg-white !text-[9px]">filter</span>}
      </div>
      <div className="mt-1 text-3xl sm:text-4xl font-extrabold tracking-tight leading-none">{value}</div>
      <div className="mt-1.5 text-[10px] sm:text-[11px] font-bold opacity-70 leading-tight">{hint}</div>
    </button>
  )
}

function Badge({ state }: { state: string }) {
  const s = (state || '').toLowerCase()
  const bg =
    s === 'running' || s === 'reachable' ? 'bg-[#B9FBC0]' :
    s === 'suspended' ? 'bg-[#FFEB3B]' :
    s === 'stopped' || s === 'error' || s === 'unreachable' ? 'bg-[#FF5252]' : 'bg-white'
  return <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-extrabold uppercase tracking-wide border-2 border-black rounded-full shadow-[2px_2px_0_#000] ${bg}`}>{state || 'unknown'}</span>
}

function Home() {
  const [data, setData] = useState<{sandboxes:SB[], serverTime?:string}|null>(null)
  const [events, setEvents] = useState<any[]>([])
  const [webhookStatus, setWebhookStatus] = useState<any>(null)
  const [webhookUrlInput, setWebhookUrlInput] = useState('')
  const [webhookBusy, setWebhookBusy] = useState(false)
  const [autoRevive, setAutoRevive] = useState<Record<string, boolean>>({})
  const [arSaving, setArSaving] = useState<string | null>(null)
  const [err, setErr] = useState<string|null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<Record<string,string>>({})
  const [syncBusy, setSyncBusy] = useState(false)
  const [bulkBusy, setBulkBusy] = useState<string | null>(null)
  const [notice, setNotice] = useState<{kind:'ok'|'err', text:string}|null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [editRows, setEditRows] = useState<SBConfig[]>([])
  const [editSaving, setEditSaving] = useState(false)
  const [editLoading, setEditLoading] = useState(false)

  // Port forwarding modal
  const [pfOpen, setPfOpen] = useState(false)
  const [pfName, setPfName] = useState<string | null>(null)
  const [pfPorts, setPfPorts] = useState<any[]>([])
  const [pfLoading, setPfLoading] = useState(false)
  const [pfSaving, setPfSaving] = useState(false)
  const [pfPort, setPfPort] = useState('')
  const [pfLabel, setPfLabel] = useState('')
  const [pfProto, setPfProto] = useState('http')
  const [pfNotice, setPfNotice] = useState<{kind:'ok'|'err', text:string}|null>(null)
  const [listFilter, setListFilter] = useState<'all' | StateKind>('all')
  const [search, setSearch] = useState('')

  async function load() {
    try {
      const [sr, er, wr] = await Promise.all([fetch('/api/sandboxes'), fetch('/api/events'), fetch('/api/webhooks/status')])
      const s = await sr.json().catch(()=>({error:`HTTP ${sr.status}`}))
      const e = await er.json().catch(()=>({events:[]}))
      const w = await wr.json().catch(()=>null)
      if (!sr.ok) setErr(s?.error?.message || s?.error || `API error ${sr.status}`)
      else setErr(null)
      setData(s); setEvents(e.events||[]); if (w) { setWebhookStatus(w); if (w.autoRevive) setAutoRevive(w.autoRevive) }
    } catch (e:any) { setErr(e.message || 'Gagal memuat data') }
    finally { setLoading(false) }
  }
  useEffect(() => { load(); const t=setInterval(load, 8000); return ()=>clearInterval(t) }, [])

  async function syncSsh() {
    setSyncBusy(true); setNotice(null)
    try {
      const r = await fetch('/api/sandboxes/sync-ssh', { method: 'POST' })
      const j = await r.json().catch(()=>({}))
      if (r.ok && j.ok !== false) {
        const imp = j.imported ? `, import ${j.imported} dari SSH config` : ''
        const ts = j.tailscaleEnsure ? `, tailscale cek ${ (j.tailscaleEnsure.results||[]).length } host` : ''
        setNotice({ kind: 'ok', text: `Sync SSH↔app selesai (total ${j.total ?? '-'}${imp}${ts}).` })
        await load()
      } else {
        setNotice({ kind: 'err', text: `Sync gagal: ${j?.error || j?.message || `HTTP ${r.status}`}` })
      }
    } catch (e: any) {
      setNotice({ kind: 'err', text: `Sync gagal: ${e.message}` })
    } finally { setSyncBusy(false) }
  }

  async function openEdit() {
    setEditLoading(true); setNotice(null)
    try {
      const r = await fetch('/api/sandboxes/config')
      const j = await r.json().catch(()=>({}))
      const rows: SBConfig[] = (j.sandboxes || []).map((s:any)=>({ name:s.name||'', apiKey:s.apiKey||'', machineId:s.machineId||'', ssh:s.ssh||'', isInstabox: s.isInstabox, provider: s.provider || (s.isInstabox ? 'instabox' : 'ssh'), fromSshConfig: s.fromSshConfig, saved: s.saved }))
      setEditRows(rows.length ? rows : [{name:'', apiKey:'', machineId:'', ssh:'', isInstabox: true, provider: 'instabox', saved: true}])
      setEditOpen(true)
    } catch (e:any) { setNotice({kind:'err', text:`Gagal memuat config: ${e.message}`}) }
    finally { setEditLoading(false) }
  }
  function updateRow(i:number, field: keyof SBConfig, value:string) {
    setEditRows(rows => rows.map((r,idx)=> {
      if (idx !== i) return r
      if (field === 'provider') {
        const p = value === 'ssh' ? 'ssh' : 'instabox'
        return { ...r, provider: p, isInstabox: p !== 'ssh', ...(p === 'ssh' ? { apiKey: r.apiKey || '', machineId: r.machineId || '' } : {}) }
      }
      return { ...r, [field]: value }
    }))
  }
  function addRow() { setEditRows(rows => [...rows, {name:'', apiKey:'', machineId:'', ssh:'', isInstabox: true, provider: 'instabox', saved: true}]) }
  function removeRow(i:number) { setEditRows(rows => rows.filter((_,idx)=>idx!==i)) }
  async function saveEdit() {
    setEditSaving(true); setNotice(null)
    try {
      const cleaned = editRows.map(r=>{
        const provider = (r.provider === 'ssh' || r.isInstabox === false) ? 'ssh' : 'instabox'
        return {name:r.name.trim(), apiKey:(r.apiKey||'').trim(), machineId:(r.machineId||'').trim(), ssh:(r.ssh||'').trim(), provider}
      }).filter(r=>r.name && (r.provider === 'ssh' || r.apiKey))
      const r = await fetch('/api/sandboxes/config', { method:'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ sandboxes: cleaned }) })
      const j = await r.json().catch(()=>({}))
      if (r.ok && j.ok !== false) {
        const tsMsg = j.tailscaleSetup === 'triggered' ? ' Auto setup Tailscale dijalankan untuk host baru.' : ''
        setNotice({kind:'ok', text:`Config tersimpan (${j.sandboxes?.length ?? cleaned.length} entri).${tsMsg}`})
        setEditOpen(false); await load()
      } else setNotice({kind:'err', text:`Gagal simpan: ${j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`}`})
    } catch (e:any) { setNotice({kind:'err', text:`Gagal simpan: ${e.message}`}) }
    finally { setEditSaving(false) }
  }

  async function action(name:string, act:string) {
    setBusy(b=>({...b,[name]:act}))
    setNotice(null)
    try {
      const r = await fetch(`/api/sandboxes/${encodeURIComponent(name)}/action`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({action:act})
      })
      const j = await r.json().catch(()=>({error:'invalid json response'}))
      if (r.ok && j.ok !== false) setNotice({kind:'ok', text:`${name}: ${act} dikirim (${j?.result?.state || j?.result?.type || 'ok'})`})
      else setNotice({kind:'err', text:`${name}: ${act} gagal — ${j?.result?.error?.message || j?.error?.message || j?.message || j?.error || JSON.stringify(j).slice(0,180)}`})
      await load()
      setTimeout(load, 2000)
    } catch (e:any) {
      setNotice({kind:'err', text:`${name}: ${act} gagal — ${e.message}`})
    } finally {
      setBusy(b=>{ const n={...b}; if (n[name]===act) delete n[name]; return n })
    }
  }

  async function bulkAction(act: 'resume' | 'suspend') {
    const targets = (data?.sandboxes || []).filter((sb: any) => sb.isInstabox)
    if (targets.length === 0) {
      setNotice({ kind: 'err', text: `Tidak ada sandbox Instabox untuk ${act}.` })
      return
    }
    setBulkBusy(act)
    setNotice(null)
    try {
      const results = await Promise.allSettled(
        targets.map(async (sb: any) => {
          const r = await fetch(`/api/sandboxes/${encodeURIComponent(sb.name)}/action`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: act })
          })
          const j = await r.json().catch(() => ({}))
          if (!r.ok || j.ok === false) {
            throw new Error(j?.result?.error?.message || j?.error?.message || j?.message || j?.error || `HTTP ${r.status}`)
          }
          return sb.name
        })
      )
      const ok = results.filter(r => r.status === 'fulfilled').length
      const fail = results.length - ok
      const failNames = results
        .map((r, i) => r.status === 'rejected' ? `${targets[i].name}: ${(r as PromiseRejectedResult).reason?.message || 'gagal'}` : null)
        .filter(Boolean)
      if (fail === 0) setNotice({ kind: 'ok', text: `${act} dikirim ke ${ok} sandbox Instabox.` })
      else setNotice({ kind: 'err', text: `${act}: ${ok} berhasil, ${fail} gagal${failNames.length ? ` — ${failNames.slice(0,3).join('; ')}` : ''}` })
      await load()
      setTimeout(load, 2000)
    } finally {
      setBulkBusy(null)
    }
  }

  async function setAutoReviveFor(name: string, enabled: boolean) {
    setArSaving(name); setNotice(null)
    const prev = { ...autoRevive }
    setAutoRevive(m => ({ ...m, [name]: enabled }))
    try {
      const r = await fetch('/api/webhooks/auto-revive', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ autoRevive: { [name]: enabled } })
      })
      const j = await r.json().catch(() => ({}))
      if (r.ok && j.ok) {
        if (j.autoRevive) setAutoRevive(j.autoRevive)
        setNotice({ kind: 'ok', text: `Auto-revive ${name}: ${enabled ? 'aktif' : 'nonaktif'}` })
      } else {
        setAutoRevive(prev)
        setNotice({ kind: 'err', text: `Gagal simpan auto-revive: ${j?.error || j?.message || `HTTP ${r.status}`}` })
      }
    } catch (e: any) {
      setAutoRevive(prev)
      setNotice({ kind: 'err', text: `Gagal simpan auto-revive: ${e.message}` })
    } finally { setArSaving(null) }
  }

  async function setupWebhooks() {
    setWebhookBusy(true); setNotice(null)
    try {
      const body: any = {}
      if (webhookUrlInput.trim()) body.publicBaseUrl = webhookUrlInput.trim()
      const r = await fetch('/api/webhooks/setup', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body) })
      const j = await r.json().catch(()=>({}))
      if (r.ok && j.ok) setNotice({kind:'ok', text:`Webhook Instabox berhasil di-setup/di-ensure untuk ${j.results?.length ?? 0} akun/org. URL: ${j.desiredUrl}`})
      else setNotice({kind:'err', text:`Setup webhook ${j.ok===false && r.status===207 ? 'sebagian gagal' : 'gagal'}: ${j.message || j.error || ''} ${j.results ? JSON.stringify(j.results.map((x:any)=>({org:x.orgId, ok:x.ok, err:x.error?.error?.message||x.error?.message||x.error||x.status}))) : ''}`.slice(0,600)})
      await load()
    } catch (e:any) { setNotice({kind:'err', text:`Setup webhook gagal: ${e.message}`}) }
    finally { setWebhookBusy(false) }
  }

  async function openPortForward(name: string) {
    setPfName(name); setPfOpen(true); setPfPort(''); setPfLabel(''); setPfProto('http'); setNotice(null); setPfNotice(null)
    await loadPorts(name)
  }
  async function loadPorts(name: string) {
    setPfLoading(true)
    try {
      const r = await fetch(`/api/sandboxes/${encodeURIComponent(name)}/ports`)
      const j = await r.json().catch(()=>({}))
      const list = Array.isArray(j.ports) ? j.ports : (Array.isArray(j) ? j : [])
      setPfPorts(list)
      if (!r.ok) {
        const msg = j?.message || j?.error?.message || j?.error || `HTTP ${r.status}`
        setPfNotice({kind:'err', text:`Gagal memuat port: ${msg}`})
      }
    } catch (e:any) { setPfNotice({kind:'err', text:`Gagal memuat port: ${e.message}`}) }
    finally { setPfLoading(false) }
  }
  async function createPortForward() {
    if (!pfName) return
    const pnum = parseInt(pfPort, 10)
    if (!pnum) { setPfNotice({kind:'err', text:'Masukkan nomor port yang valid'}); return }
    setPfSaving(true); setPfNotice(null)
    try {
      const r = await fetch(`/api/sandboxes/${encodeURIComponent(pfName)}/ports`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port: pnum, name: pfLabel || `port-${pnum}`, protocol: pfProto || 'http' })
      })
      const j = await r.json().catch(()=>({}))
      if (r.ok && j.ok !== false) {
        setPfNotice({kind:'ok', text:`Port forward ${pnum} dibuat untuk ${pfName}`})
        setPfPort(''); setPfLabel('')
        await loadPorts(pfName)
      } else {
        const msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : null) || `HTTP ${r.status}`
        setPfNotice({kind:'err', text:`Gagal port forward: ${msg}`})
      }
    } catch (e:any) { setPfNotice({kind:'err', text:`Gagal port forward: ${e.message}`}) }
    finally { setPfSaving(false) }
  }
  async function deletePortForward(portRef: string) {
    if (!pfName) return
    setPfSaving(true); setPfNotice(null)
    try {
      const r = await fetch(`/api/sandboxes/${encodeURIComponent(pfName)}/ports/${encodeURIComponent(portRef)}`, { method: 'DELETE' })
      const j = await r.json().catch(()=>({}))
      if (r.ok && j.ok !== false) {
        setPfNotice({kind:'ok', text:'Port forward dihapus'})
        await loadPorts(pfName)
      } else {
        const msg = j?.message || j?.error?.message || (typeof j?.error === 'string' ? j.error : j?.error?.code) || `HTTP ${r.status}`
        setPfNotice({kind:'err', text:`Gagal hapus port: ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`})
      }
    } catch (e:any) { setPfNotice({kind:'err', text:`Gagal hapus port: ${e.message}`}) }
    finally { setPfSaving(false) }
  }

  const sandboxes = data?.sandboxes || []
  const stats = useMemo(() => {
    const s = { total: sandboxes.length, on: 0, suspended: 0, off: 0, unknown: 0 }
    for (const sb of sandboxes as any[]) s[stateKind(sb?.state)]++
    return s
  }, [data])
  const query = search.trim().toLowerCase()
  const filteredSandboxes = useMemo(() => {
    let list = sandboxes as any[]
    if (listFilter !== 'all') list = list.filter(sb => stateKind(sb?.state) === listFilter)
    if (query) {
      list = list.filter(sb => [
        sb?.name, sb?.state, sb?.machineId, sb?.machine?.id, sb?.ssh, sb?.sshHost, sb?.sshHostName,
        sb?.provider, sb?.isInstabox ? 'instabox' : 'ssh', sb?.tailscaleIp, sb?.tailscale?.hostIp,
        sb?.machine?.template?.id, sb?.machine?.spec?.vcpus != null ? String(sb.machine.spec.vcpus) : '',
      ].filter(Boolean).join(' ').toLowerCase().includes(query))
    }
    return list
  }, [sandboxes, listFilter, query])
  const hasActiveFilter = listFilter !== 'all' || !!query
  const resetFilters = () => { setListFilter('all'); setSearch('') }
  const toggleFilter = (f: 'all' | StateKind) => setListFilter(cur => cur === f ? 'all' : f)

  return (
    <div className="space-y-8">
      <header className="nb-card bg-[#FFEB3B] p-5 sm:p-6">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="min-w-0">
            <p className="inline-block mb-2 px-2 py-0.5 border-2 border-black rounded bg-white text-[11px] font-extrabold uppercase tracking-wider">Control Panel</p>
            <h1 className="text-3xl sm:text-4xl font-extrabold tracking-tight text-black">Sandboxes</h1>
            <p className="mt-2 text-sm sm:text-base font-semibold text-black/80">
              {sandboxes.length} host terdaftar · auto-refresh 8s
              {(data as any)?.tailscaleIp ? <span> · TS <code className="font-mono bg-white border-2 border-black rounded px-1.5 py-0.5 text-xs">{(data as any).tailscaleIp}</code></span> : null}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button onClick={() => bulkAction('resume')} disabled={!!bulkBusy || syncBusy || editLoading} className="nb-btn nb-btn-teal !py-2 cursor-pointer transition-all">
              {bulkBusy === 'resume' ? 'Resuming...' : 'Resume All'}
            </button>
            <button onClick={() => bulkAction('suspend')} disabled={!!bulkBusy || syncBusy || editLoading} className="nb-btn nb-btn-red !py-2 cursor-pointer transition-all">
              {bulkBusy === 'suspend' ? 'Suspending...' : 'Suspend All'}
            </button>
            <button onClick={syncSsh} disabled={syncBusy || !!bulkBusy} className="nb-btn !py-2 bg-white cursor-pointer transition-all">
              {syncBusy ? 'Sync...' : 'Sync'}
            </button>
            <button onClick={openEdit} disabled={editLoading || !!bulkBusy} className="nb-btn nb-btn-blue !py-2 cursor-pointer transition-all">
              {editLoading ? 'Memuat...' : 'Edit'}
            </button>
            <button onClick={load} className="nb-btn nb-btn-primary !py-2 cursor-pointer transition-all">Refresh</button>
          </div>
        </div>
      </header>

      <section aria-label="Cari host" className="nb-card bg-white p-3 sm:p-4 flex items-center gap-2">
        <span aria-hidden="true" className="pl-1 text-lg leading-none">🔍</span>
        <label htmlFor="host-search" className="sr-only">Cari host</label>
        <input
          id="host-search"
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          onKeyDown={e => { if (e.key === 'Escape' && search) setSearch('') }}
          placeholder="Cari nama host, state, machine id, ssh, tailscale IP..."
          autoComplete="off"
          spellCheck={false}
          className="nb-input !shadow-none !border-0 !bg-transparent focus:!bg-transparent px-1 py-1.5 text-sm sm:text-base font-semibold"
        />
        {search && (
          <button onClick={() => setSearch('')} aria-label="Hapus pencarian" className="nb-btn !px-2.5 !py-1.5 bg-white cursor-pointer text-xs">✕</button>
        )}
      </section>

      <section aria-label="Statistik host" className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 sm:gap-4">
        <StatCard label="Total Host" value={stats.total} tone="bg-white" hint="Semua host terdaftar" active={listFilter === 'all'} onClick={() => toggleFilter('all')} />
        <StatCard label="Nyala" value={stats.on} tone="bg-[#B9FBC0]" hint="Running / reachable" active={listFilter === 'on'} onClick={() => toggleFilter('on')} />
        <StatCard label="Suspended" value={stats.suspended} tone="bg-[#FFEB3B]" hint="Dijeda sementara" active={listFilter === 'suspended'} onClick={() => toggleFilter('suspended')} />
        <StatCard label="Mati" value={stats.off} tone="bg-[#FF5252]" hint="Stopped / error / unreachable" active={listFilter === 'off'} onClick={() => toggleFilter('off')} />
        <StatCard label="Unknown" value={stats.unknown} tone="bg-[#E5E5E5]" hint="Status belum diketahui" active={listFilter === 'unknown'} onClick={() => toggleFilter('unknown')} />
      </section>

      {err && <div className="nb-card bg-[#FF5252] px-4 py-3 font-bold"><span className="nb-badge bg-white mr-2">Error</span>{err}</div>}
      {notice && <div className={`nb-card px-4 py-3 font-bold ${notice.kind === 'ok' ? 'bg-[#B9FBC0]' : 'bg-[#FF5252]'}`}>{notice.text}</div>}

      <section className="nb-card overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 border-b-[3px] border-black bg-[#2196F3]">
          <h2 className="text-lg font-extrabold tracking-tight">Daftar Host</h2>
          <div className="flex items-center gap-2">
            {hasActiveFilter && <button onClick={resetFilters} className="nb-badge bg-white cursor-pointer hover:bg-[#FFEB3B]">reset filter ✕</button>}
            <span className="nb-badge bg-white">{hasActiveFilter ? `${filteredSandboxes.length} / ${sandboxes.length} host` : `${sandboxes.length} host`}</span>
          </div>
        </div>
        {loading && sandboxes.length === 0 ? (
          <p className="p-5 font-semibold">Memuat...</p>
        ) : sandboxes.length === 0 ? (
          <p className="p-5 font-semibold">Belum ada sandbox.</p>
        ) : filteredSandboxes.length === 0 ? (
          <p className="p-5 font-semibold">
            {query
              ? <>Tidak ada host cocok dengan <code className="font-mono bg-[#FFEB3B] border-2 border-black rounded px-1.5">{search.trim()}</code>{listFilter !== 'all' ? ' pada filter status ini' : ''}. <button onClick={resetFilters} className="underline decoration-2 underline-offset-2 cursor-pointer">Reset</button></>
              : <>Tidak ada host dengan status ini. <button onClick={resetFilters} className="underline decoration-2 underline-offset-2 cursor-pointer">Tampilkan semua</button></>}
          </p>
        ) : (
          <ul className="divide-y-[3px] divide-black">
            {filteredSandboxes.map((sb: any) => (
              <li key={sb.name} className="p-4 sm:p-5 bg-white hover:bg-[#FFFEF0] transition-colors">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-xl font-extrabold tracking-tight">{sb.name}</span>
                      {loading ? <span className="nb-badge">…</span> : <Badge state={sb.state} />}
                      <span className={`nb-badge ${sb.isInstabox ? 'bg-[#FFEB3B]' : 'bg-[#E5E5E5]'}`}>{sb.isInstabox ? 'instabox' : 'ssh'}</span>
                      {sb.fromSshConfig && !sb.isInstabox && <span className="nb-badge bg-white">status-only</span>}
                    </div>
                    <div className="text-xs font-mono font-semibold bg-[#F5F5F5] border-2 border-black rounded px-2 py-1 break-all inline-block">
                      {sb.isInstabox ? (sb.machineId || sb.machine?.id || '-') : (sb.sshHostName || sb.sshHost || 'from ssh config')}
                    </div>
                    {sb.machine && (
                      <div className="text-xs font-bold text-black/70">
                        {sb.machine.template?.id || '-'} · {sb.machine.spec?.vcpus} vCPU / {sb.machine.spec?.memMiB} MiB · {sb.machine.updatedAt ? new Date(sb.machine.updatedAt).toLocaleString() : '-'}
                      </div>
                    )}
                    {sb.error && <div className="text-xs font-bold text-[#B91C1C] bg-[#FEE2E2] border-2 border-black rounded px-2 py-1 inline-block">{sb.error}</div>}
                    <div className="grid gap-1.5 text-xs sm:text-sm font-semibold">
                      {(sb.tailscaleIp || sb.tailscale?.hostIp) && <div className="flex flex-wrap gap-2 items-center"><span className="nb-badge bg-white">Tailscale</span><code className="font-mono border-2 border-black rounded px-1.5 py-0.5 bg-white">{sb.tailscaleIp || sb.tailscale?.hostIp}</code></div>}
                      {sb.isInstabox && sb.tailscale?.tcpVnc && <div className="flex flex-wrap gap-2 items-center"><span className="nb-badge bg-[#4ECDC4]">VNC TCP</span><code className="font-mono border-2 border-black rounded px-1.5 py-0.5 bg-white">{sb.tailscale.tcpVnc}</code></div>}
                      {sb.isInstabox && sb.apiKey && <div className="flex flex-wrap gap-2 items-center"><span className="nb-badge bg-white">Key</span><code className="font-mono border-2 border-black rounded px-1.5 py-0.5 bg-white truncate max-w-full">{sb.apiKey}</code></div>}
                      {sb.ssh && <div className="flex flex-wrap gap-2 items-center"><span className="nb-badge bg-white">SSH</span><code className="font-mono border-2 border-black rounded px-1.5 py-0.5 bg-white break-all">{sb.ssh}</code></div>}
                      {!sb.isInstabox && <div className="text-xs font-bold text-black/60">Host non-instabox: hanya lihat status (tanpa VNC/suspend/action).</div>}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {sb.isInstabox ? (
                      <>
                        {(['start','resume','stop','suspend'] as const).map(act => {
                          const isBusy = busy[sb?.name] === act
                          const disabled = !sb?.name || !!busy[sb?.name]
                          const tone = act === 'start' || act === 'resume' ? 'nb-btn-teal' : act === 'suspend' ? 'nb-btn-red' : 'bg-white'
                          return (
                            <button key={act} disabled={disabled} onClick={() => action(sb.name, act)} className={`nb-btn ${tone} !py-1.5 !px-3 !text-xs cursor-pointer transition-all`}>
                              {isBusy ? '…' : act}
                            </button>
                          )
                        })}
                        <button onClick={() => openPortForward(sb.name)} className="nb-btn nb-btn-blue !py-1.5 !px-3 !text-xs cursor-pointer transition-all">ports</button>
                        {sb?.tailscale?.viewerRoute ? (
                          <a href={sb.tailscale.viewerRoute} target="_blank" rel="noreferrer" className="nb-btn nb-btn-primary !py-1.5 !px-3 !text-xs cursor-pointer transition-all">VNC</a>
                        ) : (
                          <Link to="/vnc/$name" params={{ name: sb?.name || '' }} className="nb-btn nb-btn-primary !py-1.5 !px-3 !text-xs cursor-pointer transition-all">VNC</Link>
                        )}
                      </>
                    ) : (
                      <span className="nb-badge bg-[#E5E5E5]">status only</span>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <details className="nb-card nb-details overflow-hidden bg-white">
        <summary className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 bg-[#FFEB3B] border-b-[3px] border-black font-extrabold">
          <span className="text-lg">Webhook</span>
          <span className="nb-badge bg-white">setup & status</span>
        </summary>
        <div className="p-4 sm:p-5 space-y-4">
          <p className="text-xs font-semibold">
            <code className="font-mono bg-[#FFEB3B] border-2 border-black rounded px-1.5 py-0.5">POST /webhook/instabox</code> · auto-revive saat suspended/stopped/error · butuh HTTPS publik.
          </p>
          <div>
            <div className="text-sm font-extrabold">Auto-revive saat mati</div>
            <ul className="mt-2 divide-y-2 divide-black border-[3px] border-black rounded-lg overflow-hidden">
              {sandboxes.length === 0 && <li className="p-3 text-sm font-semibold bg-white">Belum ada sandbox.</li>}
              {sandboxes.map((sb: any) => {
                const enabled = autoRevive[sb.name] !== false
                return (
                  <li key={sb.name} className="flex items-center justify-between p-3 text-sm font-bold bg-white">
                    <span>{sb.name}</span>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <span className={`nb-badge ${enabled ? 'bg-[#B9FBC0]' : 'bg-[#E5E5E5]'}`}>{enabled ? 'on' : 'off'}</span>
                      <input type="checkbox" checked={enabled} disabled={arSaving === sb.name} onChange={e => setAutoReviveFor(sb.name, e.target.checked)} className="h-5 w-5 accent-black cursor-pointer" />
                    </label>
                  </li>
                )
              })}
            </ul>
          </div>
          <div className="flex flex-wrap gap-2">
            <input value={webhookUrlInput} onChange={e => setWebhookUrlInput(e.target.value)} placeholder={webhookStatus?.publicBaseUrl ? `Public base URL (${webhookStatus.publicBaseUrl})` : 'https://public-base-url.example'} className="nb-input flex-1 min-w-[240px]" />
            <button onClick={setupWebhooks} disabled={webhookBusy} className="nb-btn nb-btn-primary cursor-pointer transition-all">
              {webhookBusy ? 'Setting up...' : 'Setup'}
            </button>
          </div>
          <div className="text-xs font-bold">Endpoint: <code className="font-mono bg-white border-2 border-black rounded px-1.5 py-0.5 break-all">{webhookStatus?.desiredUrl || '...'}</code></div>
          <ul className="divide-y-2 divide-black border-[3px] border-black rounded-lg overflow-hidden text-xs">
            {(webhookStatus?.groups || []).length === 0 && <li className="p-3 font-semibold bg-white">Belum ada status.</li>}
            {(webhookStatus?.groups || []).map((g: any, idx: number) => (
              <li key={idx} className="p-3 bg-white font-semibold">
                <div className="flex items-center justify-between gap-2">
                  <span>{(g.sandboxes || []).map((s: any) => s.name).join(', ') || g.apiKeyHint}</span>
                  <span className={`nb-badge ${g.ok ? 'bg-[#B9FBC0]' : 'bg-[#FFEB3B]'}`}>{g.ok ? 'ok' : 'issue'}</span>
                </div>
                {g.error && <div className="mt-1 text-[#B91C1C] break-all">{typeof g.error === 'string' ? g.error : (g.error?.error?.message || g.error?.message || JSON.stringify(g.error)).slice(0,220)}</div>}
                {g.existing && <div className="mt-1 break-all">{g.existing.url}</div>}
                {!g.existing && g.saved && <div className="mt-1 break-all">{g.saved.url}</div>}
              </li>
            ))}
          </ul>
          <div className="text-xs font-bold"><a className="nb-link cursor-pointer" href="/api/webhooks/status" target="_blank">/api/webhooks/status</a></div>
        </div>
      </details>

      <details className="nb-card nb-details overflow-hidden bg-white">
        <summary className="flex items-center justify-between gap-3 px-4 sm:px-5 py-3 bg-[#2196F3] border-b-[3px] border-black font-extrabold text-white" style={{color:'#000'}}>
          <span className="text-lg">Event Log</span>
          <span className="nb-badge bg-white">{events.length}</span>
        </summary>
        <ul className="max-h-80 divide-y-2 divide-black overflow-auto font-mono text-xs bg-[#FFFEF0]">
          {events.length === 0 && <li className="p-4 font-sans text-sm font-semibold bg-white">Belum ada event.</li>}
          {events.slice(0, 30).map((ev, idx) => (
            <li key={idx} className="px-4 py-2">
              <span className="font-bold">{new Date(ev.at).toLocaleTimeString()}</span>{' '}
              <span className="nb-badge bg-[#FFEB3B] !py-0">{ev.type}</span>{' '}
              <span className="font-bold">{ev.sandbox || ev.machineId || ''}</span>{' '}
              <span>{ev.eventType || ev.state || ev.reason || ev.error || ''}</span>
            </li>
          ))}
        </ul>
      </details>

      {pfOpen && pfName && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e)=>{ if(e.target===e.currentTarget && !pfSaving) setPfOpen(false) }}>
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden nb-card bg-white">
            <div className="flex items-start justify-between gap-3 border-b-[3px] border-black bg-[#2196F3] px-5 py-4">
              <div>
                <h2 className="text-xl font-extrabold">Port Forward — {pfName}</h2>
                <p className="mt-1 text-xs font-semibold">Expose port dari sandbox Instabox ini.</p>
              </div>
              <button onClick={()=>!pfSaving && setPfOpen(false)} className="nb-btn !px-2.5 !py-1.5 bg-white cursor-pointer">✕</button>
            </div>
            <div className="flex-1 space-y-5 overflow-auto p-5 bg-[#FFFEF0]">
              {pfNotice && <div className={`nb-card px-4 py-3 font-bold ${pfNotice.kind === 'ok' ? 'bg-[#B9FBC0]' : 'bg-[#FF5252]'}`}>{pfNotice.text}</div>}
              <div className="nb-card p-4 bg-white">
                <div className="text-base font-extrabold">Tambah Port Forward</div>
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <label className="text-xs font-extrabold uppercase sm:col-span-1">Port
                    <input value={pfPort} onChange={e=>setPfPort(e.target.value)} placeholder="3000" inputMode="numeric" className="nb-input mt-1"/>
                  </label>
                  <label className="text-xs font-extrabold uppercase sm:col-span-1">Protocol
                    <select value={pfProto} onChange={e=>setPfProto(e.target.value)} className="nb-select mt-1">
                      <option value="http">http</option>
                      <option value="https">https</option>
                      <option value="tcp">tcp</option>
                    </select>
                  </label>
                  <label className="text-xs font-extrabold uppercase sm:col-span-2">Name (opsional)
                    <input value={pfLabel} onChange={e=>setPfLabel(e.target.value)} placeholder="web / api / port-3000" className="nb-input mt-1"/>
                  </label>
                </div>
                <div className="mt-3 flex gap-2">
                  <button onClick={createPortForward} disabled={pfSaving || !pfPort} className="nb-btn nb-btn-primary cursor-pointer transition-all">{pfSaving ? 'Menyimpan...' : 'Forward Port'}</button>
                  <button onClick={()=>pfName && loadPorts(pfName)} disabled={pfLoading} className="nb-btn bg-white cursor-pointer transition-all">Reload</button>
                </div>
              </div>

              <div className="nb-card p-4 bg-white">
                <div className="text-base font-extrabold">Port yang sudah di-forward</div>
                {pfLoading ? (
                  <p className="mt-2 text-sm font-semibold">Memuat...</p>
                ) : pfPorts.length === 0 ? (
                  <p className="mt-2 text-sm font-semibold">Belum ada port forward.</p>
                ) : (
                  <ul className="mt-3 divide-y-2 divide-black border-[3px] border-black rounded-lg overflow-hidden">
                    {pfPorts.map((p: any, idx: number) => {
                      const ref = p.id || p.port || p.name || idx
                      const label = p.name || `port-${p.port}`
                      const access = String(p.access || '').toLowerCase()
                      return (
                        <li key={String(p.id || ref || idx)} className="flex flex-col gap-2 p-3 text-sm font-semibold sm:flex-row sm:items-center sm:justify-between bg-white">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-extrabold">{label}</span>
                              <span className="font-mono text-xs border-2 border-black rounded px-1.5 bg-[#FFEB3B]">{p.protocol || ''} {p.port}</span>
                              {access && <span className={`nb-badge ${access === 'public' ? 'bg-[#B9FBC0]' : 'bg-[#E5E5E5]'}`}>{access}</span>}
                            </div>
                            {p.url && <a href={p.url} target="_blank" rel="noreferrer" className="nb-link break-all text-xs cursor-pointer">{p.url}</a>}
                            {p.publicUrl && !p.url && <a href={p.publicUrl} target="_blank" rel="noreferrer" className="nb-link break-all text-xs cursor-pointer">{p.publicUrl}</a>}
                            {p.id && <div className="mt-0.5 font-mono text-[11px]">{p.id}</div>}
                          </div>
                          <div className="flex shrink-0 items-center gap-3">
                            {(p.id || p.port) ? (
                              <button onClick={()=>deletePortForward(String(p.id || p.port))} disabled={pfSaving} className="nb-btn nb-btn-red !py-1.5 !px-3 !text-xs cursor-pointer transition-all">hapus</button>
                            ) : (
                              <span className="text-xs">tidak bisa dihapus (id tidak ada)</span>
                            )}
                          </div>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
            </div>
            <div className="flex items-center justify-end border-t-[3px] border-black bg-white px-5 py-3">
              <button onClick={()=>setPfOpen(false)} disabled={pfSaving} className="nb-btn bg-white cursor-pointer transition-all">Tutup</button>
            </div>
          </div>
        </div>
      )}

      {editOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={(e)=>{ if(e.target===e.currentTarget && !editSaving) setEditOpen(false) }}>
          <div className="flex max-h-[90vh] w-full max-w-4xl flex-col overflow-hidden nb-card bg-white">
            <div className="flex items-start justify-between gap-3 border-b-[3px] border-black bg-[#FFEB3B] px-5 py-4">
              <div>
                <h2 className="text-xl font-extrabold">Host / Sandbox Config</h2>
                <p className="mt-1 text-xs font-semibold">Pilih tipe <b>Instabox</b> atau <b>SSH biasa</b> saat tambah/edit. Setiap save/sync: sinkron <code className="font-mono">~/.ssh/config</code> ↔ app, cek Tailscale, dan auto-daftar Herdr bila tersedia.</p>
              </div>
              <button onClick={()=>!editSaving && setEditOpen(false)} className="nb-btn !px-2.5 !py-1.5 bg-white cursor-pointer">✕</button>
            </div>
            <div className="flex-1 space-y-4 overflow-auto p-5 bg-[#FFFEF0]">
              {editRows.map((row,i)=>{
                const provider = (row.provider === 'ssh' || row.isInstabox === false) ? 'ssh' : 'instabox'
                const readOnly = !!row.fromSshConfig && row.saved === false
                const isSsh = provider === 'ssh'
                return (
                <div key={i} className="nb-card p-4 space-y-3 bg-white">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-base font-extrabold">
                      {isSsh ? 'Host SSH Biasa' : 'Sandbox Instabox'} #{i+1}
                      {row.fromSshConfig ? <span className="ml-2 nb-badge bg-[#E5E5E5]">dari ~/.ssh/config</span> : null}
                      {row.saved === false ? <span className="ml-2 nb-badge bg-[#E5E5E5]">auto, read-only</span> : null}
                    </div>
                    {!readOnly && (
                      <button onClick={()=>removeRow(i)} disabled={editSaving} className="nb-btn nb-btn-red !py-1.5 !px-3 !text-xs cursor-pointer transition-all">Hapus</button>
                    )}
                  </div>
                  {readOnly && (
                    <p className="text-xs font-semibold bg-[#FFEB3B] border-2 border-black rounded p-2">Host ini tampil otomatis dari SSH config server (status-only, read-only). Untuk ubah permanen, edit <code className="font-mono">~/.ssh/config</code> atau simpan sebagai entri app.</p>
                  )}
                  <div className="grid gap-3 md:grid-cols-2">
                    <label className="text-xs font-extrabold uppercase">Tipe
                      <select value={provider} onChange={e=>updateRow(i,'provider',e.target.value)} disabled={readOnly || editSaving} className="nb-select mt-1">
                        <option value="instabox">Instabox</option>
                        <option value="ssh">SSH Biasa</option>
                      </select>
                    </label>
                    <label className="text-xs font-extrabold uppercase">Name
                      <input value={row.name} onChange={e=>updateRow(i,'name',e.target.value)} placeholder={isSsh ? 'server-kecil' : 'infra'} disabled={readOnly} className="nb-input mt-1"/>
                    </label>
                    <label className="text-xs font-extrabold uppercase md:col-span-2">SSH Command / Target
                      <input value={row.ssh} onChange={e=>updateRow(i,'ssh',e.target.value)} placeholder={isSsh ? 'ssh server-kecil atau ssh user@host -p 22' : 'ssh infra'} disabled={readOnly} className="nb-input mt-1 font-mono"/>
                      <p className="mt-1 text-[11px] font-semibold normal-case">Contoh: <code className="font-mono">ssh user@host -p 22 -i ~/.ssh/id_ed25519</code></p>
                    </label>
                    {!isSsh && (
                      <>
                        <label className="text-xs font-extrabold uppercase">Machine ID
                          <input value={row.machineId} onChange={e=>updateRow(i,'machineId',e.target.value)} placeholder="m_..." disabled={readOnly} className="nb-input mt-1 font-mono"/>
                        </label>
                        <label className="text-xs font-extrabold uppercase">API Key
                          <input value={row.apiKey} onChange={e=>updateRow(i,'apiKey',e.target.value)} placeholder="ibk_..." disabled={readOnly} className="nb-input mt-1 font-mono"/>
                        </label>
                      </>
                    )}
                    {isSsh && (
                      <p className="text-xs font-semibold md:col-span-2 bg-[#4ECDC4] border-2 border-black rounded p-2">Host SSH biasa: disimpan di config app, status dicek via SSH. Tanpa action/VNC/suspend Instabox.</p>
                    )}
                  </div>
                </div>
              )})}
              <div className="flex flex-wrap gap-2">
                <button onClick={addRow} disabled={editSaving} className="nb-btn nb-btn-primary cursor-pointer transition-all">+ Tambah Sandbox Instabox</button>
                <button onClick={()=>setEditRows(rows=>[...rows,{name:'',apiKey:'',machineId:'',ssh:'',isInstabox:false,provider:'ssh',saved:true}])} disabled={editSaving} className="nb-btn nb-btn-teal cursor-pointer transition-all">+ Tambah Host SSH</button>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 border-t-[3px] border-black bg-white px-5 py-3">
              <button onClick={()=>setEditOpen(false)} disabled={editSaving} className="nb-btn bg-white cursor-pointer transition-all">Batal</button>
              <button onClick={saveEdit} disabled={editSaving} className="nb-btn nb-btn-primary cursor-pointer transition-all">{editSaving ? 'Menyimpan...' : 'Simpan'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
