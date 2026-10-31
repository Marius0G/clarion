/** Workers accepts protocol codes 1000–1014 except reserved codes, and application codes 3000–4999. */
export function closeSocket(ws: { close(code: number): void }, code: number) {
  const allowed = Number.isInteger(code) && ((code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999));
  ws.close(allowed ? code : 1000);
}
