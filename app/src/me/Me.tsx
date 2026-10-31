import { useEffect, useState } from 'react'
import { backend } from '../backend/config'
import { fixture } from './fixture'
import { normalizePassenger, simTimeLabel, statusLabel } from './format'
import './me.css'
import { pageText, pageZone, pageSource } from './texts'

export default function Me() {
  const [state, setState] = useState(() => ({ data: normalizePassenger(null), demo: false, loading: true }))

  useEffect(() => {
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
        if (!disposed) setState(previous => ({ data: { ...fixture, lang: previous.data.lang ?? 'ro' }, demo: true, loading: false }))
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
  const lang = data.lang ?? 'ro'
  const t = (text: string) => pageText(text, lang)
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  const { flight, evacuation } = data
  const alerts = [...data.alerts].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 5)

  return <main className="me-shell">
    {evacuation.active && <section className="me-evacuation" role="alert">
      <div>
        <h2>{t('Evacuare')}</h2>
        <p>{t('Zone:')} {evacuation.zones.join(', ') || t('necunoscut')}</p>
        <p>{t('Urmează indicatoarele spre cea mai apropiată ieșire')}</p>
      </div>
    </section>}
    <div className="me-page">
      <header className="me-arrival">
        <h1>{t('Situația din terminal')}</h1>
        {(data.queues ?? []).map(queue => <p key={queue.zone}>
          {pageZone(queue.zone, queue.label, lang)}: {queue.nowMin === null ? t('timp necunoscut acum') : `${Math.round(queue.nowMin)} ${t('min acum')}`},
          {' '}{queue.forecastMin === null ? t('prognoză necunoscută') : `~${Math.round(queue.forecastMin)} ${t('min la')} ${queue.forecastAt}`} ({pageSource(queue.source, lang)}).
        </p>)}
        {!data.queues?.length && <p>{t('Cozi acum și prognoză: necunoscut')}</p>}
        <p>{t('Poarta')} {flight.gate} {t('se închide la')} {flight.gateCloseAt}.</p>
        <p>{t('Cu situația de acum, de la intrare la poartă')} {data.entranceToGateMin == null ? t('durată necunoscută') : `~${Math.round(data.entranceToGateMin)} ${t('min, inclusiv 10 min marjă')}`}.</p>
        <p><time>{pageText(simTimeLabel(data.simTime), lang)}</time> · {t('ora simulării')}</p>
        {loading && <small role="status">{t('Se încarcă…')}</small>}
        {demo && <small className="me-demo">{t('date demo')}</small>}
      </header>
      <section className="me-flight" aria-label={t('Zbor')}>
        <dl>
          <div><dt>{t('Zbor')}</dt><dd>{flight.flight}</dd></div>
          <div><dt>{t('Destinație')}</dt><dd>{flight.destination}</dd></div>
          <div><dt>{t('Poartă')}</dt><dd className="me-number">{flight.gate}</dd></div>
          <div><dt>{t('Închidere poartă')}</dt><dd className="me-number">{flight.gateCloseAt}</dd></div>
          <div><dt>{t('Plecare')}</dt><dd>{flight.std}</dd></div>
          <div><dt>{t('Status')}</dt><dd>{statusLabel(flight.status, flight.delayMin, lang)}</dd></div>
        </dl>
      </section>
      <section className="me-section" aria-labelledby="me-steps">
        <h2 id="me-steps">{t('Etape')}</h2>
        <ol className="me-steps">
          {data.steps.map((step, index) => <li key={`${step.zone}-${index}`}>
            <span>{pageZone(step.zone, step.label, lang)}</span>
            <strong>{step.waitMin === null ? t('necunoscut') : <>{Math.round(step.waitMin)} <small>min</small></>}</strong>
          </li>)}
        </ol>
        {!data.steps.length && <p className="me-muted">{t('Timpi: necunoscut')}</p>}
      </section>
      {/* TODO map */}
      <section className="me-map" aria-labelledby="me-map-title">
        <h2 id="me-map-title">{t('Hartă')}</h2>
        <p>{t('Poartă')} <strong>{flight.gate}</strong></p>
      </section>
      <section className="me-section" aria-labelledby="me-alerts">
        <h2 id="me-alerts">{t('Alerte')}</h2>
        <ul className="me-alerts">
          {alerts.map((alert, index) => <li key={`${alert.at}-${index}`}>
            <time>{alert.at}</time><p>{alert.text}</p>
          </li>)}
        </ul>
        {!alerts.length && <p className="me-muted">{t('Nicio alertă.')}</p>}
      </section>
    </div>
  </main>
}
