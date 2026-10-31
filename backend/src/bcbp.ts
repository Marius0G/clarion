/** One-leg Resolution 792 mandatory fields, followed by a zero-length optional section. */
export interface BoardingPass {
  bcbp: string;
  passengerName: string;
  confirmationCode: string;
  carrier: string;
  flightNumber: string;
  destination: string;
  localDeparture: string;
  seat: string;
  boardingGroup: string;
  entryTime?: string;
}
export function demoBoardingPass(input: {
  flight: string; destination: string; localDeparture: string; name?: string; entryTime?: string;
}): BoardingPass {
  const flight = /^([A-Z0-9]{2}|[A-Z]{3})\s*(\d{1,5})$/.exec(input.flight.trim().toUpperCase());
  if (!flight || !/^[A-Z]{3}$/.test(input.destination)) throw new Error('Invalid boarding flight');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(input.localDeparture)) throw new Error('Invalid local departure');
  const dateText = input.localDeparture.slice(0, 10);
  const date = new Date(`${dateText}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dateText ||
    Number(input.localDeparture.slice(11, 13)) > 23 || Number(input.localDeparture.slice(14, 16)) > 59 ||
    Number(input.localDeparture.slice(17, 19)) > 59) throw new Error('Invalid local departure');
  const day = Math.floor((date.getTime() - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
  const passengerName = (input.name ?? 'POPESCU/ION').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/[^A-Z /-]/g, '').trim().replace(/\s+/g, ' ').slice(0, 20).trim();
  if (!passengerName) throw new Error('Invalid passenger name');
  const carrier = flight[1]!, flightNumber = String(Number(flight[2]!));
  const confirmationCode = 'ABC123', seat = '12A', boardingGroup = '1';
  const bcbp = `M1${passengerName.padEnd(20)}E${confirmationCode.padEnd(7)}CRA${input.destination}` +
    `${carrier.padEnd(3)}${flightNumber.padStart(5, '0')}${String(day).padStart(3, '0')}Y${seat.padStart(4, '0')}00001100`;
  return { bcbp, passengerName, confirmationCode, carrier, flightNumber, destination: input.destination,
    localDeparture: input.localDeparture, seat, boardingGroup, ...(input.entryTime && { entryTime: input.entryTime }) };
}
