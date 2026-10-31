import type { PassengerData } from './types'

export const fixture: PassengerData = {
  simTime: 14 * 3600,
  flight: {
    flight: 'W6 3751', destination: 'Roma', std: '15:30', gate: '3',
    gateCloseAt: '15:05', status: 'scheduled', delayMin: 0,
  },
  arriveBy: '14:25',
  entranceToGateMin: 40,
  queues: [
    { zone: 'security', label: 'Securitate', nowMin: 12, forecastMin: 20, forecastAt: '14:25', source: 'prognoză' },
    { zone: 'check_in:2', label: 'Check-in grup 2', nowMin: 5, forecastMin: 5, forecastAt: '14:25', source: 'acum' },
  ],
  steps: [
    { zone: 'check_in:2', label: 'Check-in grup 2', waitMin: 5 },
    { zone: 'security', label: 'Securitate', waitMin: 20 },
    { zone: 'walk', label: 'Drum la poartă', waitMin: 5 },
  ],
  alerts: [{ at: '14:00', kind: 'arrive', text: 'Securitate: 12 min acum, ~20 min la 14:25. Check-in grup 2: 5 min. Poarta G3 se închide la 15:05.' }],
  evacuation: { active: false, zones: [] },
}
