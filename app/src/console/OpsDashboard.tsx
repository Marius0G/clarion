import { useEffect, useRef, useState } from 'react'
import { useSim, type OpsCommand } from '../backend/sim'
import { sendOps } from '../backend/ops'
import { useReports } from '../backend/reports'
import { flowStateLabels } from './flow'
import { accuracyRows, commandLabel, commandStatusLabels, commandTouchesZone, redirectTargets, liveDots, simClock, zoneStats, type CommandStatus } from './opsZones'
import { plan } from './terminal'
import './ops.css'

/** D16: the admin's single screen. Terminal map, people seen by the cameras, load per zone and the D12 decisions. */
interface Sent { command: OpsCommand; key: string; label: string; status: CommandStatus; at: number }
const UNKNOWN = 'necunoscut'
const number = (value: number | null) => value == null ? '—' : value.toLocaleString('ro-RO')
const minutes = (value: number | null) => value == null ? '—' : `${Math.round(value)} min`
const box = (polygon: [number, number][]) => {
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
/** A report pin sits on its node, else the centre of a zone with that id. */
function pinAt(node: string): [number, number] | null {
  const n = plan.nodes.find(p => p.id === node)
  if (n) return [n.x, n.y]
  const zone = plan.zones.find(z => z.id === node)
  if (!zone) return null
  const b = box(zone.polygon)
  return [b.x + b.w / 2, b.y + b.h / 2]
}

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
  const stats = zoneStats(plan, sim)
  const byId = new Map(stats.map(s => [s.id, s]))
  const zone = active ? byId.get(active) : undefined
  const targets = zone ? redirectTargets(stats, zone) : []
  const destination = targets.some(z => z.id === target) ? target : targets[0]?.id ?? ''
  const openZone = (id: string) => { setActive(id); setTarget('') }
  const unity = sim?.connected ?? false
  const cameras = sim?.vision ?? false
  const people = liveDots(sim)
  const accuracy = accuracyRows(plan, sim)
  const pins = reports.flatMap(r => { const at = pinAt(r.node); return at ? [{ ...r, at }] : [] })
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
        <svg viewBox={`-1 -1 ${plan.width + 2} ${plan.height + 2}`} role="group" aria-label="Harta terminalului" data-testid="terminal-map">
          <rect x={-1} y={-1} width={plan.width + 2} height={plan.height + 2} className="ops-floor" />
          {plan.zones.map(zone => {
            const stat = byId.get(zone.id)!
            const b = box(zone.polygon)
            const small = b.h < 8
            const on = active === zone.id
            const unknown = stat.people == null && zone.kind !== 'exit'
            return <g key={zone.id} className={`ops-zone ops-${stat.state ?? (unknown ? 'unknown' : 'none')} ops-kind-${zone.kind}${on ? ' ops-selected' : ''}${stat.closed ? ' ops-closed' : ''}`}
              role="button" tabIndex={0} aria-pressed={on} aria-label={zone.name} data-testid={`zone-${zone.id}`}
              onClick={() => openZone(zone.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openZone(zone.id) } }}>
              <polygon points={zone.polygon.map(p => p.join(',')).join(' ')} />
              <text x={b.x + b.w / 2} y={small ? b.y + b.h / 2 + 0.7 : b.y + 3.6} className="ops-zone-name">{zone.name}</text>
              {!small && (stat.people != null
                ? <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 2} className="ops-zone-count">{number(stat.people)}</text>
                : unknown && <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 1} className="ops-zone-unknown">{UNKNOWN}</text>)}
            </g>
          })}
          <g className="ops-dots" aria-hidden="true">
            {people.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={0.4} />)}
          </g>
          <g className="ops-pins">
            {pins.map(r => <g key={r.id} className="ops-pin" transform={`translate(${r.at[0]} ${r.at[1]})`} data-testid="report-pin" role="img" aria-label={`Raport: ${r.text}`}>
              <title>{r.text}</title>
              <path d="M0 0 L-1.4 -2.6 A1.6 1.6 0 1 1 1.4 -2.6 Z" />
              <circle cx={0} cy={-3.4} r={0.6} className="ops-pin-dot" />
            </g>)}
          </g>
        </svg>
        <ul className="ops-legend" aria-label="Legendă">
          <li><i className="ops-sw ops-normal" />Normal</li>
          <li><i className="ops-sw ops-near" />Aproape</li>
          <li><i className="ops-sw ops-full" />Plin</li>
          <li><i className="ops-sw ops-unknown" />Necunoscut</li>
          <li><i className="ops-sw ops-closed" />Închis</li>
          {pins.length > 0 && <li><i className="ops-sw ops-sw-pin" />Raport</li>}
          <li className="ops-plan">Plan provizoriu</li>
        </ul>
      </section>
      <aside className="ops-side">
        {zone && <section ref={panel} className="ops-panel" aria-label={`Decizii ${zone.name}`} data-testid="zone-panel">
          <div className="ops-panel-head"><h2>{zone.name}</h2><button className="ops-ghost" aria-label="Închide panoul" onClick={() => setActive(null)}>×</button></div>
          <p className="ops-note">{zone.closed ? 'Închis' : 'Deschis'}{zone.staffed ? ` · Linii: ${number(zone.lanes)}` : ''}</p>
          {zone.advice && <p className="ops-advice" data-testid="advice">{zone.advice}</p>}
          <div className="ops-panel-actions">
            {zone.staffed && <>
              <button disabled={busy || zone.lanes === 0} onClick={() => send({ type: 'staff', zone: zone.id, delta: -1 })}>−1 linie</button>
              <button disabled={busy} onClick={() => send({ type: 'staff', zone: zone.id, delta: 1 })}>+1 linie</button>
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
          {stats.filter(s => s.kind !== 'exit').map(s => <li key={s.id} data-testid={`row-${s.id}`} className={active === s.id ? 'ops-selected' : undefined}>
            <button className="ops-zone-label" aria-pressed={active === s.id} onClick={() => openZone(s.id)}>
              <i className={`ops-sw ops-${s.closed ? 'closed' : s.state ?? (s.people == null ? 'unknown' : 'none')}`} title={s.closed ? 'Închis' : s.state ? flowStateLabels[s.state] : s.people == null ? 'Necunoscut' : ''} />
              <b>{s.name}</b>
            </button>
            <span data-testid="people" className={s.people == null ? 'ops-unknown-text' : undefined}>{s.people == null ? UNKNOWN : number(s.people)}</span>
            <span data-testid="lanes">{s.staffed ? number(s.lanes) : ''}</span>
            <span data-testid="wait">{minutes(s.waitMin)}</span>
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
