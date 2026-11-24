import { useState } from 'react'
import { levelNames, zoneById, type Level } from './data'
import { placeName } from './labels'
import { MapLegend, TerminalMap } from './TerminalMap'

/** /harta: the T2 map on its own, for checking the drawing against Marius's package. */
export default function MapPreview() {
  const [level, setLevel] = useState<Level>('G')
  const [cameras, setCameras] = useState(false)
  const [zone, setZone] = useState<string | null>(null)
  const pick = (id: string) => { setZone(id); const z = zoneById.get(id); if (z && z.level !== 'X') setLevel(z.level) }
  const btn = (on: boolean) => ({ height: 36, padding: '0 14px', borderRadius: 2, border: '1px solid #6e6e6e', background: on ? '#161616' : '#e4e4e4', color: on ? '#fff' : '#161616', font: '600 15px/1 inherit', cursor: 'pointer' })
  return <div style={{ minHeight: '100vh', background: '#d4d4d4', color: '#161616', padding: 16, font: "500 15px 'IBM Plex Sans', system-ui", fontVariantNumeric: 'tabular-nums' }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
      <b style={{ marginRight: 8 }}>Clarion · T2</b>
      {(['G', 'U'] as const).map(l => <button key={l} onClick={() => setLevel(l)} aria-pressed={l === level} style={btn(l === level)}>{levelNames[l].ro}</button>)}
      <label style={{ marginLeft: 12 }}><input type="checkbox" checked={cameras} onChange={e => setCameras(e.target.checked)} /> Camere</label>
      {zone && <span style={{ marginLeft: 'auto' }}>{zone}</span>}
    </div>
    <TerminalMap level={level} cameras={cameras} selected={zone} onZone={pick} onLevel={setLevel}
      describe={id => { const z = zoneById.get(id); return z ? <div><b>{placeName(z)}</b><div>{id}</div></div> : null }} />
    <MapLegend />
  </div>
}
