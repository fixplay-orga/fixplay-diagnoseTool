// Pure-logic tests for the mock-state helpers — plain node env, no jsdom, no
// store involved (nextMockHidPath is pure so it tests without mockState).
import { describe, it, expect } from 'vitest';
import { nextMockHidPath } from './state';
import type { HidDeviceInfo } from '$lib/controllers/tauri-hid-device';

function dev(path: string): HidDeviceInfo {
  return {
    vendor_id: 0x054c,
    product_id: 0x0ce6,
    manufacturer: 'Sony Interactive Entertainment',
    product: 'DualSense Wireless Controller',
    serial_number: null,
    usage_page: 1,
    usage: 5,
    path,
  };
}

describe('nextMockHidPath (7a)', () => {
  it('returns /dev/hidraw5 for the default device list (single /dev/hidraw4)', () => {
    expect(nextMockHidPath([dev('/dev/hidraw4')])).toBe('/dev/hidraw5');
  });

  it('stays monotonic against removals — no collision after remove-then-add', () => {
    // [hidraw4, hidraw5] minus index 0 → the length-based formula (4 + length)
    // would re-emit hidraw5 and collide with the surviving device.
    const remaining = [dev('/dev/hidraw4'), dev('/dev/hidraw5')].slice(1);
    expect(nextMockHidPath(remaining)).toBe('/dev/hidraw6');
  });

  it('ignores paths that are not /dev/hidraw<N>', () => {
    expect(
      nextMockHidPath([dev('/dev/ttyUSB0'), dev('/dev/hidrawXX'), dev(''), dev('/dev/hidraw10')])
    ).toBe('/dev/hidraw11');
  });

  it('falls back to the /dev/hidraw5 floor on an empty list', () => {
    expect(nextMockHidPath([])).toBe('/dev/hidraw5');
  });

  it('takes the max suffix across all hidraw devices', () => {
    expect(
      nextMockHidPath([dev('/dev/hidraw4'), dev('/dev/hidraw7'), dev('/dev/hidraw6')])
    ).toBe('/dev/hidraw8');
  });
});