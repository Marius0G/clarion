import { describe, expect, it } from 'vitest';
import { CameraFeeds, cameraFrame } from '../src/cams.js';

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString('base64');
const frame = (extra: Record<string, unknown> = {}) => ({ camera: 'cctv_security_queue', zone: 'U_SECURITY_QUEUE', simTime: 54335, w: 960, h: 540, jpeg, count: 37, detector: 'yolo', ...extra });

describe('camera.frame (contract)', () => {
  it('accepts a frame and keeps the decoded JPEG', () => {
    const feeds = new CameraFeeds();
    expect(feeds.accept(frame(), 1000)).toEqual({ ...frame() });
    expect([...feeds.jpeg('cctv_security_queue')!]).toEqual([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
    expect(feeds.list(3500)).toEqual([{ camera: 'cctv_security_queue', zone: 'U_SECURITY_QUEUE', simTime: 54335, count: 37, detector: 'yolo', w: 960, h: 540, age: 2.5 }]);
  });
  it('drops frames faster than ~2/s per camera, not across cameras', () => {
    const feeds = new CameraFeeds();
    feeds.accept(frame(), 1000);
    expect(feeds.accept(frame({ simTime: 54336 }), 1300)).toBeNull();
    expect(feeds.accept(frame({ camera: 'cctv_checkin_overview', zone: 'check_in:1' }), 1300)).not.toBeNull();
    expect(feeds.accept(frame({ simTime: 54340 }), 1900)).not.toBeNull();
    expect(feeds.list(1900).map(c => [c.camera, c.simTime])).toEqual([['cctv_checkin_overview', 54335], ['cctv_security_queue', 54340]]);
  });
  it('keeps at most four cameras; a silent one gives up its slot', () => {
    const feeds = new CameraFeeds();
    for (const [i, cam] of ['a', 'b', 'c', 'd'].entries()) feeds.accept(frame({ camera: `cam_${cam}` }), 1000 + i);
    expect(() => feeds.accept(frame({ camera: 'cam_e' }), 2000)).toThrow('At most 4 cameras');
    for (const cam of ['b', 'c', 'd']) feeds.accept(frame({ camera: `cam_${cam}` }), 40000);
    feeds.accept(frame({ camera: 'cam_e' }), 40000);
    expect(feeds.list(40000).map(c => c.camera)).toEqual(['cam_b', 'cam_c', 'cam_d', 'cam_e']);
  });
  it.each([
    ['camera', { camera: 'CCTV 1' }], ['zone', { zone: 5 }], ['size', { w: 0 }], ['count', { count: -1 }], ['count', { count: 1.5 }],
    ['detector', { detector: 'magic' }], ['jpeg', { jpeg: 'not base64!' }], ['jpeg', { jpeg: Buffer.from('GIF89a').toString('base64') }],
    ['jpeg', { jpeg: 'A'.repeat(300000) }],
  ])('rejects an invalid %s', (_, extra) => {
    expect(() => cameraFrame(frame(extra))).toThrow(/camera\.frame/);
  });
  it('accepts a null zone (a camera over no queue)', () => {
    expect(cameraFrame(frame({ zone: null })).zone).toBeNull();
    expect(cameraFrame(frame({ zone: undefined })).zone).toBeNull();
  });
});
