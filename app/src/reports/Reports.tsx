import { useEffect, useRef, useState } from 'react'
import { backend } from '../backend/config'
import { authHeaders, sessionToken } from '../backend/auth'
import type { PersonalReport } from './types'

export const reportTypes = ['security', 'medical', 'cleaning', 'lost item', 'crowd', 'other'] as const
export const stateLabel = (state: string, en = false) => (en ? { sent: 'Sent', taken: 'Taken', en_route: 'Team en route', resolved: 'Resolved' } : { sent: 'Trimis', taken: 'Preluat', en_route: 'Echipa vine', resolved: 'Rezolvat' })[state] ?? state
export async function personalRequest<T>(path: string, body?: unknown, timeout = 6000): Promise<T> {
  const response = await fetch(`${backend.http}${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: 'no-store', signal: AbortSignal.timeout(timeout) })
  if (!response.ok) throw new Error(String(response.status))
  return response.json()
}
export function ReportList({ reports, en = false }: { reports: PersonalReport[]; en?: boolean }) {
  return <section className="me-section"><h2>{en ? 'My reports' : 'Rapoartele mele'}</h2>
    {reports.length ? <ul className="me-alerts">{[...reports].reverse().map(r => <li key={r.id}>
      <b className={`priority-${r.priority}`}>{({ P1: '■', P2: '▲', P3: '●' })[r.priority]} {r.priority}</b> · {r.id} · {stateLabel(r.state, en)}{r.state === 'en_route' && r.etaMin != null && ` · ~${r.etaMin} min`}
      <p>{r.place?.name} · {r.text}</p>{r.etaMin != null && r.state !== 'resolved' && r.state !== 'en_route' && <p>ETA ~{r.etaMin} min</p>}
    </li>)}</ul> : <p>{en ? 'No reports' : 'Niciun raport'}</p>}
  </section>
}
type Point = { id: string; name: { ro: string; en: string }; aliases: string[] }
export function ReportForm({ en = false, onSent }: { en?: boolean; onSent: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false), [points, setPoints] = useState<Point[]>([])
  const [type, setType] = useState<typeof reportTypes[number]>(), [node, setNode] = useState('')
  const [search, setSearch] = useState('')
  const [text, setText] = useState(''), [photo, setPhoto] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const labels = en ? ['Security', 'Medical', 'Cleaning', 'Lost item', 'Crowd', 'Other'] : ['Securitate', 'Medical', 'Curățenie', 'Obiect pierdut', 'Aglomerație', 'Altceva']
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    if (!sessionToken()) return
    let alive = true
    fetch('/routes/index.json').then(r => { if (!r.ok) throw new Error(); return r.json() }).then(index => { if (alive && Array.isArray(index.points)) setPoints(index.points) }).catch(() => { if (alive) setError(en ? 'Places unavailable' : 'Repere indisponibile') })
    return () => { alive = false }
  }, [open, en])
  return <section className="report-action"><button onClick={() => setOpen(!open)} aria-expanded={open}>{en ? 'Report a problem' : 'Raportează o problemă'}</button>
    {open && <dialog ref={dialog} className="report-sheet" aria-label={en ? 'Report a problem' : 'Raportează o problemă'} onClose={() => setOpen(false)}><header><h2>{en ? 'Report a problem' : 'Raportează o problemă'}</h2><button onClick={() => dialog.current?.close()}>{en ? 'Close' : 'Închide'}</button></header>{!sessionToken() ? <a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a> : <form className="report-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return
      setBusy(true); setError('')
      try {
        const point = points.find(p => p.id === node)
        if (!point || !type) throw new Error()
        await personalRequest('/api/reports', { type, place: { node: point.id, name: point.name[en ? 'en' : 'ro'] }, text, ...(photo && { photo }) })
        setOpen(false); setText(''); setPhoto(''); setType(undefined); setNode(''); setSearch(''); onSent()
      } catch { setError(en ? 'Report unavailable' : 'Raport netrimis') }
      finally { setBusy(false) }
    }}>
      <fieldset><legend>{en ? 'What happened?' : 'Ce s-a întâmplat?'}</legend><div className="type-buttons">{reportTypes.map((value, i) => <button key={value} type="button" aria-pressed={type === value} onClick={() => setType(value)}>{labels[i]}</button>)}</div></fieldset>
      <fieldset><legend>{en ? 'Where?' : 'Unde?'}</legend>
        <label>{en ? 'Search landmarks' : 'Caută un reper'}<input type="search" value={search} onChange={e => setSearch(e.target.value)} /></label>
        <div className="type-buttons">{points.filter(p => p.id === node || `${p.name.ro} ${p.name.en} ${p.aliases.join(' ')}`.toLocaleLowerCase().includes(search.toLocaleLowerCase())).slice(0, 8).map(p => <button key={p.id} type="button" aria-pressed={node === p.id} onClick={() => setNode(p.id)}>{p.name[en ? 'en' : 'ro']}</button>)}</div>
      </fieldset>
      <label>{en ? 'Details' : 'Detalii'}<textarea maxLength={500} value={text} onChange={e => setText(e.target.value)} /></label>
      <label>{en ? 'Photo URL' : 'Foto URL'}<input type="url" pattern="https://.*" value={photo} onChange={e => setPhoto(e.target.value)} /></label>
      <button disabled={busy || !type || !node}>{busy ? '…' : en ? 'Send' : 'Trimite'}</button>
    </form>}{error && <p role="alert">{error}</p>}</dialog>}
  </section>
}
