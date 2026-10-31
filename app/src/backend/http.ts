import { backend } from './config'
/** Authenticated operator requests; public callers can continue to use fetch. */
export function backendFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  if (backend.token) headers.set('Authorization', `Bearer ${backend.token}`)
  return fetch(`${backend.http}${path}`, { ...init, headers })
}
