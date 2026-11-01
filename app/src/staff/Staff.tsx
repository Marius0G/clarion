import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { sessionToken } from '../backend/auth'
import { backend } from '../backend/config'
import { personalRequest, stateLabel } from '../reports/Reports'
import type { PersonalReport } from '../reports/types'
import '../me/me.css'
import '../map/live/page.css'
import { Chat, ChatView } from '../chat/Chat'
import { useChatChannel } from '../chat/channel'
import { LiveMap, teamMark, type Focus, type ReportPin, type TeamMark } from '../map/live/LiveMap'
import { landmarkFor, nodeAt, search, shortName, type Lang, type Landmark, type PathNode } from '../map/live/catalogue'
import { useFlow, useIndex, useTick, useViewportHeight, useWide } from '../map/live/useLive'
import { Sheet, sheetHeight, type Snap } from '../map/live/Sheet'
import { PointCard, ReportPanel, ResultList, SearchBar, StaffNumbers } from '../map/live/Panels'
import { sendReport, useReportFlow } from '../map/live/useReport'
import { dispatchPath } from '../map/live/team'
import { teamProgress } from '../map/live/view'
import { notices, type OpsRecord } from '../map/live/notices'
import { langOverride, LangToggle } from '../map/live/lang'

type StaffAlert = { id: string; priority: string; text: string; kind?: string; zoneId?: string; numbers?: { waitMin?: number; targetMin?: number } }
type ZoneInfo = { id: string; forecast?: { inMin: number; waitMin: number }[] }
type Notice = { text: string; at: string; timestamp?: string | number; zone?: string }
/** `zone` is an id today; the newer API sends `{ id, forecast }` and `notices`. Both are read. */
type StaffData = { lang?: 'ro' | 'en'; zone: string | ZoneInfo; notices?: Notice[]; role: string; reports: PersonalReport[]; situation?: { waitMin: number | null; people: number | null; forecast: { inMin: number; waitMin: number }[]; state: 'normal' | 'busy' | 'full' | 'unknown' }; alerts: StaffAlert[] }
export function staffZone(zone: string, en = false): string {
  return ({ security: en ? 'Security' : 'Securitate', U_SECURITY_QUEUE: en ? 'Security' : 'Securitate', Securitate: en ? 'Security' : 'Securitate' } as Record<string, string>)[zone] ?? zone
}
export function staffAlertLabel(alert: StaffAlert, zone: string, en = false): string {
  const { waitMin, targetMin } = alert.numbers ?? {}
  if (alert.kind === 'zone-target' && waitMin != null && targetMin != null) return `${staffZone(alert.zoneId ?? zone, en)} · ${Math.max(0, Math.round(waitMin - targetMin))} min ${en ? 'over target' : 'peste țintă'}`
  const legacy = /^Țintă depășită · (\d+) min$/.exec(alert.text)
  return legacy ? `${staffZone(zone, en)} · ${legacy[1]} min ${en ? 'over target' : 'peste țintă'}` : alert.text
}
const TYPE: Record<string, [string, string]> = { crowd: ['Aglomerație', 'Crowding'], security: ['Securitate', 'Security'], medical: ['Medical', 'Medical'], cleaning: ['Curățenie', 'Cleaning'], other: ['Altceva', 'Other'], 'lost item': ['Obiect pierdut', 'Lost item'] }
const RESOLVED_FADE_MS = 10 * 60_000

/** Admin decisions from the ops log (/api/sim), every 10 s; information only. */
function useOps(enabled: boolean, ms = 10_000) {
  const [ops, setOps] = useState<OpsRecord[]>([])
  useEffect(() => {
    if (!enabled) return
    let alive = true
    const poll = async () => {
      try { const r = await fetch(`${backend.http}/api/sim`, { cache: 'no-store', signal: AbortSignal.timeout(5000) }); if (r.ok) { const d = await r.json() as { ops?: OpsRecord[] }; if (alive && Array.isArray(d.ops)) setOps(d.ops) } }
      catch { /* keep the last list */ }
    }
    void poll()
    const id = setInterval(() => void poll(), ms)
    return () => { alive = false; clearInterval(id) }
  }, [enabled, ms])
  return ops
}

