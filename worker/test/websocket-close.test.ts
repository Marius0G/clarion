import { expect, it, vi } from 'vitest';
import { closeSocket } from '../src/websocket-close.js';
it.each([1004, 1005, 1006, 1015, 999, 1016, 2000, 2999, 5000, NaN, 1000.5])('normalizes forbidden close code %s', code => {
  const close = vi.fn(); closeSocket({ close }, code); expect(close).toHaveBeenCalledWith(1000);
});
it.each([1000, 1001, 1002, 1003, 1007, 1011, 1014, 3000, 4999])('preserves allowed close code %s', code => {
  const close = vi.fn(); closeSocket({ close }, code); expect(close).toHaveBeenCalledWith(code);
});
