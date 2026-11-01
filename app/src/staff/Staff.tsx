import { useCallback, useEffect, useState } from 'react'
import { sessionToken } from '../backend/auth'
import { personalRequest, ReportForm, ReportList } from '../reports/Reports'
import type { PersonalReport } from '../reports/types'
import '../me/me.css'
import { Chat } from '../chat/Chat'

type StaffAlert = { id: string; priority: string; text: string; kind?: string; zoneId?: string; numbers?: { waitMin?: number; targetMin?: number } }
type StaffData = { lang?: 'ro' | 'en'; zone: string; role: string; reports: PersonalReport[]; situation?: { waitMin: number | null; people: number | null; forecast: { inMin: number; waitMin: number }[]; state: 'normal' | 'busy' | 'full' | 'unknown' }; alerts: StaffAlert[] }
export function staffZone(zone: string, en = false): string {
  return ({ security: en ? 'Security' : 'Securitate', U_SECURITY_QUEUE: en ? 'Security' : 'Securitate', Securitate: en ? 'Security' : 'Securitate' } as Record<string, string>)[zone] ?? zone
}
export function staffAlertLabel(alert: StaffAlert, zone: string, en = false): string {
  const { waitMin, targetMin } = alert.numbers ?? {}
  if (alert.kind === 'zone-target' && waitMin != null && targetMin != null) return `${staffZone(alert.zoneId ?? zone, en)} · ${Math.max(0, Math.round(waitMin - targetMin))} min ${en ? 'over target' : 'peste țintă'}`
  const legacy = /^Țintă depășită · (\d+) min$/.exec(alert.text)
  return legacy ? `${staffZone(zone, en)} · ${legacy[1]} min ${en ? 'over target' : 'peste țintă'}` : alert.text
}
export default function Staff() {
  const [data, setData] = useState<StaffData>(), [error, setError] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false)
  const en = data?.lang === 'en'
  const refresh = useCallback(async () => {
    try { setData(await personalRequest<StaffData>('/api/staff')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'network') }
  }, [])
  useEffect(() => { document.documentElement.lang = en ? 'en' : 'ro' }, [en])
  useEffect(() => { window.addEventListener('personal-refresh', refresh); const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 5000); return () => { window.removeEventListener('personal-refresh', refresh); clearTimeout(initial); clearInterval(timer) } }, [refresh])
  async function crowd() {
    if (!data || busy) return
    setBusy(true); setSent(false)
    try {
      await personalRequest('/api/reports', { type: 'crowd', place: { node: data.zone, name: staffZone(data.zone, en) }, text: en ? 'Too many people here' : 'Prea multă lume aici' })
      setSent(true); await refresh()
    } catch { setError(en ? 'Report unavailable' : 'Raport netrimis') }
    finally { setBusy(false) }
  }
  if (!sessionToken() || error === '401') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff' : 'Personal'}</h1><a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>
  if (error === '403') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff access' : 'Acces personal'}</h1><a href="/m">{en ? 'My page' : 'Pagina mea'}</a></div></main>
  const reports = data?.reports ?? [], situation = data?.situation
  const stateLabel = (en ? { normal: 'Normal', busy: 'Busy', full: 'Full', unknown: 'Unknown' } : { normal: 'Normal', busy: 'Ocupat', full: 'Plin', unknown: 'Necunoscut' })[situation?.state ?? 'unknown']
  const zone = staffZone(data?.zone ?? '—', en)
  const role = (en ? { security_supervisor: 'supervisor', hall_agent: 'hall agent', incident_commander: 'commander' } : { security_supervisor: 'supervizor', hall_agent: 'agent hol', incident_commander: 'comandant' })[data?.role ?? ''] ?? (en ? 'staff' : 'personal')
  return <main className="me-shell staff-shell"><div className="me-page"><header className="dashboard-header"><h1>{zone} · {role}</h1></header>
    {error && <p role="alert">{error === 'Raport netrimis' || error === 'Report unavailable' ? error : en ? 'Data unavailable' : 'Date indisponibile'}</p>}
    <div className="dashboard-tiles">
      <div><span>{en ? 'Queue' : 'Coadă'}</span><strong>{situation?.waitMin == null ? '—' : Math.ceil(situation.waitMin)} <small>min</small></strong><small>{stateLabel}</small>{situation?.forecast.map(p => <small key={p.inMin}>~{Math.ceil(p.waitMin)} min · +{p.inMin} min</small>)}</div>
      <div><span>{en ? 'People' : 'Oameni'}</span><strong>{situation?.people ?? '—'}</strong></div>
      <details><summary><span>{en ? 'Alerts' : 'Alerte'}</span><strong>{data?.alerts.length ?? '—'}</strong></summary>{data?.alerts.map(a => <p key={a.id} className={`priority-${a.priority}`}>{a.priority === 'P1' ? '■' : a.priority === 'P2' ? '▲' : '●'} {staffAlertLabel(a, data.zone, en)}</p>)}{data && !data.alerts.length && <p>{en ? 'No alerts' : 'Nicio alertă'}</p>}</details>
      <details><summary><span>{en ? 'Reports' : 'Rapoarte'}</span><strong>{data ? reports.filter(r => r.state !== 'resolved').length : '—'}</strong><small>{en ? 'mine, open' : 'ale mele, deschise'}</small></summary><ReportList en={en} reports={reports} /></details>
    </div>
    <button className="crowd-action" disabled={!data || busy} onClick={() => void crowd()}>{en ? 'Too many people here' : 'Prea multă lume aici'}</button>
    {sent && <p role="status">{en ? 'Passed on. Dispatch decides.' : 'Am transmis. Dispeceratul decide.'}</p>}
    <Chat en={en} />
    <ReportForm en={en} onSent={() => void refresh()} />
  </div></main>
}