export default function Staff() {
  const [data, setData] = useState<StaffData>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [toast, setToast] = useState('')
  const [override, setOverride] = useState<Lang | null>(langOverride)
  const lang: Lang = override ?? (data?.lang === 'en' ? 'en' : 'ro')
  const en = lang === 'en'
  const refresh = useCallback(async () => {
    try { setData(await personalRequest<StaffData>('/api/staff')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'network') }
  }, [])
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  useEffect(() => { window.addEventListener('personal-refresh', refresh); const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 5000); return () => { window.removeEventListener('personal-refresh', refresh); clearTimeout(initial); clearInterval(timer) } }, [refresh])
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(''), 4000); return () => clearTimeout(id) }, [toast])

  const wide = useWide()
  const { index } = useIndex()
  const live = useFlow(2000)
  const ops = useOps(!!data && !Array.isArray(data.notices))
  const tick = useTick(1000)
  const points = useMemo(() => index?.points ?? [], [index])
  const [chatOpen, setChatOpen] = useState(false)
  const channel = useChatChannel({ active: !!sessionToken(), visible: wide || chatOpen })
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [snap, setSnap] = useState<Snap>('peek')
  const [focusReport, setFocusReport] = useState<string | null>(null)
  const vh = useViewportHeight()
  const report = useReportFlow(points)

  const zoneId = data ? (typeof data.zone === 'string' ? data.zone : data.zone?.id ?? null) : null
  const zoneForecast = data && typeof data.zone === 'object' ? data.zone.forecast : undefined
  const zoneL = zoneId ? landmarkFor(points, zoneId) : undefined
  const reports = useMemo(() => data?.reports ?? [], [data])
  const placeOf = useCallback((r: PersonalReport): PathNode | null => {
    const l = landmarkFor(points, r.place?.node)
    return l ? { id: l.id, level: l.level, x: l.x, z: l.z } : r.place?.node ? nodeAt(points, r.place.node) : null
  }, [points])

  /* Pins and the moving team */
  const pins: ReportPin[] = reports.flatMap(r => {
    const at = placeOf(r)
    if (!at) return []
    const resolvedAt = r.state === 'resolved' ? Date.parse(r.timestamps?.resolved ?? r.at) : NaN
    const fade = r.state === 'resolved' ? 1 - (tick - resolvedAt) / RESOLVED_FADE_MS : undefined
    if (fade !== undefined && !(fade > 0.05)) return []
    const kind = TYPE[r.type]?.[en ? 1 : 0] ?? r.type
    return [{ id: r.id, at, state: r.state, priority: r.priority, fade: fade !== undefined ? Math.max(0.3, Math.min(1, fade)) : undefined, label: `${kind} · ${stateLabel(r.state, en)}` }]
  })
  const moving = reports.filter(r => r.state === 'en_route').map(r => {
    const end = placeOf(r)
    const progress = teamProgress(r.timestamps?.en_route, r.etaMin, tick)
    if (!end || !progress || !index) return null
    const path = dispatchPath(index.points, r.place.node!, live.blocked)
    return { r, mark: teamMark(path, progress.t, `${en ? 'Team' : 'Echipa'} · ~${progress.leftMin} min`, end.level, r.id, lang) }
  }).filter((m): m is { r: PersonalReport; mark: TeamMark | null } => !!m)
  const team = moving[0]?.mark ?? null

  const sel = points.find(p => p.id === selected)
  const focus: Focus | null = useMemo(() => {
    if (report.stage === 'form' && report.place) return { key: `rep:${report.place.id}`, pts: [report.place], minW: wide ? 1100 : 520 }
    if (sel) return { key: `sel:${sel.id}`, pts: [sel], minW: wide ? 1100 : 520 }
    const fr = focusReport ? reports.find(r => r.id === focusReport) : undefined
    const at = fr ? placeOf(fr) : null
    if (fr && at) return { key: `report:${fr.id}`, pts: [at, ...(team && team.pin === fr.id ? [team.at] : [])], minW: wide ? 1100 : 520 }
    if (zoneL) return { key: `zone:${zoneL.id}:${wide}`, pts: [zoneL], minW: wide ? 1600 : 700 }
    return null
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sel, zoneL, focusReport, report.stage, report.place?.id, wide])

  if (!sessionToken() || error === '401') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff' : 'Personal'}</h1><a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>
  if (error === '403') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff access' : 'Acces personal'}</h1><a href="/m">{en ? 'My page' : 'Pagina mea'}</a></div></main>

  const situation = data?.situation
  const stateWord = (en ? { normal: 'Normal', busy: 'Busy', full: 'Full', unknown: 'Unknown' } : { normal: 'Normal', busy: 'Ocupat', full: 'Plin', unknown: 'Necunoscut' })[situation?.state ?? 'unknown']
  const zoneName = zoneL ? shortName(zoneL, lang) : staffZone(zoneId ?? '—', en)
  const role = (en ? { security_supervisor: 'supervisor', hall_agent: 'hall agent', incident_commander: 'commander' } : { security_supervisor: 'supervizor', hall_agent: 'agent hol', incident_commander: 'comandant' })[data?.role ?? ''] ?? (en ? 'staff' : 'personal')
  const nameOf = (id: string) => { const l = landmarkFor(points, id); return l ? shortName(l, lang) : staffZone(id, en) }
  const feed = Array.isArray(data?.notices) ? data.notices.slice(0, 20).map((n, i) => ({ id: `${n.timestamp ?? n.at}-${i}`, text: n.text, at: n.at }))
    : zoneId ? notices(ops, zoneId, nameOf, lang) : []

  async function crowd(place?: Landmark) {
    if (!data || busy) return
    setBusy(true)
    try {
      if (place) await sendReport(place, 'crowd', en ? 'Too many people here' : 'Prea multă lume aici', lang)
      else await personalRequest('/api/reports', { type: 'crowd', place: { node: zoneId!, name: staffZone(zoneId!, en) }, text: en ? 'Too many people here' : 'Prea multă lume aici' })
      setToast(en ? 'Passed on. Dispatch decides.' : 'Am transmis. Dispeceratul decide.'); setError(''); await refresh()
    } catch { setError(en ? 'Report unavailable' : 'Raport netrimis') }
    finally { setBusy(false) }
  }
  const send = async (type: string, text: string) => {
    if (!report.place) return false
    try { await sendReport(report.place, type, text, lang); report.cancel(); setSnap('peek'); setToast(en ? 'Passed on. Dispatch decides.' : 'Am transmis. Dispeceratul decide.'); await refresh(); return true }
    catch { return false }
  }

  const header = <header className="dashboard-header lv-head">
    <div className="row"><h1>{zoneName} · {role}</h1><LangToggle lang={lang} onChange={setOverride} /></div>
    {error && <p role="alert">{error === 'Raport netrimis' || error === 'Report unavailable' ? error : en ? 'Data unavailable' : 'Date indisponibile'}</p>}
  </header>
  const strip = <ul className="lv-queues" aria-label={en ? 'My zone' : 'Zona mea'}>
    <li data-testid="queue-wait"><span>{en ? 'Queue' : 'Coadă'}</span><strong>{situation?.waitMin == null ? '—' : Math.ceil(situation.waitMin)} <small>min</small></strong><small className="note">{stateWord}</small></li>
    <li data-testid="queue-people"><span>{en ? 'People' : 'Oameni'}</span><strong>{situation?.people ?? '—'}</strong></li>
    <li data-testid="queue-alerts"><span>{en ? 'Alerts' : 'Alerte'}</span><strong>{data?.alerts.length ?? '—'}</strong></li>
  </ul>
  const actions = <div className="lv-staff-actions">
    <button type="button" className="primary" onClick={() => { setSelected(null); report.start(null); setSnap('peek') }}>{en ? 'Report on the map' : 'Raportează pe hartă'}</button>
    <button type="button" className="crowd-action" disabled={!data || busy} onClick={() => void crowd(sel)}>{en ? 'Too many people here' : 'Prea multă lume aici'}</button>
  </div>
  const searchBar = <>{actions}<SearchBar lang={lang} query={query} chips={false} placeholder={en ? 'Find a place' : 'Caută un loc'} onQuery={q => { setQuery(q); if (q) { setSelected(null); setSnap('full') } }} chip={null} onChip={() => {}} onFocus={() => { if (!wide) setSnap('full') }} /></>

  let content: ReactNode
  if (report.stage) content = <ReportPanel lang={lang} place={report.place} onSend={send} onCancel={report.cancel}
    hint={report.stage === 'pick' ? (en ? 'Tap the map where it is' : 'Atinge harta unde este') : (en ? 'Drag the pin to adjust' : 'Trage acul pentru a ajusta')} />
  else if (sel) content = <PointCard l={sel} lang={lang} mode="staff" flow={live.flow} now={live.now} index={index} hereId={zoneL?.id ?? null} history={live.history}
    onReport={() => report.start(sel.id)} onCrowd={() => void crowd(sel)} onPick={id => setSelected(id)} onClose={() => { setSelected(null); setSnap('peek') }} />
  else if (query) content = <ResultList items={search(points, query, lang)} lang={lang} flow={live.flow} now={live.now} index={index} from={zoneL?.id ?? null}
    onPick={id => { setSelected(id); setQuery(''); setSnap('half') }} empty={en ? 'No place with this name' : 'Niciun loc cu acest nume'} />
  else content = <>
    <h2 className="lv-section-h">{en ? 'My zone' : 'Zona mea'} · {zoneName}</h2>
    {zoneL ? <StaffNumbers flow={live.flow} id={zoneL.id} now={live.now} lang={lang} history={live.history} forecast={zoneForecast} /> : null}
    {situation && situation.forecast.length > 0 && !zoneL && <p>{situation.forecast.map(p => `~${Math.ceil(p.waitMin)} min · +${p.inMin} min`).join(' · ')}</p>}
    {moving.map(({ r }) => { const p = teamProgress(r.timestamps?.en_route, r.etaMin, tick); return p ? <p key={r.id} className="lv-team" data-testid="team-eta">{en ? 'Team' : 'Echipa'} · ~{p.leftMin} min · {r.place.name}</p> : null })}
    <h2 className="lv-section-h">{en ? 'My reports' : 'Rapoartele mele'}</h2>
    {reports.length ? <ul className="lv-myreports">{[...reports].reverse().map(r => <li key={r.id} className={`s-${r.state}`}><button type="button" onClick={() => { setFocusReport(r.id); setSelected(null) }}>
      <i className="ring" aria-hidden="true" /><span><b>{TYPE[r.type]?.[en ? 1 : 0] ?? r.type}</b> · {r.place?.name}{r.text ? ` · ${r.text}` : ''}</span>
      <span className="st">{stateLabel(r.state, en)}{r.state === 'en_route' && r.etaMin != null && ` · ~${teamProgress(r.timestamps?.en_route, r.etaMin, tick)?.leftMin ?? r.etaMin} min`}</span></button></li>)}</ul>
      : <p className="lv-empty">{en ? 'No reports' : 'Niciun raport'}</p>}
    <h2 className="lv-section-h">{en ? 'Dispatch' : 'Dispecerat'}</h2>
    {feed.length ? <ul className="lv-notices" data-testid="dispatch-notices">{feed.map(n => <li key={n.id}>{n.text}<time>{n.at}</time></li>)}</ul> : <p className="lv-empty">{en ? 'No decisions for this zone' : 'Nicio decizie pentru zona ta'}</p>}
    <h2 className="lv-section-h">{en ? 'Alerts' : 'Alerte'}</h2>
    {data?.alerts.length ? <ul className="lv-notices">{data.alerts.map(a => <li key={a.id} className={`priority-${a.priority}`}>{a.priority === 'P1' ? '■' : a.priority === 'P2' ? '▲' : '●'} {staffAlertLabel(a, zoneId ?? '', en)}</li>)}</ul> : <p className="lv-empty">{en ? 'No alerts' : 'Nicio alertă'}</p>}
    {!wide && <div className="lv-buttons"><Chat en={en} channel={channel} onOpen={setChatOpen} /></div>}
  </>

  const inset = wide ? 0 : sheetHeight(snap, vh)
  const map = <LiveMap lang={lang} mode="staff" points={points} flow={live.flow} now={live.now} history={live.history} selected={selected}
    onSelect={id => { if (report.stage) return; setSelected(id); setFocusReport(null); setSnap(id ? 'half' : 'peek') }}
    pins={pins} team={team} focus={focus} insetBottom={inset} picking={report.picking} draft={report.draft} onDraft={p => { report.drop(p); setSnap('half') }}
    home={zoneL ? { id: zoneL.id, at: zoneL, label: en ? 'My zone' : 'Zona mea' } : null}>
    {report.stage === 'pick' && <p className="lv-banner" role="status">{en ? 'Tap the map where it is' : 'Atinge harta unde este'}</p>}
    {toast && <p className="lv-toast" role="status">{toast}</p>}
  </LiveMap>

  if (wide) return <main className="lv me-shell staff-shell wide"><div className="lv-grid">
    <div className="lv-mapcol">{map}</div>
    <aside className="lm-panel" aria-label={en ? 'Details' : 'Detalii'}>
      {header}{strip}<div className="lv-search-wrap">{searchBar}</div>
      <div className="lm-panel-body">{content}</div>
      <section className="lv-chat" aria-label={en ? 'Messages' : 'Mesaje'}><h2>{en ? 'Messages' : 'Mesaje'}</h2><ChatView channel={channel} en={en} id="chat-inline" /></section>
    </aside>
  </div></main>
  return <main className="lv me-shell staff-shell narrow">
    {header}{strip}
    <div className="lv-mapwrap">{map}</div>
    <Sheet wide={false} snap={snap} onSnap={setSnap} header={searchBar} label={en ? 'My zone' : 'Zona mea'}>{content}</Sheet>
  </main>
}
