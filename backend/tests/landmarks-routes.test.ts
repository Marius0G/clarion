import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { landmarks, resolveLandmark } from '../src/landmarks.js';
// @ts-expect-error The CLI's JS exports intentionally run without a build or declaration files.
import { evaluateLandmarks } from '../../worker/scripts/landmarks-eval.mjs';
const publicRoot = new URL('../../app/public/', import.meta.url);
const index = () => JSON.parse(readFileSync(new URL('routes/index.json', publicRoot), 'utf8'));

describe('rendered passenger routes', () => {
  it('serializes the complete shared catalogue without drift', () => {
    expect(index().points).toEqual(landmarks);
  });
  it('passes all realistic RO/EN phrases and verifies images from five origins', () => {
    const report = evaluateLandmarks(resolveLandmark, index());
    expect(report.total).toBeGreaterThanOrEqual(150);
    expect(report.failures).toEqual([]);
    expect(report.accuracy).toBeGreaterThanOrEqual(95);
    expect(report.images).toBeGreaterThan(0);
    expect(report.documentedSkips).toBeGreaterThan(0);
  });
  it('renders routes starting at the escalator, stairs and lifts', () => {
    for (const from of ['escalator_east_G','stairs_east_G','lift_east_G']) {
      const r = index().routes[`${from}__U_GATE_3`];
      expect(r, from).toBeDefined();
      expect(r.steps[0].node).toBe(from);
    }
  });
  it('stays below 40 MB including index and every file on disk', () => {
    const size = (dir: URL): number => readdirSync(dir, { withFileTypes: true }).reduce((sum, f) => {
      const path = new URL(f.name + (f.isDirectory() ? '/' : ''), dir);
      return sum + (f.isDirectory() ? size(path) : statSync(path).size);
    }, 0);
    expect(size(new URL('routes/', publicRoot))).toBeLessThan(40e6);
  });
});
