import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { backend } from '../backend/config'
import { authHeaders, sessionToken } from '../backend/auth'
import { ReportList } from '../reports/Reports'
import { normalizePassenger, statusLabel } from './format'
import './me.css'
import '../map/live/page.css'
import { Chat, ChatView } from '../chat/Chat'
import { useChatChannel } from '../chat/channel'
import { pageText } from './texts'
import { LiveMap, type Focus, type RouteDraw } from '../map/live/LiveMap'
import { CHIPS, categoryOf, evacFor, floorChanges, landmarkFor, pathOf, routeBetween, search, shortName, type Lang } from '../map/live/catalogue'
import { useFlow, useIndex, useViewportHeight, useWide } from '../map/live/useLive'
import { Sheet, sheetHeight, type Snap } from '../map/live/Sheet'
import { PointCard, QueueList, ReportPanel, ResultList, RouteNote, SearchBar } from '../map/live/Panels'
import { readPicked, resolveHere, savePicked, stagePlace } from '../map/live/here'
import { sendReport, useReportFlow } from '../map/live/useReport'
import { langOverride, LangToggle } from '../map/live/lang'

export default function Me() {
  const [state, setState] = useState(() => ({ data: normalizePassenger(null), error: '', loading: true, changed: [] as string[], here: null as { node: string; ageSec: number } | null }))

  useEffect(() => {
    let disposed = false
    let pending: AbortController | undefined
    const token = window.location.pathname.startsWith('/m/') ? window.location.pathname.slice(3) : ''
    const poll = async () => {
      if (pending) return
      const controller = new AbortController()
      pending = controller
      const timeout = window.setTimeout(() => controller.abort(), 4500)
      try {
        const url = new URL('/api/me', backend.http)
        if (token) url.searchParams.set('token', decodeURIComponent(token))
        const response = await fetch(url, { headers: authHeaders(), signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? 'auth' : 'unavailable')
        const raw = await response.json() as { here?: { node?: unknown; ageSec?: unknown } }
        const data = normalizePassenger(raw)
        const here = raw?.here && typeof raw.here.node === 'string' && typeof raw.here.ageSec === 'number' ? { node: raw.here.node, ageSec: raw.here.ageSec } : null
        const keys = ['gate', 'gateCloseAt', 'status', 'delayMin'] as const
        if (!disposed) setState(previous => {
          const diff = keys.filter(key => data.flight[key] !== previous.data.flight[key])
          return { data, here, error: '', loading: false, changed: previous.loading ? [] : diff.length ? [...diff] : previous.changed }
        })
      } catch (error) {
        if (!disposed) setState(previous => ({ ...previous, error: error instanceof Error ? error.message : 'unavailable', loading: false }))
      } finally {
        window.clearTimeout(timeout)
        pending = undefined
      }
    }
    window.addEventListener('personal-refresh', poll)
    void poll()
    const interval = window.setInterval(() => void poll(), 5000)
    return () => {
      window.removeEventListener('personal-refresh', poll)
      disposed = true
      window.clearInterval(interval)
      pending?.abort()
    }
  }, [])

  const { data, error, loading, changed } = state
  const [override, setOverride] = useState<Lang | null>(langOverride)
  const lang: Lang = override ?? data.lang ?? 'ro'
  const en = lang === 'en'
  const t = (text: string) => pageText(text, lang)
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  const wide = useWide()
  const { index } = useIndex()
  const live = useFlow(2000)
  const points = useMemo(() => index?.points ?? [], [index])
  const [chatOpen, setChatOpen] = useState(false)
  const channel = useChatChannel({ active: true, visible: wide || chatOpen })

  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState(''), [chip, setChip] = useState<string | null>(null)
  const [snap, setSnap] = useState<Snap>('peek')
  const [routeTo, setRouteTo] = useState<string | null>(null)
  const [picked, setPicked] = useState(readPicked)
  const [toast, setToast] = useState('')
  const report = useReportFlow(points)
  const vh = useViewportHeight()
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4000); return () => clearTimeout(id) }, [toast])

  const { flight, evacuation } = data
  const gateId = /^\d+$/.test(flight.gate) ? `U_GATE_${flight.gate}` : null
  const told = state.here ? landmarkFor(points, state.here.node) : undefined
  const hereInfo = resolveHere({ picked, told: told && state.here ? { id: told.id, ageSec: state.here.ageSec } : null, stage: stagePlace(data.stage, flight.gate), now: Date.now() })
  const hereL = hereInfo ? landmarkFor(points, hereInfo.id) : undefined
  const hereId = hereL?.id ?? null
  const target = routeTo ?? gateId

  const route: RouteDraw | null = useMemo(() => {
    if (!index) return null
    if (evacuation.active) {
      const e = evacFor(index, data.routeImage)
      if (!e) return null
      const path = pathOf(points, e.steps)
      const a = landmarkFor(points, e.assembly)
      return { path, changes: floorChanges(path, lang), assembly: a ? { id: a.id, level: a.level, x: a.x, z: a.z, name: shortName(a, lang) } : null }
    }
    if (!hereId || !target) return null
    const r = routeBetween(index, hereId, target, lang)
    if (!r.ok) return null
    const end = points.find(p => p.id === target)
    return { path: r.path, changes: floorChanges(r.path, lang), endLabel: end ? shortName(end, lang) : undefined }
  }, [index, evacuation.active, data.routeImage, points, hereId, target, lang])

  const sel = points.find(p => p.id === selected)
  const focus: Focus | null = useMemo(() => {
    if (sel) return { key: `sel:${sel.id}`, pts: [sel], minW: wide ? 1100 : 520 }
    if (route?.path.length) return { key: `route:${route.path[0]!.id}:${route.path[route.path.length - 1]!.id}`, pts: [...route.path, ...(route.assembly ? [route.assembly] : [])] }
    if (hereL) return { key: `here:${hereL.id}`, pts: [hereL], minW: wide ? 1600 : 700 }
    return null
  }, [sel, route, hereL, wide])

  const select = useCallback((id: string | null) => {
    setSelected(id)
    if (id) { setSnap('half'); setQuery('') }
  }, [])
  const chipCats = chip ? CHIPS.find(c => c.key === chip)!.cats : null
  const results = query ? search(points, query, lang) : chipCats ? points.filter(p => chipCats.includes(categoryOf(p.id))) : []

  const securityQueue = data.queues?.find(q => /security/i.test(q.zone))
  const checkinQueue = data.queues?.find(q => /check_in|CHECKIN/.test(q.zone))
  const walk = data.steps.find(s => s.zone === 'walk')?.waitMin ?? null
  const reports = data.reports ?? []
  const queues = <QueueList lang={lang} rows={[
    { key: 'checkin', label: 'Check-in', min: checkinQueue?.nowMin ?? null, note: checkinQueue?.nowMin != null ? `${waitBand(checkinQueue.nowMin)} min` : null, extra: checkinQueue?.staffCrowd },
    { key: 'security', label: en ? 'Security' : 'Securitate', min: securityQueue?.nowMin ?? null,
      note: securityQueue?.forecastMin != null && securityQueue.nowMin != null && securityQueue.forecastMin !== securityQueue.nowMin ? `~${Math.ceil(securityQueue.forecastMin)} ${t('min la')} ${securityQueue.forecastAt}` : securityQueue?.nowMin != null ? `${waitBand(securityQueue.nowMin)} min` : null,
      extra: securityQueue?.staffCrowd },
    { key: 'gate', label: en ? `To gate ${flight.gate}` : `Până la poarta ${flight.gate}`, min: walk, extra: data.gateCrowd },
  ]} />

  if ((!sessionToken() && window.location.pathname === '/m') || error === 'auth') return <main className="me-shell"><div className="me-page"><h1>Clarion</h1><a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>

  const send = async (type: string, text: string) => {
    if (!report.place) return false
    try { await sendReport(report.place, type, text, lang); report.cancel(); setToast(en ? 'Report sent' : 'Raport trimis'); window.dispatchEvent(new Event('personal-refresh')); return true }
    catch { return false }
  }

  /* ---------- Evacuation: only the way out and the assembly point ---------- */
  if (evacuation.active) {
    const assembly = landmarkFor(points, data.assembly)
    const map = <LiveMap lang={lang} mode="passenger" points={points} flow={{}} now={live.now} route={route} evac
      here={route?.path[0] ? { ...route.path[0], fresh: true, label: en ? 'You are here' : 'Ești aici' } : null}
      focus={route ? { key: 'evac', pts: [...route.path, ...(route.assembly ? [route.assembly] : [])] } : null} insetBottom={wide ? 0 : sheetHeight('half', vh)} />
    const body = <div className="lv-evac" role="alert">
      <h1>{t('Evacuare')}</h1>
      {evacuation.route && <p className="steps">{evacuation.route.steps.join(' → ')}</p>}
      <h2>{en ? 'Assembly point' : 'Punct de adunare'}</h2><p className="assembly">{assembly ? shortName(assembly, lang) : data.assembly ?? t('necunoscut')}</p>
      {!route && data.routeImage && <img className="route-image" src={data.routeImage} alt={t('Evacuare')} />}
      {!route && !data.routeImage && <p>{t('Urmează indicatoarele spre cea mai apropiată ieșire')}</p>}
    </div>
    return <main className={`lv me-shell evac ${wide ? 'wide' : 'narrow'}`}>
      {wide ? <div className="lv-grid"><div className="lv-mapcol">{map}</div><aside className="lm-panel">{body}</aside></div>
        : <><div className="lv-mapwrap full">{map}</div><Sheet wide={false} snap="half" onSnap={() => {}} label={t('Evacuare')}>{body}</Sheet></>}
    </main>
  }

  /* ---------- Normal page ---------- */
  const header = <header className="dashboard-header me-flight lv-head">
    <div className="row"><h1>{flight.flight} · {flight.destination}</h1><LangToggle lang={lang} onChange={setOverride} /></div>
    <p><span className={changed.includes('gate') ? 'flight-change' : ''}>{t('Poarta')} {flight.gate}{changed.includes('gate') && <small> · {en ? 'Change' : 'Schimbare'}</small>}</span> · <span className={changed.includes('gateCloseAt') ? 'flight-change' : ''}>{t('se închide la')} {flight.gateCloseAt}</span> · <span className={changed.includes('status') || changed.includes('delayMin') ? 'flight-change' : ''}>{statusLabel(flight.status, flight.delayMin, lang)}</span></p>
    {loading && <small role="status">{t('Se încarcă…')}</small>}
    {error && <p role="alert">{en ? 'Data unavailable' : 'Date indisponibile'}</p>}
  </header>
  const searchBar = <SearchBar lang={lang} query={query} onQuery={q => { setQuery(q); if (q) { setSelected(null); setSnap('full') } }} chip={chip}
    onChip={k => { setChip(k); setSelected(null); setQuery(''); setSnap(k ? 'half' : 'peek') }} onFocus={() => { if (!wide) setSnap('full') }} />

  let content: ReactNode
  if (report.stage) content = <ReportPanel lang={lang} place={report.place} onSend={send} onCancel={report.cancel}
    hint={report.stage === 'pick' ? (en ? 'Tap the map where it is' : 'Atinge harta unde este') : (en ? 'Drag the pin to adjust' : 'Trage acul pentru a ajusta')} />
  else if (sel) content = <PointCard l={sel} lang={lang} mode="passenger" flow={live.flow} now={live.now} index={index} hereId={hereId}
    onRoute={() => { setRouteTo(sel.id); setSelected(null); setSnap('half') }} onHere={() => { savePicked(sel.id); setPicked(readPicked()); setToast(en ? 'Saved: you are here' : 'Salvat: ești aici') }}
    onReport={() => report.start(sel.id)} onPick={select} onClose={() => { setSelected(null); setSnap('peek') }} />
  else if (query || chip) content = <ResultList items={results} lang={lang} flow={live.flow} now={live.now} index={index} from={hereId} onPick={select}
    empty={en ? 'No place with this name' : 'Niciun loc cu acest nume'} />
  else content = <>
    {target && hereId && index && <section className="lv-myroute" aria-label={en ? 'Your route' : 'Drumul tău'}>
      <h2>{routeTo ? `${en ? 'To' : 'Spre'} ${shortName(points.find(p => p.id === routeTo) ?? { name: { ro: routeTo, en: routeTo } }, lang)}` : `${en ? 'To gate' : 'Spre poarta'} ${flight.gate}`}</h2>
      <RouteNote index={index} from={hereId} to={target} lang={lang} />
      {routeTo && <button type="button" className="lv-link" onClick={() => setRouteTo(null)}>{en ? `Back to gate ${flight.gate}` : `Înapoi la poarta ${flight.gate}`}</button>}
    </section>}
    <div className="lv-buttons">
      <button type="button" onClick={() => { report.start(null); setSnap('peek') }}>{en ? 'Report a problem' : 'Raportează o problemă'}</button>
      {!wide && <Chat en={en} channel={channel} onOpen={setChatOpen} />}
    </div>
    <details className="lv-reports"><summary>{en ? 'Reports' : 'Rapoarte'} <b>{reports.filter(r => r.state !== 'resolved').length}</b></summary><ReportList en={en} reports={reports} /></details>
  </>

  const hereMark = hereL ? { level: hereL.level, x: hereL.x, z: hereL.z, fresh: hereInfo!.fresh, label: en ? 'You are here' : 'Ești aici' } : null
  const inset = wide ? 0 : sheetHeight(snap, vh)
  const map = <LiveMap lang={lang} mode="passenger" points={points} flow={live.flow} now={live.now} selected={selected} onSelect={id => { if (report.stage) return; select(id); if (!id) setSnap('peek') }}
    only={chipCats} route={route} here={hereMark} focus={focus} insetBottom={inset}
    picking={report.picking} draft={report.draft} onDraft={report.drop}>
    {report.stage === 'pick' && <p className="lv-banner" role="status">{en ? 'Tap the map where it is' : 'Atinge harta unde este'}</p>}
    {toast && <p className="lv-toast" role="status">{toast}</p>}
  </LiveMap>

  if (wide) return <main className="lv me-shell wide">
    <div className="lv-grid">
      <div className="lv-mapcol">{map}</div>
      <aside className="lm-panel" aria-label={en ? 'Details' : 'Detalii'}>
        {header}{queues}{searchBar}
        <div className="lm-panel-body">{content}</div>
        <section className="lv-chat" aria-label={en ? 'Messages' : 'Mesaje'}><h2>{en ? 'Messages' : 'Mesaje'}</h2><ChatView channel={channel} en={en} id="chat-inline" /></section>
      </aside>
    </div>
  </main>
  return <main className="lv me-shell narrow">
    {header}{queues}
    <div className="lv-mapwrap">{map}</div>
    <Sheet wide={false} snap={snap} onSnap={setSnap} header={searchBar} label={en ? 'Places' : 'Locuri'}>{content}</Sheet>
  </main>
}

export function waitBand(value: number | null) { return value == null ? '—' : Math.ceil(value) <= 3 ? '0–3' : Math.ceil(value) <= 10 ? '4–10' : '>10' }
