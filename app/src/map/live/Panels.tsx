import { useState, type ReactNode } from 'react'
import { categoryOf, CHIPS, floorShort, minutes, routeBetween, shortName, type Category, type Lang, type Landmark, type RouteIndex } from './catalogue'
import { ageLabel, ageMs, crowdWords, people, stateWords, trend, TREND_MARK, waitBand, waitTarget, type Flow, type Level } from './crowd'
import { People, PointGlyph } from './icons'
import { crowdOf } from './LiveMap'

const T = (lang: Lang, ro: string, en: string) => lang === 'en' ? en : ro

export function Glyph({ cat, label, size = 28 }: { cat: Category; label?: string; size?: number }) {
  return <svg className="lv-glyph" width={size} height={size} viewBox="-14 -14 28 28" aria-hidden="true"><PointGlyph cat={cat} x={0} y={0} r={12} label={label} /></svg>
}

/** Bottom search (Changi: "Where do you want to go?") with category chips. */
export function SearchBar({ lang, query, onQuery, chip, onChip, onFocus, chips = true, placeholder }: { placeholder?: string; lang: Lang; query: string; onQuery: (q: string) => void; chip: string | null; onChip: (k: string | null) => void; onFocus?: () => void; chips?: boolean }) {
  return <div className="lv-search">
    <label className="lv-q"><span className="sr">{T(lang, 'Caută', 'Search')}</span>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><circle cx="10" cy="10" r="6.5" /><path d="M15 15l5.5 5.5" /></svg>
      <input type="search" value={query} placeholder={placeholder ?? T(lang, 'Unde vrei să mergi?', 'Where do you want to go?')} onChange={e => onQuery(e.target.value)} onFocus={onFocus} enterKeyHint="search" />
      {query && <button type="button" className="clear" onClick={() => onQuery('')} aria-label={T(lang, 'Șterge', 'Clear')}>×</button>}
    </label>
    {chips && <div className="lv-chips" role="group" aria-label={T(lang, 'Categorii', 'Categories')}>
      {CHIPS.map(c => <button key={c.key} type="button" aria-pressed={chip === c.key} onClick={() => onChip(chip === c.key ? null : c.key)}>
        <Glyph cat={c.cats[0]!} size={22} label={c.key === 'gate' ? 'P' : undefined} />{c.label[lang]}
      </button>)}
    </div>}
  </div>
}

function crowdLine(flow: Flow, id: string, now: number, lang: Lang) {
  const c = crowdOf(flow, id, now)
  if (!c || c.stale || c.level === 'unknown') return null
  const band = c.queue ? waitBand(c.row.waitMin) : null
  return { level: c.level, text: band ? `${crowdWords(c.level, lang)} · ${band}` : crowdWords(c.level, lang) }
}

/** Search or category results: icon, name, floor and crowding, walking minutes from you. */
export function ResultList({ items, lang, flow, now, index, from, onPick, empty }: { items: readonly Landmark[]; lang: Lang; flow: Flow; now: number; index: RouteIndex | null; from: string | null; onPick: (id: string) => void; empty: string }) {
  if (!items.length) return <p className="lv-empty">{empty}</p>
  const walk = (id: string) => index && from ? (from === id ? 0 : index.routes[`${from}__${id}`]?.walkSec ?? null) : null
  const rows = items.map(l => ({ l, sec: walk(l.id) })).sort((a, b) => (a.sec ?? 1e9) - (b.sec ?? 1e9))
  return <ul className="lv-rows" aria-label={T(lang, 'Rezultate', 'Results')}>{rows.map(({ l, sec }) => {
    const cat = categoryOf(l.id), c = crowdLine(flow, l.id, now, lang)
    return <li key={l.id}><button type="button" onClick={() => onPick(l.id)}>
      <Glyph cat={cat} label={cat === 'gate' ? l.id.replace('U_GATE_', '') : undefined} />
      <span className="t"><b>{shortName(l, lang)}</b><small>{floorShort(l.level, lang)}{c && <> · <span className={`cr-${c.level}`}>{c.text}</span></>}</small></span>
      {sec != null && <span className="walk">{minutes(sec)} min</span>}
    </button></li>
  })}</ul>
}

/** Passenger crowding: words, 1–3 people, minutes only for queues. */
export function CrowdBadge({ level, text, lang }: { level: Level; text?: string; lang: Lang }) {
  return <span className={`lv-crowd cr-${level}`}>{level === 'unknown' ? <i className="hatch" aria-hidden="true" /> : <People n={people(level)} size={16} />}<b>{text ?? crowdWords(level, lang)}</b></span>
}

