import { useCallback, useEffect, useRef, useState } from 'react'
import { backend } from '../backend/config'
import { sessionToken } from '../backend/auth'
import { personalRequest } from '../reports/Reports'

/**
 * Web chat, live with WhatsApp (docs/contract/chat-ws.md): a ticket from `POST /api/chat/ticket`,
 * then `/ws?client=person&ticket=…`. The server pushes `history`, every new `chat` entry from any
 * channel, `report`, `me` and `typing`. While the socket is down the page sends with `POST /api/chat`
 * and polls `GET /api/chat`, and keeps reconnecting with backoff (a new ticket each time).
 */
export type ChatEntry = {
  id?: string; role: 'user' | 'clarion'; text: string; at: string; timestamp?: string | number
  channel: 'whatsapp' | 'web'; image?: string; buttons?: { id: string; title: string }[]
}
export type ServerMessage =
  | { type: 'history'; entries: ChatEntry[] }
  | { type: 'chat'; entry: ChatEntry }
  | { type: 'report'; report: unknown }
  | { type: 'me' }
  | { type: 'typing'; on: boolean }
  | { type: 'error'; error?: string; status?: number }

export const entryKey = (e: ChatEntry) => e.id ?? `${e.at}|${e.role}|${e.channel}|${e.text}`
/** Adds entries once, by id (or content when an old server sends none), keeping order. */
export function mergeEntries(list: readonly ChatEntry[], incoming: readonly ChatEntry[]): ChatEntry[] {
  const seen = new Set(list.map(entryKey))
  const out = [...list]
  for (const e of incoming) { const k = entryKey(e); if (!seen.has(k)) { seen.add(k); out.push(e) } }
  return out
}
/** Reconnect delay: 1, 2, 4 … 30 s, with a little jitter. */
export const backoff = (attempt: number, jitter = Math.random()) => Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) * (0.85 + 0.3 * jitter)

export function personSocketUrl(ticket: string, base = backend.ws) {
  const url = new URL(base)
  url.pathname = '/ws'
  url.search = ''
  url.searchParams.set('client', 'person')
  url.searchParams.set('ticket', ticket)
  return url.href
}

export interface ChatChannel {
  entries: ChatEntry[]; typing: boolean; live: boolean; busy: boolean; error: string
  send: (text: string, replyId?: string) => Promise<boolean>
  clearError: () => void
}

/** `active`: open the socket; `visible`: the conversation is on screen (polling fallback only then). */
export function useChatChannel({ active = true, visible = false }: { active?: boolean; visible?: boolean } = {}): ChatChannel {
  const [entries, setEntries] = useState<ChatEntry[]>([])
  const [typing, setTyping] = useState(false), [live, setLive] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const socket = useRef<WebSocket | null>(null)
  const sending = useRef(false)

  useEffect(() => {
    if (!active || !sessionToken() || typeof WebSocket === 'undefined') return
    let closed = false, attempt = 0, timer = 0
    const connect = async () => {
      if (closed) return
      try {
        const { ticket } = await personalRequest<{ ticket: string; expiresIn?: number }>('/api/chat/ticket', {}, 6000)
        if (closed) return
        const ws = new WebSocket(personSocketUrl(ticket))
        socket.current = ws
        ws.onopen = () => { attempt = 0; setLive(true) }
        ws.onmessage = event => {
          let msg: ServerMessage
          try { msg = JSON.parse(String(event.data)) } catch { return }
          if (msg.type === 'history' && Array.isArray(msg.entries)) setEntries(prev => mergeEntries(prev.filter(e => e.id), msg.entries))
          else if (msg.type === 'chat' && msg.entry) { setEntries(prev => mergeEntries(prev, [msg.entry])); if (msg.entry.role === 'clarion') setTyping(false) }
          else if (msg.type === 'typing') setTyping(!!msg.on)
          else if (msg.type === 'me') window.dispatchEvent(new Event('personal-refresh'))
          else if (msg.type === 'report') { window.dispatchEvent(new CustomEvent('personal-report', { detail: msg.report })); window.dispatchEvent(new Event('personal-refresh')) }
          else if (msg.type === 'error') setError(msg.status === 429 || msg.error === '429' ? '429' : 'chat')
        }
        ws.onclose = () => {
          if (socket.current === ws) socket.current = null
          setLive(false); setTyping(false)
          if (!closed) timer = window.setTimeout(() => void connect(), backoff(attempt++))
        }
      } catch {
        if (!closed) timer = window.setTimeout(() => void connect(), backoff(attempt++))
      }
    }
    void connect()
    return () => { closed = true; clearTimeout(timer); socket.current?.close(1000); socket.current = null; setLive(false) }
  }, [active])

  // Fallback: poll the history while the conversation is visible and the socket is down.
  useEffect(() => {
    if (!active || !visible || live || !sessionToken()) return
    let alive = true, pending = false
    const refresh = async () => {
      if (pending || sending.current) return
      pending = true
      try { const data = await personalRequest<{ history: ChatEntry[] }>('/api/chat'); if (alive) setEntries(prev => { const next = mergeEntries(prev, data.history); return next.length === prev.length ? prev : next }) }
      catch { if (alive) setError('history') }
      finally { pending = false }
    }
    void refresh()
    const t = setInterval(() => void refresh(), 5000)
    return () => { alive = false; clearInterval(t) }
  }, [active, visible, live])

  const send = useCallback(async (text: string, replyId?: string) => {
    if (sending.current || !text.trim()) return false
    setError('')
    const ws = socket.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'chat', text: text.trim(), ...(replyId && { replyId }) }))
      setTyping(true)
      return true
    }
    sending.current = true; setBusy(true)
    try {
      const data = await personalRequest<{ history: ChatEntry[] }>('/api/chat', { text, ...(replyId && { replyId }) }, 90_000)
      setEntries(prev => mergeEntries(prev, data.history))
      window.dispatchEvent(new Event('personal-refresh'))
      return true
    } catch (e) { setError(e instanceof Error && e.message === '429' ? '429' : 'chat'); return false }
    finally { sending.current = false; setBusy(false) }
  }, [])
  return { entries, typing, live, busy, error, send, clearError: () => setError('') }
}
