import { useEffect, useState } from 'react'
import { backend } from '../backend/config'
import { authHeaders, sessionToken } from '../backend/auth'
import { ReportForm, ReportList } from '../reports/Reports'
import { normalizePassenger, statusLabel } from './format'
import './me.css'
import { Chat } from '../chat/Chat'
import { pageText } from './texts'

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
  const securityQueue = data.queues?.find(q => /security/i.test(q.zone))
  const security = securityQueue?.nowMin ?? null
  const checkin = data.queues?.find(q => /check_in|CHECKIN/.test(q.zone))?.nowMin ?? null
  const walk = data.steps.find(s => s.zone === 'walk')?.waitMin ?? null
  const reports = data.reports ?? []

  if ((!sessionToken() && window.location.pathname === '/m') || error === 'auth') return <main className="me-shell"><div className="me-page"><h1>Clarion</h1><a href="/join">{lang === 'en' ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>
  if (evacuation.active) return <main className="me-shell"><div className="me-page" role="alert"><h1>{t('Evacuare')}</h1>
    {data.routeImage && <img className="route-image" src={data.routeImage} alt={t('Evacuare')} />}
    {evacuation.route && <p>{evacuation.route.steps.join(' → ')}</p>}
    <h2>{lang === 'en' ? 'Assembly point' : 'Punct de adunare'}</h2><p>{data.assembly ?? t('necunoscut')}</p>
    {!data.routeImage && <p>{t('Urmează indicatoarele spre cea mai apropiată ieșire')}</p>}
  </div></main>
  return <main className="me-shell">
    <div className="me-page">
      <header className="dashboard-header me-flight">
        <h1>{flight.flight} · {flight.destination}</h1>
        <p><span className={changed.includes('gate') ? 'flight-change' : ''}>{t('Poarta')} {flight.gate}{changed.includes('gate') && <small> · {lang === 'en' ? 'Change' : 'Schimbare'}</small>}</span> · <span className={changed.includes('gateCloseAt') ? 'flight-change' : ''}>{t('se închide la')} {flight.gateCloseAt}</span></p>
        {loading && <small role="status">{t('Se încarcă…')}</small>}
        {error && <p role="alert">{lang === 'en' ? 'Data unavailable' : 'Date indisponibile'}</p>}
      </header>
      <div className="dashboard-tiles">
        <div><span>Check-in</span><strong>{checkin == null ? '—' : Math.ceil(checkin)} <small>min</small></strong><small>{lang === 'en' ? 'queue now' : 'coadă acum'}</small>{checkin != null && <small className="queue-band">{waitBand(checkin)} min</small>}</div>
        <div><span>{lang === 'en' ? 'Security' : 'Securitate'}</span><strong>{security == null ? '—' : Math.ceil(security)} <small>min</small></strong><small>{lang === 'en' ? 'queue now' : 'coadă acum'}</small>{security != null && <small className="queue-band">{waitBand(security)} min</small>}
          {securityQueue?.forecastMin != null && security != null && securityQueue.forecastMin !== security && <small className="queue-forecast">~{Math.ceil(securityQueue.forecastMin)} {t('min la')} {securityQueue.forecastAt}</small>}</div>
        <div><span>{lang === 'en' ? 'Until gate' : 'Până la poartă'}</span><strong>{walk == null ? '—' : Math.ceil(walk)} <small>min</small></strong><small>{lang === 'en' ? 'walk' : 'de mers'}</small></div>
        <details><summary><span>{lang === 'en' ? 'Reports' : 'Rapoarte'}</span><strong>{reports.filter(r => r.state !== 'resolved').length}</strong><small>active</small></summary><ReportList en={lang === 'en'} reports={reports} /></details>
      </div>
      <section className="me-map" aria-label={lang === 'en' ? 'Your route' : 'Drumul tău'}>
        <h2>{lang === 'en' ? 'Your route' : 'Drumul tău'}</h2>
        {data.routeImage ? <img className="route-image" src={data.routeImage} alt={`${t('Poartă')} ${flight.gate}`} /> : <p>{lang === 'en' ? 'Route unavailable' : 'Traseu indisponibil'}</p>}
        <p>{lang === 'en' ? 'To gate' : 'Spre poarta'} {flight.gate} · {walk == null ? '—' : `~${Math.ceil(walk)} min`}</p>
      </section>
      <Chat en={lang === 'en'} />
      <details className="dashboard-details"><summary>{t('Zbor')}</summary><p>{flight.destination} · {t('Plecare')} {flight.std} · {statusLabel(flight.status, flight.delayMin, lang)}</p></details>
      <ReportForm en={lang === 'en'} onSent={() => window.dispatchEvent(new Event('personal-refresh'))} />
    </div>
  </main>

}

export function waitBand(value: number | null) { return value == null ? '—' : Math.ceil(value) <= 3 ? '0–3' : Math.ceil(value) <= 10 ? '4–10' : '>10' }
