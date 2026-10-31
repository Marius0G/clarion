import { useEffect, useState } from 'react'
import { backend } from './config'

/** D11: a staff report, placed on a terminal.json node. */
export interface StaffReport { id: string; at: string; kind: string; node: string; text: string; status: string }

const closed = ['closed', 'resolved', 'done']
/** Keeps well-formed open reports; anything else (404, old backend, bad rows) gives none. */
export function openReports(body: unknown): StaffReport[] {
  if (!Array.isArray(body)) return []
  return body.filter((r): r is StaffReport => !!r && typeof r === 'object' &&
    ['id', 'at', 'kind', 'node', 'text', 'status'].every(k => typeof (r as Record<string, unknown>)[k] === 'string') &&
    !closed.includes((r as StaffReport).status))
}

/** GET /api/reports, polled. Empty on 401/404 or a network error. Reports with no node have no pin. */
export function useReports(intervalMs = 3000): StaffReport[] {
  const [reports, setReports] = useState<StaffReport[]>([])
  useEffect(() => {
    let alive = true
    // The Worker guards /api/reports with the operator token.
    const load = () => fetch(`${backend.http}/api/reports`, { headers: backend.token ? { Authorization: `Bearer ${backend.token}` } : {} })
      .then(r => r.ok ? r.json() : [])
      .then(body => { if (alive) setReports(openReports(body)) })
      .catch(() => { if (alive) setReports([]) })
    load()
    const timer = setInterval(load, intervalMs)
    return () => { alive = false; clearInterval(timer) }
  }, [intervalMs])
  return reports
}
