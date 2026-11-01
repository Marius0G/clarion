import { describe, it, expect } from 'vitest';
import { landmarks, landmarkCoverage, resolveLandmark, landmarkRoute, normalizeLandmark } from '../src/landmarks.js';
import { terminalGraph } from '../src/terminal.js';
import nav from '../../docs/contract/terminal.json' with { type: 'json' };
import appZones from '../../app/src/map/t2/zones.json' with { type: 'json' };
import appPoints from '../../app/src/map/t2/points.json' with { type: 'json' };
describe('passenger landmark catalogue', () => {
  it('covers every map zone, non-camera symbol and contract graph node', () => {
    const sources = new Set(landmarks.flatMap(l => l.sourceIds));
    for (const z of appZones.zones) expect(sources.has(z.id), z.id).toBe(true);
    for (const p of appPoints.points.filter(p => p.type !== 'camera')) expect(sources.has(p.id), p.id).toBe(true);
    for (const n of nav.nodes) expect(sources.has(n.id), n.id).toBe(true);
    expect([...landmarkCoverage.zones, ...landmarkCoverage.points].filter(p => !p.point)).toEqual([]);
    expect(landmarks.some(l => /smoking|lounge/i.test(l.name.en))).toBe(false);
  });
  it('has valid anchors, bilingual names, floors, side and geometry-derived positions', () => {
    expect(new Set(landmarks.map(l => l.id)).size).toBe(landmarks.length);
    for (const l of landmarks) {
      expect(terminalGraph.nodes.some(n => n.id === l.graphNode), l.id).toBe(true);
      expect(l.name.ro && l.name.en).toBeTruthy();
      expect(['Parter', 'Etaj 1', 'Exterior']).toContain(l.floor);
      expect(['landside', 'airside']).toContain(l.side);
      expect(l.position).toMatch(/^(Parter|Etaj 1|Exterior), la (est|vest|nord|sud) de /);
      expect(Number.isFinite(l.x) && Number.isFinite(l.z)).toBe(true);
      for (const a of l.aliases) expect(a).toBe(a.toLowerCase());
    }
  });
  it('keeps each desk in the right physical group', () => {
    for (let i=1; i<=12; i++) {
      const group = resolveLandmark(`ghișeul ${i}`)!;
      expect(group.id).toBe(`check_in:${Math.ceil(i/4)}`);
      expect(group.desks).toContain(`checkin_${i}`);
    }
  });
  it('distinguishes security from its queue and respects token/number boundaries', () => {
    expect(resolveLandmark('la control')?.id).toBe('U_SECURITY');
    expect(resolveLandmark('coada la control')?.id).toBe('U_SECURITY_QUEUE');
    for (const q of ['gate 11', 'poarta 30', 'g31', 'lounge', 'smoking room', 'taxidermy', '', '🧳']) expect(resolveLandmark(q), q).toBeNull();
    expect(resolveLandmark('gate 1 gate 2')).toBeNull();
    expect(normalizeLandmark('LÂNGĂ SCĂRI')).toBe('langa scari');
  });
  it('finds the nearest reachable amenity and never suggests returning through security', () => {
    for (const l of landmarks) for (const nearest of Object.values(l.nearest)) if (nearest) {
      const target = landmarks.find(p => p.id === nearest.id)!;
      expect(landmarkRoute(l, target), `${l.id} → ${nearest.id}`).not.toBeNull();
      expect(nearest.walkSec).toBeGreaterThanOrEqual(0);
    }
    expect(resolveLandmark('cea mai apropiata toaleta', 'U_GATE_8')?.id).toBe('U_WC');
    expect(resolveLandmark('nearest toilet', 'G_CENTER')?.id).toBe('G_WC');
    expect(resolveLandmark('nearest info', 'U_GATE_8')).toBeNull();
    expect(landmarks.find(l => l.id === 'U_GATE_8')!.nearest.exit).toBeNull();
  });
});

