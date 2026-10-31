import { useEffect } from 'react'
import { connectBackend } from './backend/client'
import { DispatcherConsole } from './console/DispatcherConsole'
export default function App() {
  useEffect(() => connectBackend(), [])
  return <DispatcherConsole />
}
