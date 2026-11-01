import { useEffect, useRef, useState } from 'react'
import { personalRequest } from '../reports/Reports'
import { sessionToken } from '../backend/auth'

export type ChatEntry = { role: 'user' | 'clarion'; text: string; at: string; channel: 'whatsapp' | 'web'; image?: string; buttons?: { id: string; title: string }[] }
export function chatError(error: unknown, en = false) {
  return error instanceof Error && error.message === '429' ? (en ? 'Message limit · 1 min' : 'Limită mesaje · 1 min') : en ? 'Message unavailable' : 'Mesaj netrimis'
}
export function Chat({ en = false }: { en?: boolean }) {
  const [open, setOpen] = useState(false), [history, setHistory] = useState<ChatEntry[]>([])
  const [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), end = useRef<HTMLDivElement>(null)
  const sending = useRef(false), revision = useRef(0)
  useEffect(() => {
    if (!open) return
    dialog.current?.showModal()
    if (!sessionToken()) return
    let alive = true, pending = false
    const refresh = async () => {
      if (pending || sending.current) return
      pending = true
      const current = revision.current
      try { const data = await personalRequest<{ history: ChatEntry[] }>('/api/chat'); if (alive && current === revision.current) setHistory(previous => JSON.stringify(previous) === JSON.stringify(data.history) ? previous : data.history) }
      catch { if (alive) setError(en ? 'Messages unavailable' : 'Mesaje indisponibile') }
      finally { pending = false }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 5000)
    return () => { alive = false; clearInterval(timer) }
  }, [open, en])
  useEffect(() => { if (open) end.current?.scrollIntoView({ block: 'end' }) }, [history, open])
  async function send(value: string, replyId?: string) {
    if (sending.current || !value.trim()) return
    sending.current = true; revision.current++
    setBusy(true); setError('')
    try {
      const data = await personalRequest<{ history: ChatEntry[] }>('/api/chat', { text: value, ...(replyId && { replyId }) }, 90_000)
      setHistory(data.history); setText('')
      window.dispatchEvent(new Event('personal-refresh'))
    } catch (e) { setError(chatError(e, en)) }
    finally { sending.current = false; setBusy(false) }
  }
  return <section className="chat-launch"><button aria-expanded={open} onClick={() => setOpen(true)}>{en ? 'Messages' : 'Mesaje'} <span>↗</span></button>
    {open && <dialog ref={dialog} className="chat-sheet" aria-label={en ? 'Messages' : 'Mesaje'} onClose={() => setOpen(false)}>
      <header><h2>{en ? 'Messages' : 'Mesaje'}</h2><button onClick={() => dialog.current?.close()}>{en ? 'Close' : 'Închide'}</button></header>
      {!sessionToken() ? <a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a> : <>
        <div className="chat-history" role="log" aria-live="polite">{history.map((entry, i) => <article className={`chat-bubble chat-${entry.role}`} key={i}>
          <small>{entry.channel === 'web' ? 'Web' : 'WhatsApp'} · <time>{entry.at}</time></small>
          <p>{entry.text.replace(/^\[react\]/, '')}</p>
          {entry.image && <img src={entry.image} alt={en ? 'Route' : 'Traseu'} />}
          {entry.buttons && <div className="chat-chips">{entry.buttons.map(button => <button key={button.id} disabled={busy} onClick={() => void send(button.title, button.id)}>{button.title}</button>)}</div>}
        </article>)}<div ref={end} /></div>
        <form onSubmit={event => { event.preventDefault(); void send(text) }}>
          {error && <p role="alert">{error}</p>}
          <label htmlFor="chat-message">{en ? 'Message' : 'Mesaj'}</label><div className="chat-compose"><input id="chat-message" disabled={busy} value={text} maxLength={2000} onChange={e => setText(e.target.value)} autoComplete="off" /><button disabled={busy || !text.trim()}>{busy ? '…' : en ? 'Send' : 'Trimite'}</button></div>
        </form>
      </>}
    </dialog>}
  </section>
}
