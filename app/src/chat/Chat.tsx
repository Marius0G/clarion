import { useEffect, useRef, useState } from 'react'
import { sessionToken } from '../backend/auth'
import { useChatChannel, type ChatChannel, type ChatEntry } from './channel'

export type { ChatEntry } from './channel'
export function chatError(error: unknown, en = false) {
  const code = error instanceof Error ? error.message : String(error)
  return code === '429' ? (en ? 'Message limit · 1 min' : 'Limită mesaje · 1 min')
    : code === 'history' ? (en ? 'Messages unavailable' : 'Mesaje indisponibile') : en ? 'Message unavailable' : 'Mesaj netrimis'
}

/** The conversation: WhatsApp and web in one list, each bubble marked with its channel. */
export function ChatView({ channel, en = false, id = 'chat-message' }: { channel: ChatChannel; en?: boolean; id?: string }) {
  const [text, setText] = useState('')
  const end = useRef<HTMLDivElement>(null)
  const { entries, typing, busy, error } = channel
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [entries.length, typing])
  const send = async (value: string, replyId?: string) => { if (await channel.send(value, replyId)) setText('') }
  if (!sessionToken()) return <a href="/join">{en ? 'Connect with WhatsApp' : 'Conectează-te cu WhatsApp'}</a>
  return <>
    <div className="chat-history" role="log" aria-live="polite">
      {entries.map((entry: ChatEntry, i) => <article className={`chat-bubble chat-${entry.role}`} key={entry.id ?? i}>
        <small><span className={`chat-ch ch-${entry.channel}`}>{entry.channel === 'web' ? 'Web' : 'WhatsApp'}</span> <time>{entry.at}</time></small>
        <p>{entry.text.replace(/^\[react\]/, '')}</p>
        {entry.image && <img src={entry.image} alt={en ? 'Route' : 'Traseu'} />}
        {entry.buttons && <div className="chat-chips">{entry.buttons.map(button => <button key={button.id} disabled={busy} onClick={() => void send(button.title, button.id)}>{button.title}</button>)}</div>}
      </article>)}
      {typing && <p className="chat-typing" role="status">{en ? 'Clarion is typing…' : 'Clarion scrie…'}</p>}
      <div ref={end} />
    </div>
    <form onSubmit={event => { event.preventDefault(); void send(text) }}>
      {error && <p role="alert">{chatError(new Error(error), en)}</p>}
      <label htmlFor={id}>{en ? 'Message' : 'Mesaj'}</label>
      <div className="chat-compose"><input id={id} disabled={busy} value={text} maxLength={2000} onChange={e => { setText(e.target.value); if (error) channel.clearError() }} autoComplete="off" />
        <button disabled={busy || !text.trim()}>{busy ? '…' : en ? 'Send' : 'Trimite'}</button></div>
    </form>
  </>
}

/** Phone: a button that opens the conversation full screen. Pass the page's `channel` to share its socket. */
export function Chat({ en = false, channel, onOpen }: { en?: boolean; channel?: ChatChannel; onOpen?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false)
  const own = useChatChannel({ active: !channel && open, visible: open })
  const ch = channel ?? own
  const dialog = useRef<HTMLDialogElement>(null)
  useEffect(() => { if (open) dialog.current?.showModal(); onOpen?.(open) }, [open, onOpen])
  return <section className="chat-launch"><button aria-expanded={open} onClick={() => setOpen(true)}>{en ? 'Messages' : 'Mesaje'} <span>↗</span></button>
    {open && <dialog ref={dialog} className="chat-sheet" aria-label={en ? 'Messages' : 'Mesaje'} onClose={() => setOpen(false)}>
      <header><h2>{en ? 'Messages' : 'Mesaje'}</h2><button onClick={() => dialog.current?.close()}>{en ? 'Close' : 'Închide'}</button></header>
      <ChatView channel={ch} en={en} />
    </dialog>}
  </section>
}
