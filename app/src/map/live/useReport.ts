import { useCallback, useState } from 'react'
import { personalRequest } from '../../reports/Reports'
import type { Lang, Landmark } from './catalogue'
import { nearestLandmark, type WorldPt } from './LiveMap'

/**
 * Tap-to-report (FixMyStreet): tap the map, drag the pin to adjust, pick the type, Trimite.
 * The pin resolves to the nearest landmark; the backend receives its graph node, as WhatsApp reports do.
 */
export function useReportFlow(points: readonly Landmark[]) {
  const [stage, setStage] = useState<null | 'pick' | 'form'>(null)
  const [draft, setDraft] = useState<WorldPt | null>(null)
  const [placeId, setPlaceId] = useState<string | null>(null)
  const start = useCallback((id?: string | null) => {
    setDraft(null)
    if (id) { setPlaceId(id); setStage('form') } else { setPlaceId(null); setStage('pick') }
  }, [])
  const drop = useCallback((p: WorldPt) => { setDraft(p); setPlaceId(nearestLandmark(points, p)?.id ?? null); setStage('form') }, [points])
  const cancel = useCallback(() => { setStage(null); setDraft(null); setPlaceId(null) }, [])
  return { stage, draft, placeId, place: points.find(p => p.id === placeId), start, drop, cancel, picking: stage === 'pick' || (stage === 'form' && !!draft) }
}

export async function sendReport(place: Landmark, type: string, text: string, lang: Lang) {
  await personalRequest('/api/reports', { type, place: { node: place.graphNode, name: place.name[lang] }, text })
}
