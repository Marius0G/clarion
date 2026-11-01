import { useEffect, useState } from 'react'
import { backend } from '../backend/config'
import { authHeaders, sessionToken } from '../backend/auth'
import { ReportForm, ReportList } from '../reports/Reports'
import { normalizePassenger, simTimeLabel, statusLabel } from './format'
import './me.css'
import { pageText, pageZone, pageSource } from './texts'

export default function Me() {
  const [state, setState] = useState(() => ({ data: normalizePassenger(null), error: '', loading: true, changed: [] as string[] }))

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
        const data = normalizePassenger(await response.json())
        if (!disposed) setState(previous => ({ data, error: '', loading: false, changed: previous.loading ? [] : ['gate', 'gateCloseAt', 'status', 'delayMin'].some(key => data.flight[key as keyof typeof data.flight] !== previous.data.flight[key as keyof typeof data.flight]) ? ['gate', 'gateCloseAt', 'status', 'delayMin'].filter(key => data.flight[key as keyof typeof data.flight] !== previous.data.flight[key as keyof typeof data.flight]) : previous.changed }))
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
  const lang = data.lang ?? 'ro'
  const t = (text: string) => pageText(text, lang)
  useEffect(() => { document.documentElement.lang = lang }, [lang])
  const { flight, evacuation } = data
  const alerts = [...(data.timeline?.length ? data.timeline : data.alerts)].reverse()

  if ((!sessionToken() && window.location.pathname === '/m') || error === 'auth') return <main className="me-shell"><div className="me-page"><h1>Clarion</h1><a href="/join">{lang === 'en' ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>
  if (evacuation.active) return <main className="me-shell"><div className="me-page" role="alert"><h1>{t('Evacuare')}</h1>
    {data.routeImage && <img className="route-image" src={data.routeImage} alt={t('Evacuare')} />}
    {evacuation.route && <p>{evacuation.route.steps.join(' → ')}</p>}
    <h2>{lang === 'en' ? 'Assembly point' : 'Punct de adunare'}</h2><p>{data.assembly ?? t('necunoscut')}</p>
    {!data.routeImage && <p>{t('Urmează indicatoarele spre cea mai apropiată ieșire')}</p>}
  </div></main>
  return <main className="me-shell">
    <div className="me-page">
      <header className="me-arrival">
        <h1>{t('Situația din terminal')}</h1>
        {(data.queues ?? []).map(queue => <p key={queue.zone} data-band={waitBand(queue.nowMin)}>
          {pageZone(queue.zone, queue.label, lang)}: {queue.nowMin === null ? t('timp necunoscut acum') : `${Math.ceil(queue.nowMin)} ${t('min acum')}`},
          {' '}{queue.forecastMin === null ? t('prognoză necunoscută') : `~${Math.ceil(queue.forecastMin)} ${t('min la')} ${queue.forecastAt}`} ({pageSource(queue.source, lang)}) · {waitBand(queue.nowMin)} / {waitBand(queue.forecastMin)} min.
        </p>)}
        {!data.queues?.length && <p>{t('Cozi acum și prognoză: necunoscut')}</p>}
        <p>{t('Poarta')} {flight.gate} {t('se închide la')} {flight.gateCloseAt}.</p>
        <p>{t('Cu situația de acum, de la intrare la poartă')} {data.entranceToGateMin == null ? t('durată necunoscută') : `~${Math.round(data.entranceToGateMin)} ${t('min, inclusiv 10 min marjă')}`}.</p>
        <p><time>{pageText(simTimeLabel(data.simTime), lang)}</time> · {t('ora simulării')}</p>
        {loading && <small role="status">{t('Se încarcă…')}</small>}
        {error && <p role="alert">{lang === 'en' ? 'Data unavailable' : 'Date indisponibile'}</p>}
      </header>
      <section className="me-flight" aria-label={t('Zbor')}>
        <dl>
          <div><dt>{t('Zbor')}</dt><dd>{flight.flight}</dd></div>
          <div><dt>{t('Destinație')}</dt><dd>{flight.destination}</dd></div>
          <div><dt>{t('Poartă')}</dt><dd className={`me-number ${changed.includes('gate') ? 'flight-change' : ''}`}>{flight.gate}{changed.includes('gate') && <small> · {lang === 'en' ? 'Change' : 'Schimbare'}</small>}</dd></div>
          <div><dt>{t('Închidere poartă')}</dt><dd className={`me-number ${changed.includes('gateCloseAt') ? 'flight-change' : ''}`}>{flight.gateCloseAt}</dd></div>
          <div><dt>{t('Plecare')}</dt><dd>{flight.std}</dd></div>
          <div><dt>{t('Status')}</dt><dd className={flight.status === 'delayed' || flight.status === 'cancelled' ? 'flight-change' : ''}>{statusLabel(flight.status, flight.delayMin, lang)}</dd></div>
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
      <section className="me-map" aria-labelledby="me-map-title">
        <h2 id="me-map-title">{t('Hartă')}</h2>
        <p>{lang === 'en' ? { public: 'Before security', airside: 'After security', gate: 'At gate' }[data.stage ?? 'public'] : { public: 'Înainte de securitate', airside: 'După securitate', gate: 'La poartă' }[data.stage ?? 'public']}</p>
        {data.routeImage ? <img className="route-image" src={data.routeImage} alt={`${t('Poartă')} ${flight.gate}`} /> : <p>{lang === 'en' ? 'Route unavailable' : 'Traseu indisponibil'}</p>}
      </section>
      <section className="me-section" aria-labelledby="me-alerts">
        <h2 id="me-alerts">{lang === 'en' ? 'Timeline' : 'Cronologie'}</h2>
        <ul className="me-alerts">
          {alerts.map((alert, index) => <li key={`${alert.at}-${index}`}>
            <time>{alert.at}</time><p>{alert.text}</p>
          </li>)}
        </ul>
        {!alerts.length && <p className="me-muted">{t('Nicio alertă.')}</p>}
      </section>
      <ReportForm en={lang === 'en'} onSent={() => window.dispatchEvent(new Event('personal-refresh'))} />
      <ReportList en={lang === 'en'} reports={data.reports ?? []} />
    </div>
  </main>
}

export function waitBand(value: number | null) { return value == null ? '—' : Math.ceil(value) <= 3 ? '0–3' : Math.ceil(value) <= 10 ? '4–10' : '>10' }