/** Staff encoding (ISA-101): grey when normal; shape, colour and number only over the target. */
export function StaffNumbers({ flow, id, now, lang, history, forecast }: { flow: Flow; id: string; now: number; lang: Lang; history?: ReadonlyMap<string, readonly { t: number; n: number }[]>; forecast?: { inMin: number; waitMin: number }[] }) {
  const c = crowdOf(flow, id, now)
  if (!c) return <p className="lv-staff unknown"><b>{stateWords('unknown', lang)}</b> · {T(lang, 'nicio cameră', 'no camera')}</p>
  const key = Object.keys(flow).find(k => flow[k] === c.row) ?? id
  const tr = trend(history?.get(key)?.map(s => s.n) ?? [])
  const target = waitTarget(id)
  const over = (m: number | null | undefined) => target !== null && m != null && m > target
  const f = (n: number) => (forecast ?? c.row.forecast ?? []).filter(p => p.inMin > 0).sort((a, b) => Math.abs(a.inMin - n) - Math.abs(b.inMin - n))[0]
  const f30 = f(30), f60 = f(60)
  const mark = (m: number | null | undefined, shape: string) => over(m) ? <i className="over" aria-label={T(lang, 'peste țintă', 'over target')}>{shape}</i> : null
  return <div className={`lv-staff s-${c.stale ? 'stale' : c.level}`}>
    <p className="now"><b>{c.stale ? stateWords('unknown', lang) : stateWords(c.level, lang)}</b>
      <span>{c.row.waiting} {T(lang, 'pers.', 'ppl')} {TREND_MARK[tr]}</span>
      {c.queue && c.row.waitMin != null && <span className={over(c.row.waitMin) ? 'hot' : ''}>{mark(c.row.waitMin, '▲')}{Math.ceil(c.row.waitMin)} min{target !== null && <small> · {T(lang, 'țintă', 'target')} {target}</small>}</span>}
      <small className="age">{ageLabel(ageMs(c.row, now), lang)}</small></p>
    {c.queue && (f30 || f60) && <p className="fc" data-testid="zone-forecast">{[[30, f30], [60, f60]].filter(([, p]) => p).map(([n, p]) => {
      const q = p as { inMin: number; waitMin: number }
      return <span key={n as number} className={over(q.waitMin) ? 'hot' : ''}>{T(lang, 'Peste', 'In')} {n as number} min: {mark(q.waitMin, '●')}~{Math.ceil(q.waitMin)} min</span>
    })}</p>}
  </div>
}

/** Tap card: title, floor, live crowding, the two actions, nearest WC and food. */
export function PointCard({ l, lang, mode, flow, now, index, hereId, routeNote, onRoute, onHere, onReport, onCrowd, onPick, onClose, history, children }: {
  l: Landmark; lang: Lang; mode: 'passenger' | 'staff'; flow: Flow; now: number; index: RouteIndex | null; hereId: string | null
  routeNote?: ReactNode; onRoute?: () => void; onHere?: () => void; onReport: () => void; onCrowd?: () => void; onPick: (id: string) => void; onClose: () => void
  history?: ReadonlyMap<string, readonly { t: number; n: number }[]>; children?: ReactNode
}) {
  const cat = categoryOf(l.id)
  const c = crowdOf(flow, l.id, now)
  const near = (['wc', 'food'] as const).map(k => l.nearest?.[k]).filter((n): n is { id: string; walkSec: number } => !!n && n.id !== l.id)
  const byId = (id: string) => index?.points.find(p => p.id === id)
  return <article className="lv-card" aria-label={shortName(l, lang)} data-testid="point-card">
    <header>
      <Glyph cat={cat} label={cat === 'gate' ? l.id.replace('U_GATE_', '') : undefined} size={36} />
      <div><h2>{shortName(l, lang)}</h2><p>{floorShort(l.level, lang)}{hereId === l.id && <> · {T(lang, 'ești aici', 'you are here')}</>}</p></div>
      <button type="button" className="x" onClick={onClose} aria-label={T(lang, 'Închide', 'Close')}>×</button>
    </header>
    {mode === 'passenger'
      ? c ? <CrowdBadge level={c.stale ? 'unknown' : c.level} lang={lang} text={!c.stale && c.level !== 'unknown' && c.queue && waitBand(c.row.waitMin) ? `${crowdWords(c.level, lang)} · ${waitBand(c.row.waitMin)}` : undefined} />
        : <CrowdBadge level="unknown" lang={lang} />
      : <StaffNumbers flow={flow} id={l.id} now={now} lang={lang} history={history} />}
    <div className="lv-actions">
      {onRoute && <button type="button" className="primary" onClick={onRoute} disabled={!hereId || hereId === l.id}>{T(lang, 'Drum până aici', 'Directions')}</button>}
      {onCrowd && <button type="button" className="primary" onClick={onCrowd}>{T(lang, 'Prea multă lume aici', 'Too many people here')}</button>}
      <button type="button" onClick={onReport}>{T(lang, 'Raportează aici', 'Report here')}</button>
    </div>
    {routeNote}
    {children}
    {onHere && hereId !== l.id && <button type="button" className="lv-link" onClick={onHere}>{T(lang, 'Sunt aici', 'I am here')}</button>}
    {near.length > 0 && <ul className="lv-near" aria-label={T(lang, 'În apropiere', 'Nearby')}>{near.map(n => {
      const p = byId(n.id)
      return p ? <li key={n.id}><button type="button" onClick={() => onPick(n.id)}><Glyph cat={categoryOf(n.id)} size={22} /><span>{shortName(p, lang)}</span><small>{minutes(n.walkSec)} min</small></button></li> : null
    })}</ul>}
  </article>
}

