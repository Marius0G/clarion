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
  arriveBy: string
  steps: { zone: string; label: string; waitMin: number | null }[]
  alerts: { at: string; kind: 'arrive' | 'flight' | 'route' | 'evacuate' | 'admin'; text: string }[]
  evacuation: { active: boolean; zones: string[] }
}
