import { afterEach, expect, it, vi } from 'vitest'
vi.mock('../src/backend/config', () => ({ backend: { http: 'https://api.example', token: 'operator-only' } }))
import { backendFetch } from '../src/backend/http'
afterEach(() => vi.unstubAllGlobals())
it('sends the operator token as Bearer on HTTP while preserving request headers', async () => {
  const fetcher = vi.fn().mockResolvedValue(new Response('{}'))
  vi.stubGlobal('fetch', fetcher)
  await backendFetch('/api/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
  expect(fetcher.mock.calls[0][0]).toBe('https://api.example/api/action')
  const init = fetcher.mock.calls[0][1] as RequestInit
  expect(new Headers(init.headers).get('Authorization')).toBe('Bearer operator-only')
  expect(new Headers(init.headers).get('Content-Type')).toBe('application/json')
})
