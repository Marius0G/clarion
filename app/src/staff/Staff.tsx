import { useCallback, useEffect, useState } from 'react'
import { sessionToken } from '../backend/auth'
import { personalRequest, ReportForm, ReportList } from '../reports/Reports'
import type { PersonalReport } from '../reports/types'
import '../me/me.css'
import { Chat } from '../chat/Chat'

type Task = { id: string; type: string; zone?: string; from?: string; to?: string; zones?: string[]; status: string; staffState?: string }
type StaffData = { zone: string; role: string; reports: PersonalReport[]; tasks: Task[]; alerts: { id: string; priority: string; text: string }[] }
export default function Staff() {
  const [data, setData] = useState<StaffData>(), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const refresh = useCallback(async () => {
    try { setData(await personalRequest<StaffData>('/api/staff')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'network') }
  }, [])
  useEffect(() => { window.addEventListener('personal-refresh', refresh); const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 5000); return () => { window.removeEventListener('personal-refresh', refresh); clearTimeout(initial); clearInterval(timer) } }, [refresh])
  async function task(id: string, action: string) {
    setBusy(id)
    try { await personalRequest(`/api/staff/tasks/${encodeURIComponent(id)}/${action}`, {}); await refresh() }
    catch { setError('Acțiune netrimisă') }
    finally { setBusy('') }
  }
  if (!sessionToken() || error === '401') return <main className="me-shell"><div className="me-page"><h1>Personal</h1><a href="/join">Conectează-te cu WhatsApp</a></div></main>
  if (error === '403') return <main className="me-shell"><div className="me-page"><h1>Acces personal</h1><a href="/m">Pagina mea</a></div></main>
  const reports = data?.reports ?? [], eta = reports.filter(r => r.state !== 'resolved' && r.etaMin != null).map(r => r.etaMin!)
  return <main className="me-shell staff-shell"><div className="me-page"><header className="dashboard-header"><h1>{{ security_supervisor: 'Supervizor', hall_agent: 'Agent hol', incident_commander: 'Comandant' }[data?.role ?? ''] ?? 'Personal'}</h1><p>{data?.zone}</p></header>
    {error && <p role="alert">{error.startsWith('Acțiune') ? error : 'Date indisponibile'}</p>}
    <div className="dashboard-tiles">
      <div><span>Sarcini</span><strong>{data ? data.tasks.filter(t => t.staffState !== 'done').length : '—'}</strong></div>
      <details><summary><span>Alerte zonă</span><strong>{data?.alerts.length ?? '—'}</strong></summary>{data?.alerts.map(a => <p key={a.id} className={`priority-${a.priority}`}>{a.priority === 'P1' ? '■' : a.priority === 'P2' ? '▲' : '●'} {a.priority} · {a.text}</p>)}{data && !data.alerts.length && <p>Nicio alertă</p>}</details>
      <details><summary><span>Raportări</span><strong>{data ? reports.filter(r => r.state !== 'resolved').length : '—'}</strong></summary><ReportList reports={reports} /></details>
      <details><summary><span>ETA echipă</span><strong>{eta.length ? Math.min(...eta) : '—'} <small>min</small></strong></summary>{reports.filter(r => r.state !== 'resolved' && r.etaMin != null).map(r => <p key={r.id}>{r.id} · ETA ~{r.etaMin} min</p>)}</details>
    </div>
    <section className="me-section task-list"><h2>Sarcini</h2>{data?.tasks.map(t => <details className="staff-task" key={t.id}><summary><b>{{ staff: 'Linie', redirect: 'Redirecționare', evacuate: 'Evacuare' }[t.type] ?? t.type}</b> · {t.zone ?? t.from ?? t.zones?.join(', ')}{t.to && ` → ${t.to}`}</summary>
      <p>{t.staffState === 'done' ? 'Făcut' : t.staffState === 'confirmed' ? 'Confirmat' : 'Trimis'}</p>
      {t.staffState !== 'done' && <button disabled={busy === t.id} onClick={() => void task(t.id, t.staffState ? 'done' : 'confirm')}>{t.staffState ? 'Făcut' : 'Confirm'}</button>}
    </details>)}{data && !data.tasks.length && <p>Nicio sarcină</p>}</section>
    <Chat />
    <ReportForm onSent={() => void refresh()} />
  </div></main>
}
