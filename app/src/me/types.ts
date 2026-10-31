export type PassengerData = {
  simTime: number | null
  flight: {
    flight: string
    destination: string
    std: string
    gate: string
    gateCloseAt: string
    status: 'scheduled' | 'boarding' | 'delayed' | 'cancelled' | 'departed'
    delayMin: number
  }
  queues?: { zone: string; label: string; nowMin: number | null; forecastMin: number | null; forecastAt: string; source: string }[]
  entranceToGateMin?: number | null
  arriveBy: string
  steps: { zone: string; label: string; waitMin: number | null }[]
  alerts: { at: string; kind: 'arrive' | 'flight' | 'route' | 'evacuate' | 'admin'; text: string }[]
  evacuation: { active: boolean; zones: string[] }
}
