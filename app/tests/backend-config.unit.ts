import { describe, expect, it, vi } from 'vitest'
import { backendConfig } from '../src/backend/config'
const location = { protocol: 'https:', search: '' }
describe('backend configuration', () => {
  it('uses separately configured WS and HTTP endpoints', () => {
    expect(backendConfig(location, { VITE_BACKEND_URL: 'wss://worker.example/ws', VITE_BACKEND_HTTP: 'https://api.example' }, { getItem: () => null, setItem: () => {} })).toMatchObject({ ws: 'wss://worker.example/ws?client=console', http: 'https://api.example', host: 'worker.example' })
  })
  it('persists host overrides and restores them on a later visit', () => {
    const saved = new Map<string, string>()
    const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value) } }
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

describe('operator token', () => {
  it('persists a URL token and restores it for both WS client roles', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string,v: string) => { values.set(k,v) } }
    const first = backendConfig({ ...location, search: '?token=a%2Bb%26c&backend=https://api.example' }, {}, storage)
    expect(first.token).toBe('a+b&c')
    expect(new URL(first.ws).searchParams.get('token')).toBe('a+b&c')
    const twin = new URL(backendConfig(location, {}, storage).ws); twin.searchParams.set('client', 'twin')
    expect(twin.searchParams.get('token')).toBe('a+b&c')
    expect(backendConfig({ ...location, search: '?token=' }, {}, storage).token).toBeUndefined()
    expect(backendConfig(location, {}, storage).token).toBeUndefined()
  })
  it('uses the URL token even when storage is unavailable', () => {
    expect(backendConfig({ ...location, search: '?token=demo' }, {}, { getItem: () => { throw Error() }, setItem: () => { throw Error() } }).token).toBe('demo')
  })
})

describe('operator token in the address bar', () => {
  it('removes ?token= from the visible URL after storing it', async () => {
    const values = new Map<string, string>(), replaceState = vi.fn()
    vi.stubGlobal('window', {
      location: { protocol: 'https:', search: '?token=secret&backend=api.example', href: 'https://x.pages.dev/console?token=secret&backend=api.example' },
      localStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v) } },
      history: { state: null, replaceState },
    })
    try {
      vi.resetModules()
      const { backend } = await import('../src/backend/config')
      expect(backend.token).toBe('secret')
      expect(values.get('clarion.token')).toBe('secret')
      expect(String(replaceState.mock.calls[0]?.[2])).toBe('https://x.pages.dev/console?backend=api.example')
    } finally { vi.unstubAllGlobals(); vi.resetModules() }
  })
  it('uses the build-time authentication token when none is given', () => {
    const storage = { getItem: () => null, setItem: () => {} }
    const result = backendConfig({ protocol: 'https:', search: '' }, { VITE_BACKEND_HTTP: 'https://api.example', VITE_DEMO_TOKEN: 'demo' }, storage)
    expect(result.token).toBe('demo')
    expect(new URL(result.ws).searchParams.get('token')).toBe('demo')
  })
})
