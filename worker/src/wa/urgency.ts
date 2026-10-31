import { isReaction, reactionParts } from './transport.js';

/** Operational urgency, shared by the early acknowledgement and final delivery. */
export function urgentText(text: string) {
  return /evacua|evacuă|cancel|anulat|delay|întârzi|intarzi|(?:gate|poart[aă])[^.!?\n]*(?:chang|new|nou|schimb|mutat)|(?:chang|new|nou|schimb|mutat)[^.!?\n]*(?:gate|poart[aă])/i.test(text);
}

/** Staff messages follow the same incident/greeting distinction as the deterministic agent. */
export function staffIncident(text: string) {
  return !/^\s*(?:ok(?:ay)?|k|mersi|merci|mulțumesc|multumesc|ms|gata|bine|super|perfect|da|nu|thanks?|salut|bun[aă]|hei|hello|hi|thank you|thx)[\s.!👍🙏❤️]*$/i.test(text);
}

/** Remove whole emoji sequences, preserving numbers, diacritics, and route arrows. */
export function plainUrgent(text: string) {
  return text.replace(/[#*0-9]\uFE0F?\u20E3|[\p{Extended_Pictographic}\p{Regional_Indicator}\p{Emoji_Modifier}\uFE0E\uFE0F\u200D\u{E0020}-\u{E007F}]/gu, '').trim();
}

export function urgentBubbles(bubbles: string[]) {
  return bubbles.map(b => plainUrgent(isReaction(b) ? reactionParts(b).rest : b)).filter(Boolean);
}

/** Inspect tool values, never schema keys such as delayMin. */
export function urgentResult(value: unknown): boolean {
  if (typeof value === 'string') return urgentText(value);
  return value !== null && typeof value === 'object' && Object.values(value).some(urgentResult);
}
