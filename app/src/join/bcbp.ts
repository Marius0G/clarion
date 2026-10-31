/** Privacy boundary: return only the first flight leg; never expose name, PNR or raw data. */
export interface BoardingFlight {
  flight: string;
  date: string;
  route: string;
}
export function parseBCBP(
  raw: string,
  reference = new Date(),
): BoardingFlight | null {
  if (!/^M[1-4]/.test(raw) || raw.length < 60) return null;
  const from = raw.slice(30, 33),
    to = raw.slice(33, 36);
  const carrier = raw.slice(36, 39).trim(),
    number = raw.slice(39, 44).trim();
  const dayText = raw.slice(44, 47);
  if (
    !/^[A-Z]{3}$/.test(from) ||
    !/^[A-Z]{3}$/.test(to) ||
    !/^[A-Z0-9]{2,3}$/.test(carrier) ||
    !/^\d{1,5}[A-Z]?$/.test(number) ||
    !/^\d{3}$/.test(dayText)
  )
    return null;
  const day = Number(dayText);
  // BCBP contains a day-of-year, not a year. Choose the nearest valid occurrence;
  // show the inferred date for confirmation rather than silently trusting it.
  const dates = [-1, 0, 1]
    .map((offset) => {
      const year = reference.getUTCFullYear() + offset;
      const date = new Date(Date.UTC(year, 0, day));
      return day > 0 && date.getUTCFullYear() === year ? date : null;
    })
    .filter((date): date is Date => date !== null);
  dates.sort(
    (a, b) =>
      Math.abs(a.getTime() - reference.getTime()) -
      Math.abs(b.getTime() - reference.getTime()),
  );
  if (!dates.length) return null;
  return {
    flight: `${carrier} ${number.replace(/^0+(?=\d)/, "")}`,
    date: dates[0].toISOString().slice(0, 10),
    route: `${from}-${to}`,
  };
}
