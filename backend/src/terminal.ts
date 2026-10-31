/**
 * PROVISIONAL (D7, D12) until Marius exports `docs/contract/terminal.json`: lanes or desks open at the start, per zone.
 * Zone ids match the provisional plan in app/src/console/terminal.ts. The backend owns these numbers from then on:
 * `staff { zone, delta }` changes them and vision reads them from GET /api/sim (`lanes`).
 */
export const initialLanes: Readonly<Record<string, number>> = {
  'check_in:1': 2, 'bag_drop:1': 1, 'check_in:2': 2, 'bag_drop:2': 1, security: 2,
};
