import type { PassengerData } from './types'

export const fixture: PassengerData = {
  simTime: 14 * 3600,
  flight: {
    flight: 'W6 3751', destination: 'Roma', std: '15:30', gate: '3',
    gateCloseAt: '15:05', status: 'scheduled', delayMin: 0,
  },
  arriveBy: '14:20',
  steps: [
    { zone: 'check_in:2', label: 'Check-in grup 2', waitMin: 12 },
    { zone: 'security', label: 'Securitate', waitMin: 8 },
    { zone: 'walk', label: 'Drum la poartă', waitMin: 5 },
  ],
  alerts: [{ at: '14:00', kind: 'arrive', text: 'Fii la intrarea în terminal la 14:20.' }],
  evacuation: { active: false, zones: [] },
}
