import { useEffect, useState } from 'react'
import { backend } from '../backend/config'
import { fixture } from './fixture'
import { normalizePassenger, simTimeLabel, statusLabel } from './format'
import './me.css'

export default function Me() {
  const [state, setState] = useState(() => ({ data: normalizePassenger(null), demo: false, loading: true }))

  useEffect(() => {
    document.documentElement.lang = 'ro'
    let disposed = false
    let pending: AbortController | undefined
    const token = window.location.pathname.slice('/m/'.length)
    const poll = async () => {
      if (pending) return
      const controller = new AbortController()
      pending = controller
      const timeout = window.setTimeout(() => controller.abort(), 4500)
      try {
        const url = new URL('/api/me', backend.http)
        url.searchParams.set('token', decodeURIComponent(token))
        const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('Passenger data unavailable')
        const data = normalizePassenger(await response.json())
        if (!disposed) setState({ data, demo: false, loading: false })
      } catch {
        if (!disposed) setState({ data: fixture, demo: true, loading: false })
      } finally {
        window.clearTimeout(timeout)
        pending = undefined
      }
    }
    void poll()
    const interval = window.setInterval(() => void poll(), 5000)
    return () => {
      disposed = true
      window.clearInterval(interval)
      pending?.abort()
    }
  }, [])

  const { data, demo, loading } = state
  const { flight, evacuation } = data
  const alerts = [...data.alerts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)

  return <main className="me-shell">
    {evacuation.active && <section className="me-evacuation" role="alert">
      <div>
        <h2>Evacuare</h2>
        <p>Zone: {evacuation.zones.join(', ') || 'necunoscut'}</p>
        <p>Urmează indicatoarele spre cea mai apropiată ieșire</p>
      </div>
    </section>}
    <div className="me-page">
      <header className="me-arrival">
        <h1>Situația din terminal</h1>
        {(data.queues ?? []).map(queue => <p key={queue.zone}>
          {queue.label}: {queue.nowMin === null ? 'timp necunoscut acum' : `${Math.round(queue.nowMin)} min acum`},
          {' '}{queue.forecastMin === null ? 'prognoză necunoscută' : `~${Math.round(queue.forecastMin)} min la ${queue.forecastAt}`} ({queue.source}).
        </p>)}
        {!data.queues?.length && <p>Cozi acum și prognoză: necunoscut</p>}
        <p>Poarta {flight.gate} se închide la {flight.gateCloseAt}.</p>
        <p>Cu situația de acum, de la intrare la poartă {data.entranceToGateMin == null ? 'durată necunoscută' : `~${Math.round(data.entranceToGateMin)} min, inclusiv 10 min marjă`}.</p>
        <p><time>{simTimeLabel(data.simTime)}</time> · ora simulării</p>
        {loading && <small role="status">Se încarcă…</small>}
        {demo && <small className="me-demo">date demo</small>}
      </header>
      <section className="me-flight" aria-label="Zbor">
        <dl>
          <div><dt>Zbor</dt><dd>{flight.flight}</dd></div>
          <div><dt>Destinație</dt><dd>{flight.destination}</dd></div>
          <div><dt>Poartă</dt><dd className="me-number">{flight.gate}</dd></div>
          <div><dt>Închidere poartă</dt><dd className="me-number">{flight.gateCloseAt}</dd></div>
          <div><dt>Plecare</dt><dd>{flight.std}</dd></div>
          <div><dt>Status</dt><dd>{statusLabel(flight.status, flight.delayMin)}</dd></div>
        </dl>
      </section>
      <section className="me-section" aria-labelledby="me-steps">
        <h2 id="me-steps">Etape</h2>
        <ol className="me-steps">
          {data.steps.map((step, index) => <li key={`${step.zone}-${index}`}>
            <span>{step.label}</span>
            <strong>{step.waitMin === null ? 'necunoscut' : <>{Math.round(step.waitMin)} <small>min</small></>}</strong>
          </li>)}
        </ol>
        {!data.steps.length && <p className="me-muted">Timpi: necunoscut</p>}
      </section>
      {/* TODO map */}
      <section className="me-map" aria-labelledby="me-map-title">
        <h2 id="me-map-title">Hartă</h2>
        <p>Poartă <strong>{flight.gate}</strong></p>
      </section>
      <section className="me-section" aria-labelledby="me-alerts">
        <h2 id="me-alerts">Alerte</h2>
        <ul className="me-alerts">
          {alerts.map((alert, index) => <li key={`${alert.at}-${index}`}>
            <time>{alert.at}</time><p>{alert.text}</p>
          </li>)}
        </ul>
        {!alerts.length && <p className="me-muted">Nicio alertă.</p>}
      </section>
    </div>
  </main>
}
