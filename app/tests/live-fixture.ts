import type { PersonalReport } from '../src/reports/types'
import type { Page } from '@playwright/test'
import { fixture } from '../src/me/fixture'

/** Camera rows as /api/sim/flow sends them (D0: source vision). `ago` in seconds. */
export function flowFixture(now = Date.now()) {
  const row = (waiting: number, extra: Record<string, unknown> = {}, ago = 2) => ({ waiting, waitMin: null, density: null, coverage: 1, forecast: null, updatedAt: new Date(now - ago * 1000).toISOString(), stale: false, source: 'vision', ...extra })
  return {
    at: new Date(now).toISOString(), simTime: 50400, blocked: [],
    flow: {
      security: row(62, { waitMin: 14, forecast: [{ inMin: 30, waitMin: 18 }, { inMin: 60, waitMin: 8 }] }),
      'check_in:2': row(9, { waitMin: 5, forecast: [{ inMin: 30, waitMin: 6 }] }),
      gate_3: row(70, { density: 1.4 }),
      U_CAFE: row(6, { density: 0.3 }),
      G_CENTER: row(240, { density: 2.4 }),
      U_DUTY_FREE: row(30, { density: 0.8 }, 300),
    },
  }
}
export const session = 'a'.repeat(64)
export const staffSession = 'b'.repeat(64)

/** Common routes for the live pages: crowding, chat ticket refused (polling fallback), empty chat. */
export async function mockLive(page: Page, opts: { flow?: () => unknown; ops?: unknown[] } = {}) {
  await page.route('**/api/sim/flow', route => route.fulfill({ json: opts.flow ? opts.flow() : flowFixture() }))
  await page.route('**/api/sim', route => route.fulfill({ json: { ops: opts.ops ?? [], flow: {} } }))
  await page.route('**/api/chat/ticket', route => route.fulfill({ status: 503, json: {} }))
  await page.route('**/api/chat', route => route.request().method() === 'GET' ? route.fulfill({ json: { history: [] } }) : route.fallback())
}

export const passengerData = { ...fixture, stage: 'public', routeImage: '/routes/door_departures__U_GATE_3.png', timeline: [], reports: [] }

export function staffData(now = Date.now()) {
  const iso = (ago: number) => new Date(now - ago * 1000).toISOString()
  return {
    zone: 'security', role: 'security_supervisor', alerts: [{ id: 'A1', priority: 'P2', kind: 'zone-target', zoneId: 'security', text: 'Țintă depășită', numbers: { waitMin: 14, targetMin: 10 } }],
    situation: { waitMin: 14, people: 62, state: 'busy', forecast: [{ inMin: 30, waitMin: 18 }] },
    reports: [
      { id: 'R1', isOwn: true, reporterRole: 'security_supervisor', at: iso(400), type: 'crowd', text: 'Prea multă lume aici', source: 'staff', state: 'sent', priority: 'P2', place: { node: 'U_SECURITY_QUEUE', name: 'Coadă securitate' }, etaMin: null, timestamps: { sent: iso(400) } },
      { id: 'R2', isOwn: false, reporterRole: 'hall_agent', at: iso(200), type: 'medical', text: 'Pasager căzut', source: 'staff', state: 'en_route', priority: 'P1', place: { node: 'U_GATE_3', name: 'Poarta 3' }, etaMin: 4, timestamps: { sent: iso(200), taken: iso(150), en_route: iso(90) } },
      { id: 'R3', isOwn: false, reporterRole: 'passenger', at: iso(900), type: 'cleaning', text: '', source: 'staff', state: 'resolved', priority: 'P3', place: { node: 'G_WC', name: 'Toalete parter' }, etaMin: 3, timestamps: { sent: iso(900), resolved: iso(120) } },
    ] as (PersonalReport & { timestamps: NonNullable<PersonalReport['timestamps']> })[],
  }
}
export const opsFixture = (now = Date.now()) => [
  { id: 'o1', type: 'staff', zone: 'security', delta: 1, status: 'acked', sentAt: new Date(now - 180_000).toISOString(), ackedAt: null },
  { id: 'o2', type: 'close', zone: 'U_GATE_9', status: 'sent', sentAt: new Date(now - 60_000).toISOString(), ackedAt: null },
]
