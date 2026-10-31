import { describe, expect, it } from 'vitest'
import { backendConfig } from '../src/backend/config'
const location = { protocol: 'https:', search: '' }
describe('backend configuration', () => {
  it('uses separately configured WS and HTTP endpoints', () => {
    expect(backendConfig(location, { VITE_BACKEND_URL: 'wss://worker.example/ws', VITE_BACKEND_HTTP: 'https://api.example' }, { getItem: () => null, setItem: () => {} })).toMatchObject({ ws: 'wss://worker.example/ws?client=console', http: 'https://api.example', host: 'worker.example' })
  })
  it('persists host overrides and restores them on a later visit', () => {
    let saved = ''
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value } }
    const result = backendConfig({ ...location, search: '?backend=laptop.example:8787' }, {}, storage)
    expect(result.ws).toBe('wss://laptop.example:8787/ws?client=console')
    expect(result.http).toBe('https://laptop.example:8787')
    expect(backendConfig(location, {}, storage)).toEqual(result)
  })
  it('supports explicit local transport and blocked storage', () => {
    const storage = { getItem: () => { throw Error('denied') }, setItem: () => { throw Error('denied') } }
    expect(backendConfig({ ...location, search: '?backend=http://192.168.1.2:8787' }, {}, storage)).toMatchObject({ ws: 'ws://192.168.1.2:8787/ws?client=console', http: 'http://192.168.1.2:8787' })
    expect(backendConfig(location, { VITE_BACKEND_HTTP: 'https://worker.example' }, storage).ws).toBe('wss://worker.example/ws?client=console')
  })
  it('rejects non-network protocols and credentials', () => {
    for (const value of ['javascript:alert(1)', 'https://user:password@example.com']) {
      expect(backendConfig({ ...location, search: `?backend=${encodeURIComponent(value)}` }, {}, { getItem: () => null, setItem: () => {} }).host).toBe('localhost:8787')
    }
  })
})
