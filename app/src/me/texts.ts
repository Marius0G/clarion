type Lang = 'ro' | 'en';
const english: Record<string, string> = {
  "Evacuare": "Evacuation",
  "Zone:": "Areas:",
  "necunoscut": "unknown",
  "Urmează indicatoarele spre cea mai apropiată ieșire": "Follow signs to the nearest exit",
  "Situația din terminal": "Terminal conditions",
  "timp necunoscut acum": "current wait unknown",
  "prognoză necunoscută": "forecast unknown",
  "Cozi acum și prognoză: necunoscut": "Current queues and forecast: unknown",
  "Poarta": "Gate",
  "se închide la": "closes at",
  "Cu situația de acum, de la intrare la poartă": "With current conditions, entrance to gate",
  "durată necunoscută": "duration unknown",
  "ora simulării": "simulation time",
  "Se încarcă…": "Loading…",
  "date demo": "demo data",
  "Zbor": "Flight",
  "Destinație": "Destination",
  "Poartă": "Gate",
  "Închidere poartă": "Gate closes",
  "Plecare": "Departure",
  "Status": "Status",
  "Etape": "Stages",
  "Timpi: necunoscut": "Times: unknown",
  "Hartă": "Map",
  "Alerte": "Alerts",
  "Nicio alertă.": "No alerts.",
  "min acum": "min now",
  "min la": "min at",
  "min, inclusiv 10 min marjă": "min, including a 10 min margin",
  "Programat": "Scheduled",
  "Îmbarcare": "Boarding",
  "Întârziat": "Delayed",
  "Anulat": "Cancelled",
  "Plecat": "Departed"
};
export const pageText = (text: string, lang: Lang) => lang === 'en' ? english[text] ?? text : text;
export function pageZone(zone: string, label: string, lang: Lang) {
  if (lang !== 'en') return label;
  const [base, group] = zone.split(':');
  const names: Record<string, string> = { security: 'Security', check_in: 'Check-in', bag_drop: 'Bag drop', walk: 'Walk to gate', margin: 'Margin' };
  return names[base] ? `${names[base]}${group ? `, group ${group}` : ''}` : label;
}
export const pageSource = (source: string, lang: Lang) => lang === 'en' ? ({ 'prognoză': 'forecast', 'acum': 'now', 'estimare standard': 'standard estimate' } as Record<string, string>)[source] ?? source : source;