/** Route summary under the card: minutes, floor change, the steps as text. */
export function RouteNote({ index, from, to, lang }: { index: RouteIndex; from: string; to: string; lang: Lang }) {
  const r = routeBetween(index, from, to, lang)
  if (!r.ok) return <p className="lv-route-note none" role="status">{r.reason}</p>
  const names = r.entry.steps.map(s => s.name[lang].replace(/\s*\(.*\)\s*$/, '')).filter((n, i, a) => a.indexOf(n) === i)
  return <div className="lv-route-note" role="status"><b>≈ {minutes(r.entry.walkSec)} min {T(lang, 'pe jos', 'walk')}</b>
    <ol>{names.map((n, i) => <li key={i}>{n}</li>)}</ol></div>
}

export const REPORT_CHIPS = [
  { type: 'crowd', ro: 'Aglomerație', en: 'Crowding' }, { type: 'security', ro: 'Securitate', en: 'Security' },
  { type: 'medical', ro: 'Medical', en: 'Medical' }, { type: 'cleaning', ro: 'Curățenie', en: 'Cleaning' }, { type: 'other', ro: 'Altceva', en: 'Other' },
] as const

/** Report at a place: type chips, optional note, Trimite. The place comes from the map. */
export function ReportPanel({ lang, place, hint, onSend, onCancel }: { lang: Lang; place: Landmark | undefined; hint?: string; onSend: (type: string, text: string) => Promise<boolean>; onCancel: () => void }) {
  const [type, setType] = useState<string>(), [text, setText] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <form className="lv-report" aria-label={T(lang, 'Raportează', 'Report')} onSubmit={async e => {
    e.preventDefault()
    if (!type || !place || busy) return
    setBusy(true); setError('')
    const ok = await onSend(type, text.trim())
    setBusy(false)
    if (!ok) setError(T(lang, 'Raport netrimis', 'Report unavailable'))
  }}>
    <header><h2>{T(lang, 'Raportează', 'Report')}</h2><button type="button" className="x" onClick={onCancel} aria-label={T(lang, 'Renunță', 'Cancel')}>×</button></header>
    <p className="place">{place ? <><b>{shortName(place, lang)}</b> · {floorShort(place.level, lang)}</> : hint}</p>
    {place && hint && <p className="hint">{hint}</p>}
    <fieldset><legend>{T(lang, 'Ce se întâmplă?', 'What is happening?')}</legend>
      <div className="lv-type">{REPORT_CHIPS.map(c => <button key={c.type} type="button" aria-pressed={type === c.type} onClick={() => setType(c.type)}>{c[lang]}</button>)}</div>
    </fieldset>
    <label>{T(lang, 'Notă', 'Note')}<textarea maxLength={500} value={text} onChange={e => setText(e.target.value)} rows={2} /></label>
    {error && <p role="alert">{error}</p>}
    <button className="primary" disabled={busy || !type || !place}>{busy ? '…' : T(lang, 'Trimite', 'Send')}</button>
  </form>
}

/** Queue waits as a compact list (Frankfurt shows waits as text per checkpoint). */
export function QueueList({ rows, lang }: { rows: { key: string; label: string; min: number | null; note?: string | null; extra?: string | null }[]; lang: Lang }) {
  return <ul className="lv-queues" aria-label={T(lang, 'Cozi', 'Queues')}>{rows.map(r => <li key={r.key} data-testid={`queue-${r.key}`}>
    <span>{r.label}</span><strong>{r.min == null ? '—' : Math.ceil(r.min)} <small>min</small></strong>
    {r.note && <small className="note">{r.note}</small>}{r.extra && <small className="extra">{r.extra}</small>}
  </li>)}</ul>
}
