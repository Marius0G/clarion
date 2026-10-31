import { useEffect, useRef, useState } from 'react'
import { useSim, type OpsCommand } from '../backend/sim'
import { sendOps } from '../backend/ops'
import { useReports } from '../backend/reports'
import { zoneStateLabels, accuracyRows, commandLabel, commandStatusLabels, commandTouchesZone, laneKey, redirectTargets, liveDots, simClock, zoneStats, type CommandStatus } from './opsZones'
import { realPlan, type TerminalPlan, type ZoneKind } from './terminal'
import { mapNodeId } from '../../../backend/src/mapIds'
import type { SimSnapshot } from '../backend/sim'
import { TerminalMap, type ZoneView } from '../map/t2/TerminalMap'
import { levelNames, levels, points as mapPoints, worldToPx, zoneById as mapZones, type Level, type Pt } from '../map/t2/data'
import './ops.css'

/** D16: the admin's single screen. Terminal map, people seen by the cameras, load per zone and the D12 decisions. */
interface Sent { command: OpsCommand; key: string; label: string; status: CommandStatus; at: number }
const UNKNOWN = 'necunoscut'
const number = (value: number | null) => value == null ? '—' : value.toLocaleString('ro-RO')
const minutes = (value: number | null) => value == null ? '—' : `${Math.round(value)} min`
/** D8 desk groups (`check_in:1`, `bag_drop:W6`...) are list rows of their own; on the map they sit in the shared check-in zones. */
const GROUP = /^(check_in|bag_drop):(.+)$/
const groupZone = (id: string) => GROUP.exec(id)?.[1] === 'bag_drop' ? 'G_CHECKIN_DESKS' : 'G_CHECKIN_QUEUE'
function groupName(id: string) {
  const [, kind, group] = GROUP.exec(id)!
  const airline = mapNodeId(`check_in:${group}`).split(':')[1] ?? group
  return `${kind === 'check_in' ? 'Check-in' : 'Bagaje'} ${airline === 'OTHER' ? 'alte companii' : airline}`
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

export function OpsDashboard() {
  const sim = useSim(1000)
  const reports = useReports()
  const [selected, setSelected] = useState<string[]>([])
  const [active, setActive] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (active && window.matchMedia('(max-width: 1100px)').matches) panel.current?.scrollIntoView({ block: 'start' })
  }, [active])
  const [local, setLocal] = useState<Sent[]>([])
  const [busy, setBusy] = useState(false)
  const [floor, setFloor] = useState<Level>('U')
  const plan = dashboardPlan(sim)
  const stats = zoneStats(plan, sim)
  const byId = new Map(stats.map(s => [s.id, s]))
  const zone = active ? byId.get(active) : undefined
  const openZone = (id: string) => { setActive(id); setTarget(''); setFloor(levelOf(id)) }
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
  const dots = people.flatMap(p => p.level && p.z != null ? [{ x: p.x, z: p.z, level: p.level }] : [])
  const perFloor = (l: Level) => pins.filter(p => p.level === l).length
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(z => z !== id) : [...current, id])

  async function send(command: OpsCommand) {
    setBusy(true)
    const result = await sendOps(command)
    const label = commandLabel(command, plan)
    setLocal(current => [result.ok
      ? { command, key: result.command.id, label, status: 'sent' as const, at: Date.parse(result.command.sentAt) || Date.now() }
      : { command, key: `local-${Date.now()}-${current.length}`, label, status: result.reason, at: Date.now() }, ...current].slice(0, 20))
    if (result.ok && command.type === 'evacuate') setSelected([])
    setBusy(false)
  }

  const server = (sim?.ops ?? []).map(o => ({ command: o, key: o.id, label: commandLabel(o, plan), status: o.status as CommandStatus, at: Date.parse(o.sentAt) }))
  const known = new Set(server.map(s => s.key))
  const history = [...server, ...local.filter(l => !known.has(l.key))].sort((a, b) => b.at - a.at)
  const commands = history.slice(0, 5)

  return <div className="ops">
    <header className="ops-top">
      <div className="ops-brand"><b>Clarion</b><span aria-hidden="true">·</span><span>LRCV</span></div>
      <div className="ops-clock" title="Ora simulării (Unity)"><span>Ora simulării</span><time data-testid="sim-clock">{unity ? simClock(sim?.simTime) : '—'}</time></div>
      <span className={`ops-link ${sim == null ? 'down' : cameras ? 'up' : 'off'}`} role="status" data-testid="vision-status">
        <i aria-hidden="true" />{cameras ? 'Camere' : 'Camere offline'}
      </span>
      <span className={`ops-link ${sim == null ? 'down' : unity ? 'up' : 'off'}`} role="status" data-testid="unity-status">
        <i aria-hidden="true" />{sim == null ? 'Backend offline' : unity ? 'Unity conectat' : 'Unity offline'}
      </span>
    </header>
    <main className="ops-main">
      <section className="ops-map" aria-label="Terminal">
        <div className="ops-floors" role="group" aria-label="Etaj">
          {levels.map(l => <button key={l} aria-pressed={floor === l} className={floor === l ? 'on' : undefined} onClick={() => setFloor(l)} data-testid={`floor-${l}`}>
            {levelNames[l].ro}{perFloor(l) > 0 && <b className="ops-floor-pins" aria-label={`${perFloor(l)} rapoarte`}>{perFloor(l)}</b>}
          </button>)}
        </div>
        <div data-testid="terminal-map">
          <TerminalMap level={floor} views={views} selected={mapSelected} onZone={openZone} dots={dots} testIdPrefix="zone-"
            markers={pins.filter(p => p.level === floor).map(p => ({ id: p.id, at: p.at, label: p.text }))} />
        </div>
        <ul className="ops-legend" aria-label="Legendă">
          <li><i className="ops-sw ops-normal" />Normal</li>
          <li><i className="ops-sw ops-near" />Ocupat</li>
          <li><i className="ops-sw ops-full" />Plin</li>
          <li><i className="ops-sw ops-unknown" />Necunoscut</li>
          <li><i className="ops-sw ops-closed" />Închis</li>
          {pins.length > 0 && <li><i className="ops-sw ops-sw-pin" />Raport</li>}
          <li className="ops-plan">Linie punctată: poziție aproximativă</li>
        </ul>
      </section>
      <aside className="ops-side">
        {zone && <section ref={panel} className="ops-panel" aria-label={`Decizii ${zone.name}`} data-testid="zone-panel">
          <div className="ops-panel-head"><h2>{zone.name}</h2><button className="ops-ghost" aria-label="Închide panoul" onClick={() => setActive(null)}>×</button></div>
          <p className="ops-note">{zone.closed ? 'Închis' : 'Deschis'}{zone.staffed ? ` · Linii: ${number(zone.lanes)}` : ''}</p>
          <div className="ops-panel-actions">
            {zone.staffed && <>
              <button disabled={busy || zone.lanes === 0} onClick={() => send({ type: 'staff', zone: laneKey(sim, zone.id), delta: -1 })}>−1 linie</button>
              <button disabled={busy} onClick={() => send({ type: 'staff', zone: laneKey(sim, zone.id), delta: 1 })}>+1 linie</button>
            </>}
            <button disabled={busy} onClick={() => send({ type: zone.closed ? 'open' : 'close', zone: zone.id })}>{zone.closed ? 'Deschide' : 'Închide'}</button>
            <button className="ops-danger" disabled={busy} onClick={() => send({ type: 'evacuate', zones: [zone.id] })}>Evacuează</button>
          </div>
          <div className="ops-panel-actions">
            <select aria-label="Destinație" value={destination} disabled={!targets.length || busy} onChange={e => setTarget(e.target.value)}>
              {targets.length ? targets.map(z => <option key={z.id} value={z.id}>{z.name}</option>) : <option value="">Fără altă zonă de același tip</option>}
            </select>
            <button disabled={busy || !destination} onClick={() => send({ type: 'redirect', from: zone.id, to: destination })}>Mută</button>
          </div>
          <label className="ops-zone-label"><input type="checkbox" checked={selected.includes(zone.id)} onChange={() => toggle(zone.id)} />Adaugă la evacuare</label>
          <div className="ops-panel-status" aria-live="polite">
            {history.filter(c => commandTouchesZone(c.command, zone.id)).slice(0, 5).map(c => <p key={c.key}><span>{c.label}</span> <b className={`ops-cmd ops-cmd-${c.status}`}>{commandStatusLabels[c.status]}</b></p>)}
          </div>
        </section>}

        <div className="ops-evac">
          <button className="ops-danger" disabled={!selected.length || busy} onClick={() => send({ type: 'evacuate', zones: selected })}>
            Evacuare{selected.length ? ` · ${selected.length}` : ''}
          </button>
          <span className="ops-hint">{selected.length ? selected.map(id => byId.get(id)?.name ?? id).join(', ') : 'Adaugă zone din panou'}</span>
          {selected.length > 0 && <button className="ops-ghost" onClick={() => setSelected([])}>Anulează</button>}
        </div>
        <ol className="ops-zones" aria-label="Zone">
          <li className="ops-zones-head" aria-hidden="true"><span>Zonă</span><span>Oameni</span><span>Linii</span><span>Așteptare</span></li>
          {shown.map(s => <li key={s.id} data-testid={`row-${s.id}`} className={active === s.id ? 'ops-selected' : undefined}>
            <button className="ops-zone-label" aria-pressed={active === s.id} onClick={() => openZone(s.id)}>
              <i className={`ops-sw ops-${s.closed ? 'closed' : s.state ?? 'unknown'}`} title={s.closed ? 'Închis' : s.state ? zoneStateLabels[s.state] : 'Necunoscut'} />
              <b>{s.name}</b><span className="ops-state" data-testid="state">{s.state ? zoneStateLabels[s.state] : 'Necunoscut'}</span>
            </button>
            <span data-testid="people" className={s.people == null ? 'ops-unknown-text' : undefined}>{s.people == null ? UNKNOWN : number(s.people)}</span>
            <span data-testid="lanes">{s.staffed ? number(s.lanes) : ''}</span>
            <span data-testid="wait">{minutes(s.waitMin)}</span>
            <div className="ops-zone-line" data-testid="zone-line">
              <span>{s.line.numbers}</span>
              {s.line.action && <><span aria-hidden="true"> · </span><button disabled={busy || s.closed} onClick={() => send({ type: 'staff', zone: laneKey(sim, s.id), delta: s.line.action!.delta })}>{s.line.action.label}</button></>}
            </div>
          </li>)}
        </ol>
        {accuracy.length > 0 && <section className="ops-accuracy" aria-label="Acuratețe" data-testid="accuracy">
          <h2>Acuratețe</h2>
          <table>
            <thead><tr><th scope="col">Zonă</th><th scope="col">Oameni</th><th scope="col">Așteptare</th></tr></thead>
            <tbody>{accuracy.map(a => <tr key={a.id} data-testid={`accuracy-${a.id}`}>
              <th scope="row">{a.name}</th>
              <td>{number(a.camPeople)} / {number(a.truePeople)}</td>
              <td>{minutes(a.camWait)} / {minutes(a.trueWait)}</td>
            </tr>)}</tbody>
          </table>
          <p className="ops-note">camere / real</p>
        </section>}
        <section className="ops-commands" aria-label="Comenzi">
          <h2>Comenzi</h2>
          {commands.length ? <ol>{commands.map(c => <li key={c.key} data-testid="command">
            <span>{c.label}</span><b className={`ops-cmd ops-cmd-${c.status}`}>{commandStatusLabels[c.status]}</b>
          </li>)}</ol> : <p className="ops-empty">Nicio comandă</p>}
        </section>
      </aside>
    </main>
  </div>
}
