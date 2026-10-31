import { expect, it } from 'vitest';
import { demoBoardingPass } from '../../backend/src/bcbp';
import { parseBCBP } from '../src/join/bcbp';
it('the browser scanner parser reads the backend-generated demo leg', () => {
  const pass = demoBoardingPass({ flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00' });
  expect(parseBCBP(pass.bcbp, new Date('2026-10-31'))).toEqual({ flight: 'W6 3751', route: 'CRA-LTN', date: '2026-10-31' });
});
