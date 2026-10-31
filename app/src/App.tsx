import { useEffect } from 'react'
import { connectGround, useGround } from './state/ground'
import { groundLabel } from './ground/machine'
import { useSim } from './state/sim'
import { TopBar } from './components/TopBar'
import { ScenarioRail } from './components/ScenarioRail'
import { RightPanel } from './components/RightPanel'
import { LayerPanel } from './components/LayerPanel'
import { MapView } from './map/MapView'

export default function App() {
  useEffect(() => connectGround(), [])
  const ground = useGround(s => s.state)
  const clearAt = useSim(s => s.corridorClearAt)
  return (
    <div className="app">
      <TopBar />
      <main className="main">
        <ScenarioRail />
        <section className="center">
          <MapView />
          <LayerPanel />
          <div className="ground-legend" data-testid="ground-status"><b>SIM · {groundLabel(ground)}</b>
            {ground === 'emergency_corridor' && <span>{clearAt === null ? 'Corridor clearing · 25 m buffer' : `✓ Corridor clear · T+${clearAt.toFixed(0)}s`}</span>}
            <small>● Taxi · <i>● Ride-hail</i> · <em>● Bus</em> · est. positions</small>
          </div>
        </section>
        <RightPanel />
      </main>
    </div>
  )
}
