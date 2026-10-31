import { useEffect, useRef, useState } from 'react'
import { useSim, type OpsCommand } from '../backend/sim'
import { sendOps } from '../backend/ops'
import { useReports } from '../backend/reports'
import { liveRow, zoneStateLabels, accuracyRows, commandLabel, commandStatusLabels, commandTouchesZone, laneKey, redirectTargets, liveDots, simClock, zoneStats, type CommandStatus } from './opsZones'
import { realPlan, type TerminalPlan, type ZoneKind } from './terminal'
import { desksForGroup, mapNodeId } from '../../../backend/src/mapIds'
import type { SimSnapshot } from '../backend/sim'
import { TerminalMap, type MapLayers, type ZoneView } from '../map/t2/TerminalMap'
import { backend } from '../backend/config'
import { levelNames, points as mapPoints, worldToPx, zoneById as mapZones, type Level, type Pt } from '../map/t2/data'
import { breach, bulletScale, executor, flightTime, noActionWait, orderZones, taskState, topMetrics, waitTarget, type TaskEvidence, type ZoneOrder } from './screen'
import { AlertList } from './AlertList'
import { alertMapZone, alertNumbers, alertPresentation, alertSymbols, sendAlertCommand, type Alert, type AlertCommand } from './alerts'
import './ops.css'

/** D16: the admin's single screen. Terminal map, people seen by the cameras, load per zone and the D12 decisions. */
interface Sent { command: OpsCommand; key: string; label: string; status: CommandStatus; at: number; evidence?: TaskEvidence }
const UNKNOWN = 'necunoscut'
const number = (value: number | null) => value == null ? '—' : value.toLocaleString('ro-RO')
const minutes = (value: number | null) => value == null ? '—' : `${Math.round(value)} min`
/** D8 desk groups (`check_in:1`, `bag_drop:W6`...) are list rows of their own; on the map they sit in the shared check-in zones. */
const GROUP = /^(check_in|bag_drop):(.+)$/
const groupZone = (id: string) => GROUP.exec(id)?.[1] === 'bag_drop' ? 'G_CHECKIN_DESKS' : 'G_CHECKIN_QUEUE'
function groupName(id: string) {
  const [, kind] = GROUP.exec(id)!
  // Groups are physical desks assigned per flight (D26), so name them by desk numbers, not airline.
  const desks = desksForGroup(id).map(d => d.replace('checkin_', ''))
  const range = desks.length ? `ghișee ${desks[0]}–${desks.at(-1)}` : id.split(':')[1]
  return `${kind === 'check_in' ? 'Check-in' : 'Bagaje'} ${range}`
}
/** Real T2 zones plus whatever desk groups the backend or the cameras know about. */
function dashboardPlan(sim: SimSnapshot | null): TerminalPlan {
  const keys = new Set([...Object.keys(sim?.flow ?? {}), ...Object.keys(sim?.lanes ?? {})].filter(k => GROUP.test(k)))
  const groups = [...keys].sort().map(id => ({ id, kind: GROUP.exec(id)![1] as ZoneKind, name: groupName(id), polygon: [] as [number, number][], level: 'G' }))
  return { ...realPlan, zones: [...realPlan.zones.map(z => ({ ...z, name: z.name.replace(/\s*\*$/, '') })), ...groups] }
}
const levelOf = (id: string): Level => GROUP.test(id) ? 'G' : (mapZones.get(id)?.level ?? mapZones.get(mapNodeId(id))?.level ?? 'G')
/** A report pin sits on its zone (any id alias) or map point. */
function pinAt(node: string): { level: Level; at: Pt } | null {
  const zone = mapZones.get(node) ?? mapZones.get(mapNodeId(node)) ?? (GROUP.test(node) ? mapZones.get(groupZone(node)) : undefined)
  if (zone) return { level: zone.level, at: worldToPx(zone.centre[0], zone.centre[1], zone.level) }
  const point = mapPoints.find(p => p.id === node || p.id === mapNodeId(node))
  return point ? { level: point.level, at: point.px } : null
}
const rank = { normal: 1, near: 2, full: 3 } as const
/** Queues always listed, even before any camera data. */
const CORE = ['U_SECURITY_QUEUE', 'U_PASSPORT_DEP']

