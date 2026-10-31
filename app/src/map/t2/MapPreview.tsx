import { useState } from 'react'
import { levelNames, levels, type Level } from './data'
import { MapLegend, TerminalMap } from './TerminalMap'

/** /harta: the detailed T2 map on its own, for checking the drawing against Marius's package. */
export default function MapPreview() {
  const [level, setLevel] = useState<Level>('G')
  const [cameras, setCameras] = useState(false)
  const [base, setBase] = useState(false)
  const [zone, setZone] = useState<string | null>(null)
  return <div style={{ minHeight: '100vh', background: '#ffffff', color: '#111827', padding: 16, font: '14px system-ui' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      <b style={{ marginRight: 8 }}>Clarion · T2</b>
      {levels.map(l => <button key={l} onClick={() => setLevel(l)} aria-pressed={l === level}
        style={{ padding: '6px 12px', borderRadius: 8, border: '1px solid #e5e7eb', background: l === level ? '#111827' : '#fff', color: l === level ? '#fff' : '#111827', cursor: 'pointer' }}>{levelNames[l].ro}</button>)}
      <label style={{ marginLeft: 12 }}><input type="checkbox" checked={base} onChange={e => setBase(e.target.checked)} /> Randare Unity</label>
      <label><input type="checkbox" checked={cameras} onChange={e => setCameras(e.target.checked)} /> Camere</label>
      {zone && <span style={{ marginLeft: 'auto', opacity: .8 }}>{zone}</span>}
    </div>
    <TerminalMap level={level} cameras={cameras} base={base} selected={zone} onZone={setZone} />
    <MapLegend />
  </div>
}
