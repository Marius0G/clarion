/// <reference types="vite/client" />
const storageKey = 'clarion.backend'
export function backendConfig(
  location: Pick<Location, 'protocol' | 'search'> = typeof window === 'undefined' ? { protocol: 'http:', search: '' } : window.location,
  env: { VITE_BACKEND_URL?: string; VITE_BACKEND_HTTP?: string; VITE_DEMO_TOKEN?: string } = { VITE_BACKEND_URL: import.meta.env.VITE_BACKEND_URL, VITE_BACKEND_HTTP: import.meta.env.VITE_BACKEND_HTTP, VITE_DEMO_TOKEN: import.meta.env.VITE_DEMO_TOKEN },
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = undefined,
) {
  const parse = (value: string) => {
    try {
      const url = new URL(/^[a-z]+:\/\//i.test(value) ? value : `${location.protocol === 'https:' ? 'https' : 'http'}://${value}`)
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password) return null
      return url
    } catch { return null }
  }
  let token = new URLSearchParams(location.search).get('token')
  let override = parse(new URLSearchParams(location.search).get('backend') || '')
  try {
    const local = storage ?? window.localStorage
    if (token !== null) local.setItem('clarion.token', token)
    else token = env.VITE_DEMO_TOKEN || local.getItem('clarion.token')
    if (override) local.setItem(storageKey, override.origin)
    else override = parse(local.getItem(storageKey) || '')
  } catch { /* Private mode/storage denial must not block connections. */ }
  // Demo build: the operator token is baked in on purpose (hackathon only, see deploy.yml).
  token ||= env.VITE_DEMO_TOKEN || null
  const ws = new URL(env.VITE_BACKEND_URL || env.VITE_BACKEND_HTTP || 'ws://localhost:8787/ws?client=console')
  const http = new URL(env.VITE_BACKEND_HTTP || env.VITE_BACKEND_URL || 'http://localhost:8787')
  if (override) {
    ws.href = override.href
    http.href = override.href
  }
  ws.protocol = ['https:', 'wss:'].includes(ws.protocol) ? 'wss:' : 'ws:'
  ws.pathname = '/ws'
  ws.searchParams.set('client', 'console')
  if (token) ws.searchParams.set('token', token)
  else ws.searchParams.delete('token')
  http.protocol = ['https:', 'wss:'].includes(http.protocol) ? 'https:' : 'http:'
  // `/console?demo`: the public link from the landing page. Live cameras and numbers, no operator commands.
  const readOnly = new URLSearchParams(location.search).has('demo')
  return { token: token || undefined, ws: ws.href, http: http.origin, host: ws.host, override: override?.origin, readOnly }
}
export const backend = backendConfig()
// The operator token is now in storage; keep it off the projected address bar and history.
if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('token')) {
  const url = new URL(window.location.href)
  url.searchParams.delete('token')
  window.history.replaceState(window.history.state, '', url)
}
