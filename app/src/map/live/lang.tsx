import type { Lang } from './catalogue'

/** The page language the person picked here (EN / RO); without one, the profile language (D23). */
const KEY = 'clarion.lang'
export function langOverride(): Lang | null {
  try { const v = localStorage.getItem(KEY); return v === 'en' || v === 'ro' ? v : null } catch { return null }
}
export function LangToggle({ lang, onChange }: { lang: Lang; onChange: (l: Lang) => void }) {
  const next: Lang = lang === 'en' ? 'ro' : 'en'
  return <button type="button" className="lv-lang" lang={next} aria-label={next === 'en' ? 'English' : 'Română'}
    onClick={() => { try { localStorage.setItem(KEY, next) } catch { /* this page only */ } onChange(next) }}>{next.toUpperCase()}</button>
}
