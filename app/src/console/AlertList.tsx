import { useState } from 'react'
import { alertNumbers, alertPresentation, alertSymbols, type Alert, type AlertCommand } from './alerts'

export function AlertList({ alerts, simTime, onZone, onCommand }: {
  alerts: readonly Alert[]; simTime: number | null; onZone: (id: string) => void; onCommand: (command: AlertCommand) => Promise<void>
}) {
  const [shelving, setShelving] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [duration, setDuration] = useState(600)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  async function command(c: AlertCommand) {
    setPending(true); setError('')
    try { await onCommand(c); setShelving(null); setReason('') }
    catch (e) { setError(e instanceof Error ? e.message : 'Conexiune întreruptă') }
    finally { setPending(false) }
  }
  const visible = alerts.filter(a => alertPresentation(a, simTime).visible)
  return <section aria-label="Alerte" data-testid="alerts-slot"><h2>Alerte</h2>
    {!visible.length && <p>Nicio alertă</p>}
    {visible.map(a => {
      const state = alertPresentation(a, simTime)
      return <article key={a.id} data-testid={`alert-${a.id}`}>
        <b className={`ops-alarm ${a.priority.toLowerCase()}${state.blink ? ' ops-alarm-blink' : ''}`}>{alertSymbols[a.priority]} {a.priority} · {a.text}</b>
        <p>{a.flight} {state.label}</p><p>{alertNumbers(a)}</p>
        {a.zoneId && <button onClick={() => onZone(a.zoneId!)}>{a.zoneId}</button>}
        {a.state === 'shelved' && <p>Amânată · {state.remainingSec === null ? '—' : `${Math.floor(state.remainingSec / 60)}:${String(state.remainingSec % 60).padStart(2, '0')}`} · {a.shelveReason}</p>}
        {a.state !== 'acked' && <button disabled={pending} onClick={() => command({ type: 'ack', id: a.id })}>Confirmă</button>}
        {a.state !== 'shelved' && <button disabled={pending} onClick={() => { setShelving(a.id); setReason(''); setError('') }}>Amână</button>}
        {shelving === a.id && <form className="ops-shelve" onSubmit={e => { e.preventDefault(); void command({ type: 'shelve', id: a.id, durationSec: duration, reason: reason.trim() }) }}>
          <label>Motiv<input aria-label="Motiv" required maxLength={200} value={reason} onChange={e => setReason(e.target.value)} /></label>
          <label>Durată<select aria-label="Durată" value={duration} onChange={e => setDuration(Number(e.target.value))}>{[300, 600, 1800].map(s => <option key={s} value={s}>{s / 60} min</option>)}</select></label>
          <button disabled={pending || !reason.trim()} type="submit">Aplică</button><button type="button" onClick={() => setShelving(null)}>Anulează</button>
        </form>}
      </article>
    })}
    {error && <p role="alert">{error}</p>}
  </section>
}
