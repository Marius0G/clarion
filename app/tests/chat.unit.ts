import { createElement } from 'react'
import { expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chat, chatError } from '../src/chat/Chat'
import { waitBand } from '../src/me/Me'
it('keeps chat collapsed without history or composer on the dashboard', () => {
  const html = renderToStaticMarkup(createElement(Chat))
  expect(html).toContain('aria-expanded="false"')
  expect(html).toContain('Mesaje')
  expect(html).not.toContain('<dialog')
  expect(html).not.toContain('<input')
})
it('preserves rate-limit errors and queue threshold boundaries', () => {
  expect(chatError(new Error('429'))).toBe('Limită mesaje · 1 min')
  expect(chatError(new Error('500'), true)).toBe('Message unavailable')
  expect([null, 0, 3, 3.1, 10, 10.1].map(waitBand)).toEqual(['—', '0–3', '0–3', '4–10', '4–10', '>10'])
})
