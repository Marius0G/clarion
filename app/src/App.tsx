import { OpsDashboard } from './console/OpsDashboard'
/** D16: one admin screen. Reads GET /api/sim, sends decisions to POST /api/ops/command. */
export default function App() {
  return <OpsDashboard />
}