/** Map view settings, per browser. */
interface View { layers: Required<MapLayers> & { cameras: boolean; base: boolean }; refreshMs: number }
const VIEW_KEY = 'clarion.map'
const defaults: View = { layers: { dots: true, heat: false, labels: true, points: true, pins: true, cameras: false, base: false }, refreshMs: 1000 }
function loadView(): View {
  try {
    const saved = JSON.parse(window.localStorage.getItem(VIEW_KEY) ?? 'null') as Partial<View> | null
    return { layers: { ...defaults.layers, ...saved?.layers }, refreshMs: [1000, 2000, 5000].includes(saved?.refreshMs ?? 0) ? saved!.refreshMs! : defaults.refreshMs }
  } catch { return defaults }
}
const layerNames: [keyof View['layers'], string][] = [
  ['dots', 'Oameni'], ['heat', 'Densitate'], ['labels', 'Etichete'], ['points', 'Puncte'], ['pins', 'Rapoarte'], ['cameras', 'Camere'], ['base', 'Randare Unity'],
]

export function OpsDashboard() {
  const [viewSettings, setViewSettings] = useState<View>(loadView)
  const [settings, setSettings] = useState(false)
  const [backendUrl, setBackendUrl] = useState(backend.http)
  const saveView = (next: View) => { setViewSettings(next); try { window.localStorage.setItem(VIEW_KEY, JSON.stringify(next)) } catch { /* private mode */ } }
  const sim = useSim(viewSettings.refreshMs)
  const reports = useReports()
  const latestSim = useRef(sim)
  useEffect(() => { latestSim.current = sim }, [sim])
  const [alertResult, setAlertResult] = useState<{ source: SimSnapshot | null; alerts: Alert[] } | null>(null)
  const alerts = alertResult && alertResult.source === sim ? alertResult.alerts : (sim as (SimSnapshot & { alerts?: Alert[] }) | null)?.alerts ?? []
  async function commandAlert(command: AlertCommand) {
    const rows = await sendAlertCommand(command)
    setAlertResult({ source: latestSim.current, alerts: rows })
  }
  const [selected, setSelected] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (active && window.matchMedia('(max-width: 1100px)').matches) panel.current?.scrollIntoView({ block: 'start' })
  }, [active])
  const [local, setLocal] = useState<Sent[]>([])
  const [order, setOrder] = useState<{ source: SimSnapshot | null | undefined; value?: ZoneOrder }>({ source: undefined })
  const [completed, setCompleted] = useState<Set<string>>(() => new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const [dismissed, setDismissed] = useState<string[]>([])
  const [rejections, setRejections] = useState<{ key: string; at: number; label: string }[]>([])
  const [busy, setBusy] = useState(false)
  const [floor, setFloor] = useState<Level>('U')
  const plan = dashboardPlan(sim)
  const stats = zoneStats(plan, sim)
  const byId = new Map(stats.map(s => [s.id, s]))
  const zone = active ? byId.get(active) : undefined
  const openZone = (id: string) => { setSettings(false); setActive(id); setTarget(''); setFloor(levelOf(id) === 'X' ? 'G' : levelOf(id)) }
  const unity = sim?.connected ?? false
  const cameras = sim?.vision ?? false
  const people = liveDots(sim)
  const accuracy = accuracyRows(plan, sim)
  const pins = reports.flatMap(r => { const at = pinAt(r.node); return at ? [{ ...r, ...at }] : [] })
  // Map colours: a zone's own row; the shared check-in zones also show their worst desk group. Never summed.
  const views: Record<string, ZoneView> = {}
  for (const s of stats) {
    const target = GROUP.test(s.id) ? groupZone(s.id) : s.id
    const v = views[target] ?? (views[target] = {})
    if (target === s.id) { v.people = s.people; v.waitMin = s.waitMin; v.closed = s.closed }
    if (s.state && (!v.state || rank[s.state] > rank[v.state])) v.state = s.state
  }
  const mapSelected = active && GROUP.test(active) ? groupZone(active) : active
  const shown = stats.filter(s => s.kind !== 'exit' && (GROUP.test(s.id) || CORE.includes(s.id) || s.staffed && s.lanes != null || s.state != null || s.people != null || s.closed || s.id === active))
  const targets = zone ? redirectTargets(shown, zone) : []
  const destination = targets.some(z => z.id === target) ? target : targets[0]?.id ?? ''
  const currentOrder = order.source === sim && order.value ? order.value : orderZones(shown, sim, Date.parse(sim?.lastSeen ?? '') || (sim?.simTime ?? 0) * 1000, order.value)
  if (order.source !== sim) setOrder({ source: sim, value: currentOrder })
  const ordered = currentOrder.ids.flatMap(id => { const z = byId.get(id); return z ? [z] : [] })
  const metrics = topMetrics(stats, sim)
  const dots = people.flatMap(p => p.level && p.z != null ? [{ x: p.x, z: p.z, level: p.level, kind: p.kind }] : [])
  const perFloor = (l: Level) => pins.filter(p => p.level === l).length
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(z => z !== id) : [...current, id])

  async function send(command: OpsCommand) {
    setBusy(true)
    const sourceId = command.type === 'evacuate' ? command.zones[0] : command.type === 'redirect' ? command.from : command.zone
    const before = liveRow(sim, sourceId)
    const evidence = before ? { before, simTime: sim?.simTime ?? null } : undefined
    const result = await sendOps(command)
    const label = commandLabel(command, plan)
    setLocal(current => [result.ok
      ? { command, key: result.command.id, label, status: 'sent' as const, evidence, at: Date.parse(result.command.sentAt) || Date.now() }
      : { command, key: `local-${Date.now()}-${current.length}`, label, status: result.reason, at: Date.now() }, ...current].slice(0, 20))
    if (result.ok && command.type === 'evacuate') setSelected([])
    setBusy(false)
  }

  const server = (sim?.ops ?? []).map(o => ({ evidence: local.find(l => l.key === o.id)?.evidence, command: o, key: o.id, label: commandLabel(o, plan), status: o.status as CommandStatus, at: Date.parse(o.sentAt) }))
  const known = new Set(server.map(s => s.key))
  const history = [...server, ...local.filter(l => !known.has(l.key))].sort((a, b) => b.at - a.at)
  const newlyCompleted = history.filter(c => !completed.has(c.key) && taskState(c.command, c.status, sim, c.evidence) === 'done')
  const done = newlyCompleted.length ? new Set([...completed, ...newlyCompleted.map(c => c.key)]) : completed
  if (newlyCompleted.length) setCompleted(done)
  const recommendation = ordered.find(z => z.line.action && !dismissed.includes(`${z.id}:${z.line.action.label}`) && !history.some(c => (c.status === 'sent' || c.status === 'acked') && !done.has(c.key) && commandTouchesZone(c.command, z.id)))

  const floors = ['G', 'U'] as const
  const floorShort = { G: 'P', U: '1' }

  const flightsN = sim?.flights?.length ?? 0
  /** Desk groups that share the selected hall (D8): one button each, so a single group can be acted on. */
  const panelGroups = mapSelected ? stats.filter(s => GROUP.test(s.id) && groupZone(s.id) === mapSelected) : []
  const layers = viewSettings.layers
  /** Hover card: the zone's own numbers, or the desk groups that sit in it. Nothing invented. */
  const describe = (id: string) => {
    const own = byId.get(id)
    const groups = stats.filter(s => GROUP.test(s.id) && groupZone(s.id) === id && s.people != null)
    const name = own?.name ?? mapZones.get(id)?.name_ro ?? id
    const v = views[id]
    const forecast = own ? liveRowForecast(sim, own.id) : null
    return <div className="ops-card">
      <div className="ops-card-head"><b>{name}</b>{v?.closed ? <span className="ops-card-state is-closed">Închis</span> : v?.state ? <span className={`ops-card-state is-${v.state}`}>{zoneStateLabels[v.state]}</span> : <span className="ops-card-state">Necunoscut</span>}</div>
      {own && (own.people != null || own.waitMin != null || own.lanes != null) && <dl className="ops-card-figs">
        {own.people != null && <div><dt>Oameni</dt><dd>{number(own.people)}</dd></div>}
        {own.waitMin != null && <div><dt>Așteptare</dt><dd>{minutes(own.waitMin)}</dd></div>}
        {own.staffed && own.lanes != null && <div><dt>Linii</dt><dd>{number(own.lanes)}</dd></div>}
      </dl>}
      {forecast && <p className="ops-card-line">Peste o oră: <b>{forecast}</b></p>}
      {groups.map(g => <p key={g.id} className="ops-card-line">{g.name}: <b>{minutes(g.waitMin)}</b> · {number(g.people)} pers.</p>)}
      {onClickHint(own)}
    </div>
  }

  return <div className="ops ops-console">
    <header className="ops-metrics" aria-label="Indicatori" data-testid="top-band">
      {[
        ['Așteptare maximă', minutes(metrics.worst)], ['Prima depășire', simClock(metrics.first).slice(0, 5)],
        ['Sub țintă azi', '—'], ['Zboruri în pericol', String(new Set(alerts.filter(a => a.kind === 'flight-risk' && a.active).map(a => a.flight)).size)],
        ['Densitate maximă', metrics.density == null ? '—' : `${metrics.density.toFixed(1)} /m²`],
      ].map(([label, value, note]) => <div key={label}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>)}
    </header>
    <main className={`ops-stage${zone || settings ? ' has-panel' : ''}`}>
      <div className="ops-canvas" data-testid="terminal-map" onMouseOver={e => {
        const id = (e.target as Element).closest('[data-testid^="zone-"]')?.getAttribute('data-testid')?.slice(5)
        if (id) setHovered(id)
      }} onMouseLeave={() => setHovered(null)}>
        <TerminalMap level={floor} views={views} selected={hovered ? (GROUP.test(hovered) ? groupZone(hovered) : hovered) : mapSelected} onZone={openZone} dots={dots} testIdPrefix="zone-"
          focus={mapSelected} wheelZoom keys describe={describe} cameras={layers.cameras} base={layers.base}
          layers={{ dots: layers.dots, heat: layers.heat, labels: layers.labels, points: layers.points, pins: layers.pins }}
          markers={pins.filter(p => p.level === floor).map(p => ({ id: p.id, at: p.at, label: p.text }))} />
      </div>

      <aside className="ops-rail" aria-label="Operațiuni">
        <section className="ops-recommendation" data-testid="advice">
          <h2>Recomandare</h2>
          {recommendation ? <>
            <b>{recommendation.line.action!.label}</b><p>{recommendation.name}</p>
            <p>{recommendation.line.numbers}</p>
            {(() => { const advice = liveRow(sim, recommendation.id)?.advice; const a = typeof advice === 'object' ? advice : null; return <p>Cu acțiune: {minutes(a?.waitMin ?? null)} · Fără acțiune: {minutes(a?.waitMinIfNot ?? null)}</p> })()}
            <p>Executant: Supervizor securitate</p>
            <button disabled={busy} onClick={() => send({ type: 'staff', zone: laneKey(sim, recommendation.id), delta: recommendation.line.action!.delta })}>Trimite</button>{' '}
            <button onClick={() => { setDismissed(d => [...d, `${recommendation.id}:${recommendation.line.action!.label}`]); setRejections(r => [...r, { key: `rejected-${Date.now()}`, at: Date.now(), label: `${recommendation.name} · ${recommendation.line.action!.label}` }]) }}>Respinge</button>
          </> : <p>Fără recomandări</p>}
        </section>
        <AlertList alerts={alerts} simTime={sim?.simTime ?? null} onZone={id => openZone(byId.has(id) ? id : alertMapZone(id))} onCommand={commandAlert} />
        <section aria-label="Zone"><h2>Zone</h2><p>Bară: acum · | țintă · ○ +30 · ◉ +60</p>
          {ordered.filter(z => z.state !== 'normal' || z.id === active).map(z => {
            const row = liveRow(sim, z.id), target = waitTarget(z), scale = target == null ? null : bulletScale(z.waitMin, target, row)
            const next = breach(z, row)
            const priority = z.state === 'full' ? 'p2' : z.state === 'near' ? (target == null || z.waitMin != null && z.waitMin > target ? 'p2' : 'p3') : ''
            return <button key={z.id} className={`ops-zone-row ${hovered === z.id || active === z.id ? 'selected' : ''}`} data-testid={`row-${z.id}`} onMouseEnter={() => { setHovered(z.id); setFloor(levelOf(z.id)) }} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(z.id)} onBlur={() => setHovered(null)} onClick={() => openZone(z.id)}>
              <span>{z.name}</span><b className={priority}>{priority ? priority === 'p2' ? '▲ P2 ' : '● P3 ' : ''}{target == null ? row?.density != null ? `${row.density} /m²` : '—' : minutes(z.waitMin)}</b>
              {scale && <svg className="ops-bullet" viewBox="-2 0 104 20" role="img" aria-label={`Acum ${minutes(z.waitMin)}, țintă ${target} min, +30 ${minutes(row?.forecast?.find(p => p.inMin === 30)?.waitMin ?? null)}, +60 ${minutes(row?.forecast?.find(p => p.inMin === 60)?.waitMin ?? null)}`}>
                <rect className="normal-band" x="0" y="4" width={scale.target} height="12" />
                {scale.wait != null && <rect x="0" y="7" width={scale.wait} height="6" />}
                <path d={`M${scale.target},1v18`} />
                {scale.next30 != null && <circle cx={scale.next30} cy="10" r="3" fill="none" />}
                {scale.next60 != null && <circle cx={scale.next60} cy="10" r="3" />}
              </svg>}
              <small>{Number.isFinite(next) ? `> țintă ${next === 0 ? 'acum' : `la ${simClock(sim?.simTime == null ? null : sim.simTime + next * 60).slice(0, 5)}`}` : z.state == null ? 'Necunoscut' : 'Sub țintă'}</small>
            </button>
          })}
          <details><summary>Zone OK · {ordered.filter(z => z.state === 'normal').length}</summary>{ordered.filter(z => z.state === 'normal').map(z => <button key={z.id} onMouseEnter={() => { setHovered(z.id); setFloor(levelOf(z.id)) }} onMouseLeave={() => setHovered(null)} onClick={() => openZone(z.id)}>{z.name} · {minutes(z.waitMin)}</button>)}</details>
        </section>
        <section aria-label="Zboruri"><h2>Zboruri</h2><table className="ops-fids"><thead><tr>{['Ora', 'Zbor', 'Destinație', 'Poartă', 'Status'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>
          {(sim?.flights ?? []).map(f => <tr key={f.flight}><td>{flightTime(f.std)}</td><td>{f.flight}</td><td>{f.destination}</td><td>{f.gate ?? '—'}</td><td className={f.status === 'delayed' || f.status === 'cancelled' ? 'p2' : ''}>{f.status === 'delayed' || f.status === 'cancelled' ? '▲ P2 ' : ''}{{ scheduled: 'Programat', boarding: 'Îmbarcare', delayed: 'Întârziat', cancelled: 'Anulat', departed: 'Plecat' }[f.status]}</td></tr>)}
        </tbody></table></section>
        <section aria-label="Jurnal" data-testid="journal"><h2>Jurnal</h2>
          {[...alerts.map(a => ({ key: `alert:${a.id}`, at: a.updatedAt, pending: alertPresentation(a, sim?.simTime ?? null).needsAck, content: <><b className={a.priority.toLowerCase()}>{alertSymbols[a.priority]} {a.priority} · {a.text}</b><p>{simClock(a.updatedAt)} · {alertPresentation(a, sim?.simTime ?? null).label}</p><p>{a.zoneId ?? a.flight} · {alertNumbers(a)}</p>{a.state === 'shelved' && <p>{a.shelveReason} · {simClock(a.shelvedUntil)}</p>}</> })), ...rejections.map(r => ({ ...r, content: <><b>{r.label}</b><p>Respins · Recomandare</p></>, pending: false })), ...reports.map(r => ({ key: r.id, at: Date.parse(r.at), content: <><b>{r.text}</b><p>{r.node} · {r.status === 'acked' ? 'Confirmat' : 'Neconfirmat'}</p></>, pending: r.status !== 'acked' })), ...history.map(c => {
            const state = taskState(c.command, c.status, sim, c.evidence, done.has(c.key) ? 'done' : undefined)
            const id = c.command.type === 'evacuate' ? c.command.zones[0] : c.command.type === 'redirect' ? c.command.from : c.command.zone
            return { key: c.key, at: c.at, pending: state === 'sent', content: <><b>{c.label}</b><p>{state === 'done' ? 'Făcut' : commandStatusLabels[state as CommandStatus]} · {executor(c.command)}</p><p>Camere: {minutes(liveRow(sim, id)?.waitMin ?? null)} · Fără acțiune: {minutes(noActionWait(c.evidence, sim?.simTime))}</p>{c.command.type === 'evacuate' && <fieldset><legend>Pași operaționali</legend>{['Alarmă', 'Anunț', 'Verificare', 'Numărătoare la adunare'].map(step => <label key={step}><input type="checkbox" />{step}</label>)}</fieldset>}</> }
          })].sort((a, b) => {
            const time = (item: { key: string; at: number }) => item.key.startsWith('alert:') ? item.at : sim?.simTime != null && sim.lastSeen ? sim.simTime + (item.at - Date.parse(sim.lastSeen)) / 1000 : 0
            return time(b) - time(a)
          }).map(item => <article key={item.key} className={item.pending ? 'unacknowledged' : ''}>{item.content}</article>)}
          {!alerts.length && !reports.length && !history.length && !rejections.length && <p>Nicio înregistrare</p>}
        </section>
      </aside>
      <div className="ops-corner">
        <nav className="ops-floors" aria-label="Etaj">
          {floors.map(l => <button key={l} aria-pressed={floor === l} aria-label={levelNames[l].ro} title={levelNames[l].ro} className={floor === l ? 'on' : undefined} onClick={() => setFloor(l)} data-testid={`floor-${l}`}>
            <span>{floorShort[l]}</span>{perFloor(l) > 0 && <b className="ops-floor-pins" aria-label={`${perFloor(l)} rapoarte`}>{perFloor(l)}</b>}
          </button>)}
        </nav>
        <button className={`ops-gear${settings ? ' on' : ''}`} aria-label="Setări" aria-expanded={settings} title="Setări" onClick={() => { setSettings(o => !o); setActive(null) }} data-testid="settings-toggle">
          <i className={`ops-health ${sim == null ? 'down' : unity && cameras ? 'up' : 'off'}`} aria-hidden="true" />
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>
        </button>
      </div>

      {settings && <aside className="ops-settings" aria-label="Setări" data-testid="settings">
        <div className="ops-panel-head"><h2>Setări</h2><button className="ops-ghost" aria-label="Închide setările" onClick={() => setSettings(false)}>×</button></div>
        <section>
          <h3>Straturi</h3>
          <div className="ops-toggles">{layerNames.map(([k, label]) => <label key={k} className="ops-toggle">
            <input type="checkbox" checked={layers[k]} onChange={e => saveView({ ...viewSettings, layers: { ...layers, [k]: e.target.checked } })} data-testid={`layer-${k}`} />
            <span>{label}</span>
          </label>)}</div>
        </section>
        <section>
          <h3>Actualizare</h3>
          <div className="ops-seg" role="group" aria-label="Actualizare">
            {[1000, 2000, 5000].map(ms => <button key={ms} aria-pressed={viewSettings.refreshMs === ms} className={viewSettings.refreshMs === ms ? 'on' : undefined} onClick={() => saveView({ ...viewSettings, refreshMs: ms })}>{ms / 1000} s</button>)}
          </div>
        </section>
        <section>
          <h3>Integrări</h3>
          <dl className="ops-integrations">
            <div><dt>Ora terminalului</dt><dd data-testid="sim-clock">{unity ? simClock(sim?.simTime) : '—'}</dd></div>
            <div><dt>Backend</dt><dd><span className={`ops-link ${sim == null ? 'down' : 'up'}`}><i />{sim == null ? 'Offline' : backend.host}</span></dd></div>
            <div><dt>Unity</dt><dd><span className={`ops-link ${sim == null ? 'down' : unity ? 'up' : 'off'}`} role="status" data-testid="unity-status"><i />{sim == null ? 'Backend offline' : unity ? 'Unity conectat' : 'Unity offline'}</span></dd></div>
            <div><dt>Camere</dt><dd><span className={`ops-link ${sim == null ? 'down' : cameras ? 'up' : 'off'}`} role="status" data-testid="vision-status"><i />{cameras ? 'Camere' : 'Camere offline'}</span></dd></div>
            <div><dt>Zboruri</dt><dd>{flightsN || '—'}</dd></div>
            <div><dt>Token</dt><dd>{backend.token ? 'Setat' : 'Lipsă'}</dd></div>
          </dl>
          <form className="ops-backend" onSubmit={e => { e.preventDefault(); const u = new URL(window.location.href); u.searchParams.set('backend', backendUrl); window.location.assign(u.href) }}>
            <input aria-label="Adresă backend" value={backendUrl} onChange={e => setBackendUrl(e.target.value)} spellCheck={false} />
            <button type="submit" disabled={!backendUrl || backendUrl === backend.http}>Aplică</button>
          </form>
        </section>
        {accuracy.length > 0 && <section className="ops-accuracy" aria-label="Acuratețe" data-testid="accuracy">
          <h3>Acuratețe</h3>
          <table>
            <thead><tr><th scope="col">Zonă</th><th scope="col">Oameni</th><th scope="col">Așteptare</th></tr></thead>
            <tbody>{accuracy.map(a => <tr key={a.id} data-testid={`accuracy-${a.id}`}>
              <th scope="row">{a.name}</th>
              <td>{number(a.camPeople)} / {number(a.truePeople)}</td>
              <td>{minutes(a.camWait)} / {minutes(a.trueWait)}</td>
            </tr>)}</tbody>
          </table>
          <p className="ops-note">Camere / Unity</p>
        </section>}
      </aside>}

      {zone && <section ref={panel} className={`ops-panel is-${zone.closed ? 'closed' : zone.state ?? 'unknown'}`} aria-label={`Decizii ${zone.name}`} data-testid="zone-panel">
        <div className="ops-panel-head">
          <div><h2>{zone.name}</h2>
            <p className="ops-note">{zone.closed ? 'Închis' : 'Deschis'}{zone.staffed && <span className="ops-lanes">Linii deschise <b>{number(zone.lanes)}</b></span>}</p></div>
          <button className="ops-ghost" aria-label="Închide panoul" onClick={() => setActive(null)}>×</button>
        </div>
        {panelGroups.length > 0 && <div className="ops-seg ops-groups" role="group" aria-label="Grup ghișee">
          {panelGroups.map(g => <button key={g.id} aria-pressed={active === g.id} className={active === g.id ? 'on' : undefined} onClick={() => openZone(g.id)} data-testid={`group-${g.id}`}>{g.name.replace(/^(Check-in|Bagaje) ghișee /, '')}</button>)}
        </div>}
        <dl className="ops-figures">
          <div><dt>Oameni</dt><dd data-testid="people" className={zone.people == null ? 'ops-unknown-text' : undefined}>{zone.people == null ? UNKNOWN : number(zone.people)}</dd></div>
          <div><dt>Linii</dt><dd data-testid="lanes">{zone.staffed ? number(zone.lanes) : ''}</dd></div>
          <div><dt>Așteptare</dt><dd data-testid="wait">{minutes(zone.waitMin)}</dd></div>
        </dl>
        {zone.line.action && <div className="ops-zone-line" data-testid="zone-line">
          <span>{zone.line.numbers}</span>
          <button className="ops-advice" disabled={busy || zone.closed} onClick={() => send({ type: 'staff', zone: laneKey(sim, zone.id), delta: zone.line.action!.delta })}>{zone.line.action.label}</button>
        </div>}
        {zone.staffed && <div className="ops-stepper" role="group" aria-label="Linii">
          <button disabled={busy || zone.lanes === 0} onClick={() => send({ type: 'staff', zone: laneKey(sim, zone.id), delta: -1 })}>−1 linie</button>
          <button disabled={busy} onClick={() => send({ type: 'staff', zone: laneKey(sim, zone.id), delta: 1 })}>+1 linie</button>
        </div>}
        {targets.length > 0 && <div className="ops-panel-actions">
          <select aria-label="Destinație" value={destination} disabled={busy} onChange={e => setTarget(e.target.value)}>
            {targets.map(z => <option key={z.id} value={z.id}>{z.name}</option>)}
          </select>
          <button disabled={busy || !destination} onClick={() => send({ type: 'redirect', from: zone.id, to: destination })}>Mută</button>
        </div>}
        <div className="ops-panel-actions">
          <button disabled={busy} onClick={() => send({ type: zone.closed ? 'open' : 'close', zone: zone.id })}>{zone.closed ? 'Deschide' : 'Închide'}</button>
          <button className="ops-danger" disabled={busy} onClick={() => send({ type: 'evacuate', zones: [zone.id] })}>Evacuează</button>
        </div>
        <label className="ops-check"><input type="checkbox" checked={selected.includes(zone.id)} onChange={() => toggle(zone.id)} />Adaugă la evacuare</label>
        <div className="ops-panel-status" aria-live="polite">
          {history.filter(c => commandTouchesZone(c.command, zone.id)).slice(0, 5).map(c => <p key={c.key}><span>{c.label}</span> <b className={`ops-cmd ops-cmd-${c.status}`}>{commandStatusLabels[c.status]}</b></p>)}
        </div>
      </section>}

      {selected.length > 0 && <div className="ops-evac armed" data-testid="evac-bar">
        <button className="ops-danger" disabled={busy} onClick={() => send({ type: 'evacuate', zones: selected })}>
          {`Evacuează ${selected.length} ${selected.length === 1 ? 'zonă' : 'zone'}`}
        </button>
        <span className="ops-hint">{selected.map(id => byId.get(id)?.name ?? id).join(', ')}</span>
        <button className="ops-ghost" aria-label="Anulează evacuarea" onClick={() => setSelected([])}>×</button>
      </div>}
    </main>
  </div>
}

/** Worst forecast wait in the next hour, from the cameras' forecast (D5b); null when none. */
function liveRowForecast(sim: SimSnapshot | null, id: string): string | null {
  const row = liveRow(sim, id)
  const next = (row?.forecast ?? []).filter(p => p.inMin <= 60 && Number.isFinite(p.waitMin))
  if (!next.length) return null
  return `${Math.round(Math.max(...next.map(p => p.waitMin)))} min`
}
const onClickHint = (zone: { staffed: boolean } | undefined) => zone?.staffed ? <p className="ops-card-hint">Click pentru decizii</p> : null
