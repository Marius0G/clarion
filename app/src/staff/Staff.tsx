import { useCallback, useEffect, useState } from 'react'
import { sessionToken } from '../backend/auth'
import { personalRequest, ReportForm, ReportList } from '../reports/Reports'
import type { PersonalReport } from '../reports/types'
import '../me/me.css'

type Task = { id: string; type: string; zone?: string; from?: string; to?: string; zones?: string[]; status: string; staffState?: string }
type StaffData = { zone: string; role: string; reports: PersonalReport[]; tasks: Task[]; alerts: { id: string; priority: string; text: string }[] }
export default function Staff() {
  const [data, setData] = useState<StaffData>(), [error, setError] = useState(''), [busy, setBusy] = useState('')
  const refresh = useCallback(async () => {
    try { setData(await personalRequest<StaffData>('/api/staff')); setError('') }
    catch (e) { setError(e instanceof Error ? e.message : 'network') }
  }, [])
  useEffect(() => { const initial = setTimeout(() => void refresh(), 0); const timer = setInterval(() => void refresh(), 5000); return () => { clearTimeout(initial); clearInterval(timer) } }, [refresh])
  async function task(id: string, action: string) {
    setBusy(id)
    try { await personalRequest(`/api/staff/tasks/${encodeURIComponent(id)}/${action}`, {}); await refresh() }
    catch { setError('Acțiune netrimisă') }
    finally { setBusy('') }
  }
  if (!sessionToken() || error === '401') return <main className="me-shell"><div className="me-page"><h1>Personal</h1><a href="/join">Conectează-te cu WhatsApp</a></div></main>
  if (error === '403') return <main className="me-shell"><div className="me-page"><h1>Acces personal</h1><a href="/m">Pagina mea</a></div></main>
  return <main className="me-shell staff-shell"><div className="me-page"><header><h1>Personal</h1><p>{data?.zone}</p></header>
    {error && <p role="alert">{error.startsWith('Acțiune') ? error : 'Date indisponibile'}</p>}
    <section className="me-section"><h2>Sarcinile mele</h2>{data?.tasks.map(t => <article className="staff-task" key={t.id}>
      <b>{{ staff: 'Linie', redirect: 'Redirecționare', evacuate: 'Evacuare' }[t.type] ?? t.type}</b>
      <p>{t.zone ?? t.from ?? t.zones?.join(', ')}{t.to && ` → ${t.to}`}</p>
      <p>{t.staffState === 'done' ? 'Făcut' : t.staffState === 'confirmed' ? 'Confirmat' : 'Trimis'}</p>
      {t.staffState !== 'done' && <button disabled={busy === t.id} onClick={() => void task(t.id, t.staffState ? 'done' : 'confirm')}>{t.staffState ? 'Făcut' : 'Confirm'}</button>}
    </article>)}{data && !data.tasks.length && <p>Nicio sarcină</p>}</section>
    <section className="me-section"><h2>Alerte</h2>{data?.alerts.map(a => <p key={a.id} className={`priority-${a.priority}`}>{a.priority === 'P1' ? '■' : a.priority === 'P2' ? '▲' : '●'} {a.priority} · {a.text}</p>)}{data && !data.alerts.length && <p>Nicio alertă</p>}</section>
    <ReportForm onSent={() => void refresh()} /><ReportList reports={data?.reports ?? []} />
  </div></main>
}
