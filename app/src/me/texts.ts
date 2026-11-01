type Lang = 'ro' | 'en'
const english: Record<string, string> = {
  'Evacuare': 'Evacuation',
  'necunoscut': 'unknown',
  'Urmează indicatoarele spre cea mai apropiată ieșire': 'Follow signs to the nearest exit',
  'Poarta': 'Gate',
  'Poartă': 'Gate',
  'se închide la': 'closes at',
  'Se încarcă…': 'Loading…',
  'Zbor': 'Flight',
  'Plecare': 'Departure',
  'min la': 'min at',
  'La timp': 'On time',
  'Îmbarcare': 'Boarding',
  'Întârziat': 'Delayed',
  'Anulat': 'Cancelled',
  'Poartă închisă': 'Gate closed',
}
export const pageText = (text: string, lang: Lang) => lang === 'en' ? english[text] ?? text : text
