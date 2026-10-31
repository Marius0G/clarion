import { expect, it } from 'vitest';
import { demoBoardingPass } from '../src/bcbp.js';

it('writes all fixed-width M1 fields and round trips the mandatory leg', () => {
  const pass = demoBoardingPass({ flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00', name: 'Popescu/Ion' });
  expect(pass.bcbp).toHaveLength(60);
  // Resolution 792 field offsets, independent of the generator's concatenation.
  const read = { format: pass.bcbp.slice(0, 2), name: pass.bcbp.slice(2, 22).trim(),
    ticket: pass.bcbp[22], pnr: pass.bcbp.slice(23, 30).trim(), from: pass.bcbp.slice(30, 33),
    to: pass.bcbp.slice(33, 36), flight: `${pass.bcbp.slice(36, 39).trim()} ${Number(pass.bcbp.slice(39, 44))}`,
    day: pass.bcbp.slice(44, 47), cabin: pass.bcbp[47], seat: pass.bcbp.slice(48, 52).replace(/^0+/, ''),
    sequence: pass.bcbp.slice(52, 57), status: pass.bcbp[57], optionalLength: pass.bcbp.slice(58, 60) };
  expect(read).toEqual({ format: 'M1', name: pass.passengerName, ticket: 'E', pnr: pass.confirmationCode,
    from: 'CRA', to: 'LTN', flight: 'W6 3751', day: '304', cabin: 'Y', seat: pass.seat,
    sequence: '00001', status: '1', optionalLength: '00' });
});
it('computes leap-year Julian dates and bounds passenger names to 20 ASCII characters', () => {
  const pass = demoBoardingPass({ flight: 'RO 123', destination: 'OTP', localDeparture: '2028-12-31T23:59:00', name: 'Ștefănescu/Ion Alexandru' });
  expect(pass.bcbp.slice(44, 47)).toBe('366');
  expect(pass.passengerName).toBe('STEFANESCU/ION ALEXA');
  expect(pass.bcbp).toMatch(/^[\x20-\x7e]+$/);
});
it('rejects invalid airport, flight, dates and empty names', () => {
  const input = { flight: 'W6 3751', destination: 'LTN', localDeparture: '2026-10-31T09:40:00' };
  for (const change of [{ destination: 'London' }, { flight: 'bad' }, { localDeparture: '2026-02-30T09:40:00' },
    { localDeparture: '2026-10-31T24:00:00' }, { name: '123' }])
    expect(() => demoBoardingPass({ ...input, ...change })).toThrow();
});
