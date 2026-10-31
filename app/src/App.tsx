import { TopBar } from './components/TopBar'
import { ScenarioRail } from './components/ScenarioRail'
import { RightPanel } from './components/RightPanel'
import { LayerPanel } from './components/LayerPanel'
import { MapView } from './map/MapView'

export default function App() {
  return (
    <div className="app">
      <TopBar />
      <main className="main">
        <ScenarioRail />
        <section className="center">
          <MapView />
          <LayerPanel />
        </section>
        <RightPanel />
      </main>
    </div>
  )
}
