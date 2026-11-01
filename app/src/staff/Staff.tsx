import { useCallback, useEffect, useState } from 'react'
import { sessionToken } from '../backend/auth'
import { personalRequest, ReportForm, ReportList } from '../reports/Reports'
import type { PersonalReport } from '../reports/types'
import '../me/me.css'
import { Chat } from '../chat/Chat'

type Task = { id: string; type: string; zone?: string; from?: string; to?: string; zones?: string[]; status: string; staffState?: string; requestedBy?: string; sentAt?: string }
type StaffAlert = { id: string; priority: string; text: string; kind?: string; zoneId?: string; numbers?: { waitMin?: number; targetMin?: number } }
type StaffData = { lang?: 'ro' | 'en'; zone: string; role: string; reports: PersonalReport[]; tasks: Task[]; alerts: StaffAlert[] }
export function staffZone(zone: string, en = false): string {
  return ({ security: en ? 'Security' : 'Securitate', Securitate: en ? 'Security' : 'Securitate' } as Record<string, string>)[zone] ?? zone
}
export function staffAlertLabel(alert: StaffAlert, zone: string, en = false): string {
  const { waitMin, targetMin } = alert.numbers ?? {}
  if (alert.kind === 'zone-target' && waitMin != null && targetMin != null) return `${staffZone(alert.zoneId ?? zone, en)} · ${Math.max(0, Math.round(waitMin - targetMin))} min ${en ? 'over target' : 'peste țintă'}`
  const legacy = /^Țintă depășită · (\d+) min$/.exec(alert.text)
  return legacy ? `${staffZone(zone, en)} · ${legacy[1]} min ${en ? 'over target' : 'peste țintă'}` : alert.text
}
export default function Staff() {
  const [data, setData] = useState<StaffData>(), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const en = data?.lang === 'en'
  const refresh = useCallback(async () => {
    try { setData(await personalRequest<StaffData>('/api/staff')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'network') }
  }, [])
  useEffect(() => { document.documentElement.lang = en ? 'en' : 'ro' }, [en])
  useEffect(() => { window.addEventListener('personal-refresh', refresh); const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 5000); return () => { window.removeEventListener('personal-refresh', refresh); clearTimeout(initial); clearInterval(timer) } }, [refresh])
  async function task(id: string, action: string) {
    setBusy(id)
    try { await personalRequest(`/api/staff/tasks/${encodeURIComponent(id)}/${action}`, {}); await refresh() }
    catch { setError(en ? 'Action unavailable' : 'Acțiune netrimisă') }
    finally { setBusy('') }
  }
  if (!sessionToken() || error === '401') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff' : 'Personal'}</h1><a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a></div></main>
  if (error === '403') return <main className="me-shell"><div className="me-page"><h1>{en ? 'Staff access' : 'Acces personal'}</h1><a href="/m">{en ? 'My page' : 'Pagina mea'}</a></div></main>
  const reports = data?.reports ?? [], eta = reports.filter(r => r.state !== 'resolved' && r.etaMin != null).map(r => r.etaMin!)
  const zone = staffZone(data?.zone ?? '—', en)
  const role = (en ? { security_supervisor: 'supervisor', hall_agent: 'hall agent', incident_commander: 'commander' } : { security_supervisor: 'supervizor', hall_agent: 'agent hol', incident_commander: 'comandant' })[data?.role ?? ''] ?? (en ? 'staff' : 'personal')
  return <main className="me-shell staff-shell"><div className="me-page"><header className="dashboard-header"><h1>{zone} · {role}</h1></header>
    {error && <p role="alert">{error.startsWith('Acțiune') || error === 'Action unavailable' ? error : en ? 'Data unavailable' : 'Date indisponibile'}</p>}
    <div className="dashboard-tiles">
      <div><span>{en ? 'Tasks' : 'Sarcini'}</span><strong>{data ? data.tasks.filter(t => t.staffState !== 'done').length : '—'}</strong></div>
      <details><summary><span>{en ? 'Alerts' : 'Alerte'}</span><strong>{data?.alerts.length ?? '—'}</strong></summary>{data?.alerts.map(a => <p key={a.id} className={`priority-${a.priority}`}>{a.priority === 'P1' ? '■' : a.priority === 'P2' ? '▲' : '●'} {staffAlertLabel(a, data.zone, en)}</p>)}{data && !data.alerts.length && <p>{en ? 'No alerts' : 'Nicio alertă'}</p>}</details>
      <details><summary><span>{en ? 'Reports' : 'Rapoarte'}</span><strong>{data ? reports.filter(r => r.state !== 'resolved').length : '—'}</strong><small>{en ? 'mine, open' : 'ale mele, deschise'}</small></summary><ReportList en={en} reports={reports} /></details>
      <details><summary><span>{en ? 'Team' : 'Echipa'}</span><strong>{eta.length ? Math.min(...eta) : '—'} <small>min</small></strong><small>{en ? 'until arrival' : 'până ajunge'}</small></summary>{reports.filter(r => r.state !== 'resolved' && r.etaMin != null).map(r => <p key={r.id}>{r.place.name} · ~{r.etaMin} min</p>)}</details>
    </div>
    <section className="me-section task-list"><h2>{en ? 'Tasks' : 'Sarcini'}</h2>{data?.tasks.map(t => <article className="staff-task" key={t.id}>
      <b>{t.type === 'staff' ? (en ? `Open a security lane` : 'Deschide o linie la securitate') : t.type === 'evacuate' ? (en ? 'Evacuate' : 'Evacuare') : t.type === 'redirect' ? `${en ? 'Redirect' : 'Redirecționează'} ${staffZone(t.from ?? '', en)} → ${staffZone(t.to ?? '', en)}` : t.type}</b>
      <p className="task-meta">{t.requestedBy ?? (en ? 'Unknown requester' : 'Solicitant necunoscut')} · {t.sentAt ?? '—'}</p>
      <p>{t.staffState === 'done' ? (en ? 'Done' : 'Gata') : t.staffState === 'confirmed' ? (en ? 'Confirmed' : 'Confirmat') : (en ? 'Sent' : 'Trimis')}</p>
      {t.staffState !== 'done' && <div className="task-actions"><button disabled={busy === t.id || t.staffState === 'confirmed'} onClick={() => void task(t.id, 'confirm')}>Confirm</button><button disabled={busy === t.id || t.staffState !== 'confirmed'} onClick={() => void task(t.id, 'done')}>{en ? 'Done' : 'Gata'}</button></div>}
    </article>)}{data && !data.tasks.length && <p>{en ? 'No tasks' : 'Nicio sarcină'}</p>}</section>
    <Chat en={en} />
    <ReportForm en={en} onSent={() => void refresh()} />
  </div></main>
}
