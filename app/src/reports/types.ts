export type PersonalReport = {
  id: string; at: string; type: string; text: string; source: 'passenger' | 'staff'
  state: 'sent' | 'taken' | 'en_route' | 'resolved'; priority: 'P1' | 'P2' | 'P3'
  place: { node: string | null; name: string }; etaMin?: number | null
  /** When each state began (wall clock ISO), from the shared report lifecycle. */
  timestamps?: Partial<Record<'sent' | 'taken' | 'en_route' | 'resolved', string>>
}
