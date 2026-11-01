import { accuracyRows } from './opsZones'
import './accuracy.css'
import type { TerminalPlan } from './terminal'
import type { SimSnapshot } from '../backend/sim'

const n = (v: number | null) => v == null ? '—' : String(Math.round(v))
/**
 * D16 / D18 beat 2: the cameras' estimate next to Unity's truth (truth.report), per zone. Only for measuring, never for decisions (D0).
 * Rows with a camera estimate first. Renders nothing until Unity sends truth.report.
 */
export function AccuracyCard({ plan, sim, onZone }: { plan: TerminalPlan; sim: SimSnapshot | null; onZone?: (id: string) => void }) {
  const rows = accuracyRows(plan, sim).sort((a, b) => Number(b.camPeople != null) - Number(a.camPeople != null)).slice(0, 6)
  if (!rows.length) return null
  return <section className="ops-accuracy" aria-label="Acuratețe" data-testid="accuracy">
    <h2>Acuratețe</h2>
    <ul>{rows.map(a => <li key={a.id}>
      <button data-testid={`accuracy-${a.id}`} onClick={() => onZone?.(a.id)}>
        <span>{a.name}</span><span>{n(a.camPeople)} / {n(a.truePeople)} oameni</span><span>{n(a.camWait)} / {n(a.trueWait)} min</span>
      </button>
    </li>)}</ul>
    <small>Camere / simulare (adevărul din Unity, doar pentru măsurare)</small>
  </section>
}
