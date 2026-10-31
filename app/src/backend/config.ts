const storageKey = 'clarion.backend'
export function backendConfig(
  location: Pick<Location, 'protocol' | 'search'> = typeof window === 'undefined' ? { protocol: 'http:', search: '' } : window.location,
  env: { VITE_BACKEND_URL?: string; VITE_BACKEND_HTTP?: string } = { VITE_BACKEND_URL: import.meta.env.VITE_BACKEND_URL, VITE_BACKEND_HTTP: import.meta.env.VITE_BACKEND_HTTP },
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = undefined,
) {
  const parse = (value: string) => {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `${location.protocol === 'https:' ? 'https' : 'http'}://${value}`)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return null
      return url
    } catch { return null }
  }
  let override = parse(new URLSearchParams(location.search).get('backend') || '')
  try {
    const local = storage ?? window.localStorage
    if (override) local.setItem(storageKey, override.origin)
    else override = parse(local.getItem(storageKey) || '')
  } catch { /* Private mode/storage denial must not block connections. */ }
  const ws = new URL(env.VITE_BACKEND_URL || env.VITE_BACKEND_HTTP || 'ws://localhost:8787/ws?client=console')
  const http = new URL(env.VITE_BACKEND_HTTP || env.VITE_BACKEND_URL || 'http://localhost:8787')
  if (override) {
    ws.href = override.href
    http.href = override.href
  }
  ws.protocol = ['https:', 'wss:'].includes(ws.protocol) ? 'wss:' : 'ws:'
  ws.pathname = '/ws'
  ws.searchParams.set('client', 'console')
  http.protocol = ['https:', 'wss:'].includes(http.protocol) ? 'https:' : 'http:'
  return { ws: ws.href, http: http.origin, host: ws.host, override: override?.origin }
}
export const backend = backendConfig()
