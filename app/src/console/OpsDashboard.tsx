import { useState } from 'react'
import { useSim, type OpsCommand } from '../backend/sim'
import { sendOps } from '../backend/ops'
import { flowStateLabels } from './flow'
import { commandLabel, commandStatusLabels, simClock, zoneStats, type CommandStatus } from './opsZones'
import { plan } from './terminal'
import './ops.css'

/** D16: the admin's single screen. Terminal map, people, load per zone and the D12 decisions. */
interface Sent { key: string; label: string; status: CommandStatus; at: number }
const number = (value: number | null) => value == null ? '—' : value.toLocaleString('ro-RO')
const box = (polygon: [number, number][]) => {
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}

export function OpsDashboard() {
  const sim = useSim(1000)
  const [selected, setSelected] = useState<string[]>([])
  const [local, setLocal] = useState<Sent[]>([])
  const [busy, setBusy] = useState(false)
  const stats = zoneStats(plan, sim)
  const byId = new Map(stats.map(s => [s.id, s]))
  const unity = sim?.connected ?? false
  const people = unity ? sim?.positions?.people ?? [] : []
  const toggle = (id: string) => setSelected(current => current.includes(id) ? current.filter(z => z !== id) : [...current, id])

  async function send(command: OpsCommand) {
    setBusy(true)
    const result = await sendOps(command)
    const label = commandLabel(command, plan)
    setLocal(current => [result.ok
      ? { key: result.command.id, label, status: 'sent' as const, at: Date.parse(result.command.sentAt) || Date.now() }
      : { key: `local-${Date.now()}-${current.length}`, label, status: result.reason, at: Date.now() }, ...current].slice(0, 20))
    if (result.ok && command.type === 'evacuate') setSelected([])
    setBusy(false)
  }

  const server = (sim?.ops ?? []).map(o => ({ key: o.id, label: commandLabel(o, plan), status: o.status as CommandStatus, at: Date.parse(o.sentAt) }))
  const known = new Set(server.map(s => s.key))
  const commands = [...server, ...local.filter(l => !known.has(l.key))].sort((a, b) => b.at - a.at).slice(0, 5)

  return <div className="ops">
    <header className="ops-top">
      <div className="ops-brand"><b>Clarion</b><span aria-hidden="true">·</span><span>LRCV</span></div>
      <div className="ops-clock" title="Ora simulării (Unity)"><span>Ora simulării</span><time data-testid="sim-clock">{unity ? simClock(sim?.simTime) : '—'}</time></div>
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
            const on = selected.includes(zone.id)
            return <g key={zone.id} className={`ops-zone ops-${stat.state ?? 'none'} ops-kind-${zone.kind}${on ? ' ops-selected' : ''}`}
              role="button" tabIndex={0} aria-pressed={on} aria-label={zone.name} data-testid={`zone-${zone.id}`}
              onClick={() => toggle(zone.id)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(zone.id) } }}>
              <polygon points={zone.polygon.map(p => p.join(',')).join(' ')} />
              <text x={b.x + b.w / 2} y={small ? b.y + b.h / 2 + 0.7 : b.y + 3.6} className="ops-zone-name">{zone.name}</text>
              {!small && stat.people != null && <text x={b.x + b.w / 2} y={b.y + b.h / 2 + 2} className="ops-zone-count">{number(stat.people)}</text>}
            </g>
          })}
          <g className="ops-dots" aria-hidden="true">
            {people.map((p, i) => <circle key={i} cx={p.x} cy={p.y} r={p.kind === 'staff' ? 0.55 : 0.4} className={p.kind} />)}
          </g>
        </svg>
        <ul className="ops-legend" aria-label="Legendă">
          <li><i className="ops-sw ops-normal" />Normal</li>
          <li><i className="ops-sw ops-near" />Aproape</li>
          <li><i className="ops-sw ops-full" />Plin</li>
          <li><i className="ops-sw ops-dot-staff" />Angajat</li>
          <li className="ops-plan">Plan provizoriu</li>
        </ul>
      </section>
      <aside className="ops-side">
        <div className="ops-evac">
          <button className="ops-danger" disabled={!selected.length || busy} onClick={() => send({ type: 'evacuate', zones: selected })}>
            Evacuare{selected.length ? ` · ${selected.length}` : ''}
          </button>
          <span className="ops-hint">{selected.length ? selected.map(id => byId.get(id)?.name ?? id).join(', ') : 'Selectează zone pe hartă'}</span>
          {selected.length > 0 && <button className="ops-ghost" onClick={() => setSelected([])}>Anulează</button>}
        </div>
        <ol className="ops-zones" aria-label="Zone">
          <li className="ops-zones-head" aria-hidden="true"><span>Zonă</span><span>Oameni</span><span>Angajați</span><span>Așteptare</span><span /></li>
          {stats.filter(s => s.kind !== 'exit').map(s => <li key={s.id} data-testid={`row-${s.id}`} className={selected.includes(s.id) ? 'ops-selected' : undefined}>
            <label className="ops-zone-label">
              <input type="checkbox" checked={selected.includes(s.id)} onChange={() => toggle(s.id)} aria-label={`Selectează ${s.name}`} />
              <i className={`ops-sw ops-${s.state ?? 'none'}`} title={s.state ? flowStateLabels[s.state] : 'Fără capacitate'} />
              <b>{s.name}</b>
            </label>
            <span data-testid="people">{number(s.people)}</span>
            <span data-testid="staff">{number(s.staff)}</span>
            <span data-testid="wait">{s.waitMin == null ? '—' : `${Math.round(s.waitMin)} min`}</span>
            <span className="ops-staff-actions">{s.staffed && <>
              <button aria-label={`${s.name} −1 angajat`} disabled={busy || s.staff === 0} onClick={() => send({ type: 'staff', zone: s.id, delta: -1 })}>−1</button>
              <button aria-label={`${s.name} +1 angajat`} disabled={busy} onClick={() => send({ type: 'staff', zone: s.id, delta: 1 })}>+1 angajat</button>
            </>}</span>
          </li>)}
        </ol>
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
