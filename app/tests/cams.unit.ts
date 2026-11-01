import { describe, expect, it } from 'vitest'
import { cameraRows } from '../src/backend/cams'
import { cameraAge, cameraLine, cameraName } from '../src/console/CameraStrip'

const row = { camera: 'cctv_security_queue', zone: 'U_SECURITY_QUEUE', simTime: 54335, count: 37, detector: 'yolo', w: 960, h: 540, age: 1.2 }
describe('camera feeds (contract camera.frame)', () => {
  it('keeps well-formed GET /cams rows, at most four', () => {
    expect(cameraRows([row])).toEqual([row])
    expect(cameraRows({ error: 'Operator token required' })).toEqual([])
    expect(cameraRows([{ ...row, camera: 'CCTV 1' }, { ...row, count: '3' }, { ...row, detector: 'magic' }, { ...row, zone: 5 }])).toEqual([])
    expect(cameraRows(Array.from({ length: 6 }, (_, i) => ({ ...row, camera: `cam_${i}` })))).toHaveLength(4)
    expect(cameraRows([{ ...row, zone: null }])[0]!.zone).toBeNull()
  })
  it('names cameras in Romanian and never passes a frame count off as the zone estimate', () => {
    expect(cameraName('cctv_security_queue')).toBe('Coada de securitate')
    expect(cameraName('cctv_gates_mid')).toBe('gates mid')
    expect(cameraLine({ count: 37, detector: 'yolo', age: 1.2 })).toBe('37 în cadru · YOLO · acum')
    expect(cameraLine({ count: 3, detector: 'simulated', age: 4 })).toBe('3 în cadru · detector simulat · acum 4 s')
    expect(cameraLine({ count: 3, detector: 'simulated', age: 4 }, true)).toBe('3 în cadru · simulat · acum 4 s')
  })
  it('marks a frame older than 10 s as lost', () => {
    expect(cameraAge(9.6)).toBe('acum 10 s')
    expect(cameraAge(12.4)).toBe('fără cadru de 12 s')
  })
})
