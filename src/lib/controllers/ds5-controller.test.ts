import { describe, it, expect } from 'vitest';
import { crc32, fillOutputReportCrc, fillFeatureReportCrc } from './crc32';
import { DS5Controller } from './ds5-controller';
import { ControllerManager, createControllerForDevice } from './controller-manager';
import type { HIDDeviceLike, HIDInputReportEvent } from './base-controller';

/** Minimal fake HID device that records the last output/feature report sent. */
function makeFakeDevice(): HIDDeviceLike & {
  sent: { reportId: number; data: Uint8Array }[];
  lastOut: () => { reportId: number; data: Uint8Array } | undefined;
} {
  const sent: { reportId: number; data: Uint8Array }[] = [];
  return {
    opened: true,
    collections: [
      {
        featureReports: Array.from({ length: 256 }, (_, i) => ({
          reportId: i,
          items: [{ reportCount: 64 }],
        })),
      },
    ],
    oninputreport: null,
    async sendFeatureReport(_id: number, _data: BufferSource) {},
    async receiveFeatureReport(_id: number) {
      return new DataView(new ArrayBuffer(64));
    },
    async sendReport(reportId: number, data: BufferSource) {
      const u8 =
        data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data as Uint8Array);
      sent.push({ reportId, data: u8 });
    },
    async close() {},
    sent,
    lastOut: () => sent[sent.length - 1],
  } as unknown as HIDDeviceLike & {
    sent: typeof sent;
    lastOut: () => (typeof sent)[number] | undefined;
  };
}

describe('crc32', () => {
  // Standard CRC32 test vector (IEEE 802.3, the polynomial the DS5 uses).
  it('matches the canonical "123456789" vector (0xCBF43926)', () => {
    const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    expect(crc32(bytes)).toBe(0xcbf43926);
  });

  it('is deterministic and affected by prefix', () => {
    const body = new Uint8Array([1, 2, 3, 4]);
    expect(crc32(body)).not.toBe(crc32(body, [0xa2, 0x31]));
    expect(crc32(body)).toBe(crc32(body)); // deterministic
  });
});

describe('fillOutputReportCrc (BT 0x31 frame)', () => {
  it('writes a little-endian CRC32 at the tail that round-trips through crc32()', () => {
    const frame = new Uint8Array(77);
    frame[0] = 0x00; // seq<<4
    frame[1] = 0x10;
    for (let i = 2; i < 49; i++) frame[i] = (i * 7) & 0xff; // some common payload
    fillOutputReportCrc(frame);
    const expected = crc32(frame.subarray(0, 73), [0xa2, 0x31]);
    const got = frame[73] | (frame[74] << 8) | (frame[75] << 16) | (frame[76] << 24);
    expect(got >>> 0).toBe(expected);
    expect(frame[1]).toBe(0x10);
  });
});

describe('fillFeatureReportCrc (BT feature report)', () => {
  it('writes the CRC32 (seed 0x53) at the tail of a 64-byte report', () => {
    const report = new Uint8Array(64);
    report[0] = 9;
    report[1] = 2;
    fillFeatureReportCrc(0x80, report);
    const expected = crc32(report.subarray(0, 60), [0x53, 0x80]);
    const got = report[60] | (report[61] << 8) | (report[62] << 16) | (report[63] << 24);
    expect(got >>> 0).toBe(expected);
  });
});

describe('DS5Controller output framing', () => {
  it('USB: sends report id 0x02 with the 47-byte common payload (lightbar RGB at 44/45/46)', async () => {
    const dev = makeFakeDevice();
    const ctrl = new DS5Controller(dev);
    ctrl.setTransport('usb');
    await ctrl.setLightbarColor(255, 0, 0);
    const out = dev.lastOut()!;
    expect(out.reportId).toBe(0x02);
    expect(out.data.byteLength).toBe(47);
    expect(out.data[44]).toBe(255); // red
    expect(out.data[45]).toBe(0); // green
    expect(out.data[46]).toBe(0); // blue
    // validFlag1 LIGHTBAR_COLOR bit (0x04) must be set in the LE u16 at offset 0.
    const flags = out.data[0] | (out.data[1] << 8);
    expect((flags >>> 8) & 0x04).toBe(0x04);
  });

  it('BT: sends a 77-byte 0x31 frame with header 0x10, common payload at offset 2, and a valid trailing CRC', async () => {
    const dev = makeFakeDevice();
    const ctrl = new DS5Controller(dev);
    ctrl.setTransport('bt');
    await ctrl.setLightbarColor(0, 255, 0);
    const out = dev.lastOut()!;
    expect(out.reportId).toBe(0x31);
    expect(out.data.byteLength).toBe(77);
    expect(out.data[0] & 0x0f).toBe(0x00); // seq nibble low, first call seq=0
    expect(out.data[1]).toBe(0x10);
    // common payload (lightbar green) lives at offset 2 + 45.
    expect(out.data[2 + 45]).toBe(255); // green
    expect(out.data[2 + 44]).toBe(0); // red
    expect(out.data[2 + 46]).toBe(0); // blue
    // CRC self-consistency: crc32([0xA2,0x31] ++ frame[0..72]) === frame[73..76] LE.
    const expected = crc32(out.data.subarray(0, 73), [0xa2, 0x31]);
    const got = out.data[73] | (out.data[74] << 8) | (out.data[75] << 16) | (out.data[76] << 24);
    expect(got >>> 0).toBe(expected);
  });

  it('BT: increments the sequence tag nibble across reports', async () => {
    const dev = makeFakeDevice();
    const ctrl = new DS5Controller(dev);
    ctrl.setTransport('bt');
    await ctrl.setVibration(0, 0);
    await ctrl.setVibration(0, 0);
    const a = dev.sent[dev.sent.length - 2];
    const b = dev.sent[dev.sent.length - 1];
    expect((a.data[0] >> 4) & 0x0f).toBe(0x00);
    expect((b.data[0] >> 4) & 0x0f).toBe(0x01);
  });
});

describe('flag2 / lightbar_setup region (#111)', () => {
  it('setLightbarColor sends valid_flag2 enable + lightbar_setup light-on next to the color', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLightbarColor(255, 0, 0);
    const out = device.lastOut()!;
    expect(out.reportId).toBe(0x02);
    expect(out.data[1] & 0x04).toBe(0x04); // flag1 LIGHTBAR_COLOR
    expect(out.data[38]).toBe(0x02); // flag2 LIGHTBAR_SETUP_CONTROL_ENABLE
    expect(out.data[41]).toBe(0x00); // lightbar_setup = light-on
    expect(out.data[42]).toBe(255); // led_brightness bleibt voll an
    expect(out.data[44]).toBe(255); // RGB rot
    expect(out.data[45]).toBe(0);
    expect(out.data[46]).toBe(0);
  });

  it('setLightbarSetup("light-out") writes LIGHT_OUT with flag2 enable', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLightbarSetup('light-out');
    const out = device.lastOut()!;
    expect(out.data[38]).toBe(0x02);
    expect(out.data[41]).toBe(0x02); // LIGHT_OUT
  });

  it('setLedBrightness(50) writes the brightness byte with flag2 enable', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLedBrightness(50);
    const out = device.lastOut()!;
    expect(out.data[38]).toBe(0x02);
    expect(out.data[42]).toBe(Math.round((50 / 100) * 255)); // 128
  });

  it('setLedBrightness clamps percent to 0..100', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLedBrightness(500);
    expect(device.lastOut()!.data[42]).toBe(255);
    await ctrl.setLedBrightness(-10);
    expect(device.lastOut()!.data[42]).toBe(0);
  });

  it('explicit brightness 0 survives the next color write (no || 255 fallback)', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLedBrightness(0);
    expect(device.lastOut()!.data[42]).toBe(0);
    await ctrl.setLightbarColor(10, 20, 30);
    expect(device.lastOut()!.data[42]).toBe(0); // not re-sent as 255
    expect(device.lastOut()!.data[44]).toBe(10);
  });
});

describe('connect baseline + battery 0xF (#112)', () => {
  it('initializeCurrentOutputState flashes blue with the lightbar setup enabled', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.initializeCurrentOutputState();
    const out = device.lastOut()!;
    expect(out.data[1] & 0x04).toBe(0x04); // flag1 LIGHTBAR_COLOR
    expect(out.data[38]).toBe(0x02); // flag2 enable
    expect(out.data[41]).toBe(0x00); // light-on
    expect(out.data[42]).toBe(255); // volle Helligkeit
    expect(out.data[44]).toBe(0);
    expect(out.data[45]).toBe(0);
    expect(out.data[46]).toBe(255); // blau
  });

  it('parseBatteryStatus treats status 0xF as an error, not as charging', () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    view.setUint8(52, 0xf0); // status 0xF, charge 0
    const s = ctrl.parseBatteryStatus(view);
    expect(s.is_error).toBe(true);
    expect(s.is_charging).toBe(false);
    expect(s.cable_connected).toBe(false);
  });
});

describe('legacy 0x20 player-LED fallback (#114)', () => {
  it('setPlayerIndicator additionally sends the legacy 0x20 report (old BDM boards)', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setPlayerIndicator(0b01010);
    const legacy = device.sent.find((s: { reportId: number }) => s.reportId === 0x20);
    expect(legacy).toBeDefined();
    expect(legacy!.data[0]).toBe(0b01010);
  });
});

describe('ControllerManager input parsing (transport-aware)', () => {
  function buildUsbReport(): Uint8Array {
    const r = new Uint8Array(64);
    r[0] = 0; // LX = -1
    r[1] = 255; // LY = +1
    r[2] = 0; // RX = -1
    r[3] = 255; // RY = +1
    r[4] = 200; // L2 analog
    r[5] = 100; // R2 analog
    r[7] = 0x08 | 0x20; // dpad neutral (hat=8) + cross
    r[8] = 0x01; // L1
    r[9] = 0x01; // PS
    return r;
  }

  it('USB report id 0x01: parses sticks/triggers/buttons from offset 0, sets transport usb', () => {
    const dev = makeFakeDevice();
    const ctrl = new DS5Controller(dev);
    const mgr = new ControllerManager();
    mgr.setControllerInstance(ctrl);
    let captured: {
      sticks: unknown;
      l2: number;
      r2: number;
      cross: boolean;
      l1: boolean;
      ps: boolean;
    } | null = null;
    mgr.setInputHandler((input) => {
      const c = input.changes;
      captured = {
        sticks: c.sticks,
        l2: (c.l2_analog as number) ?? -1,
        r2: (c.r2_analog as number) ?? -1,
        cross: (c.cross as boolean) ?? false,
        l1: (c.l1 as boolean) ?? false,
        ps: (c.ps as boolean) ?? false,
      };
    });
    // Rust strips the report-id byte, so the frontend receives the 63-byte body
    // starting at common[0]. Simulate that by passing the body without report id.
    const body = buildUsbReport().subarray(0, 63);
    mgr.processControllerInput({
      data: new DataView(body.buffer, body.byteOffset, body.byteLength),
      reportId: 0x01,
    });
    expect(ctrl.transport).toBe('usb');
    expect(captured!.sticks).toEqual({ left: { x: -1, y: 1 }, right: { x: -1, y: 1 } });
    expect(captured!.l2).toBe(200);
    expect(captured!.r2).toBe(100);
    expect(captured!.cross).toBe(true);
    expect(captured!.l1).toBe(true);
    expect(captured!.ps).toBe(true);
  });

  it('BT report id 0x31: drops the seq byte so the same offsets apply, sets transport bt', () => {
    const dev = makeFakeDevice();
    const ctrl = new DS5Controller(dev);
    const mgr = new ControllerManager();
    mgr.setControllerInstance(ctrl);
    let captured: {
      sticks: unknown;
      l2: number;
      r2: number;
      cross: boolean;
      l1: boolean;
      ps: boolean;
    } | null = null;
    mgr.setInputHandler((input) => {
      const c = input.changes;
      captured = {
        sticks: c.sticks,
        l2: (c.l2_analog as number) ?? -1,
        r2: (c.r2_analog as number) ?? -1,
        cross: (c.cross as boolean) ?? false,
        l1: (c.l1 as boolean) ?? false,
        ps: (c.ps as boolean) ?? false,
      };
    });
    // BT input frame after Rust strips report id: [seq, common0..common46, ...].
    const common = buildUsbReport().subarray(0, 47);
    const bt = new Uint8Array(77);
    bt[0] = 0x40; // seq<<4
    bt.set(common, 1);
    mgr.processControllerInput({ data: new DataView(bt.buffer), reportId: 0x31 });
    expect(ctrl.transport).toBe('bt');
    expect(captured!.sticks).toEqual({ left: { x: -1, y: 1 }, right: { x: -1, y: 1 } });
    expect(captured!.l2).toBe(200);
    expect(captured!.r2).toBe(100);
    expect(captured!.cross).toBe(true);
    expect(captured!.l1).toBe(true);
    expect(captured!.ps).toBe(true);
  });
});

describe('DS5 PID table (#117)', () => {
  it('creates a DS5Controller for the Edge USB PID 0x0e5f', () => {
    const dev = makeFakeDevice();
    const device = { ...dev, vendorId: 0x054c, productId: 0x0e5f } as unknown as Parameters<
      typeof createControllerForDevice
    >[0];
    expect(createControllerForDevice(device)?.getModel()).toBe('DS5');
  });
});

describe('createControllerForDevice', () => {
  it('returns a DS5Controller for the DualSense product ids', () => {
    const dev = makeFakeDevice();
    // createControllerForDevice reads vendorId/productId via an `as unknown`
    // cast (they aren't part of HIDDeviceLike), so the test object carries them
    // as extra fields and we cast to satisfy the param type.
    const withIds = (vendorId: number, productId: number) =>
      ({ ...dev, vendorId, productId }) as unknown as Parameters<
        typeof createControllerForDevice
      >[0];
    expect(createControllerForDevice(withIds(0x054c, 0x0ce6))).toBeInstanceOf(DS5Controller);
    expect(createControllerForDevice(withIds(0x054c, 0x0df2))).toBeInstanceOf(DS5Controller);
    expect(createControllerForDevice(withIds(0x054c, 0x0e5f))).toBeInstanceOf(DS5Controller);
    expect(createControllerForDevice(withIds(0x1234, 0x0ce6))).toBeNull();
  });
});

describe('_getInfo feature-report parsing', () => {
  /** Build a realistic 64-byte DS5 feature-report 0x20 buffer.
   *  Byte 0 = report id (0x20), matching the WebHID convention the parser
   *  expects. The Rust backend now returns the full buffer (rbuf[..n]) so
   *  byte 0 IS the report id — this test guards against regressions. */
  function makeInfoReport(): ArrayBuffer {
    const buf = new ArrayBuffer(64);
    const v = new DataView(buf);
    v.setUint8(0, 0x20); // report id
    // buildDate "2024-05-01" (11 bytes at offset 1)
    const bd = new TextEncoder().encode('2024-05-01 ');
    new Uint8Array(buf, 1, 11).set(bd.subarray(0, 11));
    // buildTime "10:30:00" (8 bytes at offset 12)
    const bt = new TextEncoder().encode('10:30:00');
    new Uint8Array(buf, 12, 8).set(bt);
    v.setUint16(20, 2, true); // fwType
    v.setUint16(22, 1, true); // swSeries
    v.setUint32(24, 0xabcd, true); // hwInfo
    v.setUint32(28, 0x15010400, true); // fwVersion → "21.01.04.00"
    v.setUint16(44, 0x200, true); // updateVersion
    v.setUint8(46, 0x42); // updateImageInfo
    v.setUint32(48, 0x01020304, true); // sblFwVersion
    v.setUint32(52, 0x05060708, true); // dspFwVersion
    v.setUint32(56, 0x090a0b0c, true); // spiderDspFwVersion
    return buf;
  }

  it('parses FW Version and build date from a 0x20 report with report-id at byte 0', async () => {
    const infoBuf = makeInfoReport();
    const dev = makeFakeDevice();
    // Override receiveFeatureReport to return our realistic buffer.
    dev.receiveFeatureReport = async (_reportId: number) => new DataView(infoBuf);
    const ctrl = new DS5Controller(dev as unknown as HIDDeviceLike);
    const info = await ctrl._getInfo(false);
    expect(info.ok).toBe(true);
    const fw = info.infoItems?.find((i) => i.key === 'FW Version')?.value;
    expect(fw).toBe('0x15010400');
    const bd = info.infoItems?.find((i) => i.key === 'FW Build Date')?.value;
    expect(bd).toContain('2024-05-01');
  });

  it('returns ok:false when report-id byte is not 0x20', async () => {
    const buf = new ArrayBuffer(64);
    new DataView(buf).setUint8(0, 0x00); // wrong report id
    const dev = makeFakeDevice();
    dev.receiveFeatureReport = async () => new DataView(buf);
    const ctrl = new DS5Controller(dev as unknown as HIDDeviceLike);
    const info = await ctrl._getInfo(false);
    expect(info.ok).toBe(false);
  });
});

// Keep tsc happy about the unused event type alias import in some configs.
export type _UnusedHidEvent = HIDInputReportEvent;

describe('adaptive trigger parametrik (#113)', () => {
  // Byte layout (kernel/Ohjurot/nondebug): R2 trigger effect @10–20, L2 @21–31.
  // setAdaptiveTrigger(left, right): first arg = LEFT trigger (offsets 21+),
  // second arg = RIGHT trigger (offsets 10+).
  it('resistance packs [start, force, 0]', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setAdaptiveTrigger(
      { mode: 'resistance', start: 10, end: 255, force: 200 },
      { mode: 'resistance', start: 20, end: 255, force: 210 }
    );
    const out = device.lastOut()!;
    expect(out.data[10]).toBe(0x01); // mode RIGHT (R2 region) ← second arg
    expect(out.data[11]).toBe(20); // param0 = start
    expect(out.data[12]).toBe(210); // param1 = force
    expect(out.data[13]).toBe(0); // resistance has no param2
    expect(out.data[21]).toBe(0x01); // mode LEFT (L2 region) ← first arg
    expect(out.data[22]).toBe(10);
    expect(out.data[23]).toBe(200);
    expect(out.data[24]).toBe(0);
  });

  it('auto packs [frequency, force, start] and clamps 0..255', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setAdaptiveTrigger(
      { mode: 'auto', start: 30, end: 0, force: 400, frequency: 12 },
      { mode: 'auto', start: 40, end: 0, force: 99, frequency: 7 }
    );
    const out = device.lastOut()!;
    expect(out.data[11]).toBe(7); // R2 param0 = frequency
    expect(out.data[12]).toBe(99);
    expect(out.data[13]).toBe(40); // R2 param2 = start
    expect(out.data[22]).toBe(12); // L2 param0 = frequency
    expect(out.data[23]).toBe(255); // force clamped
    expect(out.data[24]).toBe(30); // L2 param2 = start
  });

  it('setVibration sets COMPATIBLE_VIBRATION and HAPTICS_SELECT together', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setVibration(255, 0);
    const out = device.lastOut()!;
    expect(out.data[0] & 0x03).toBe(0x03); // beide Bits gemeinsam
    expect(out.data[3]).toBe(255); // bcVibrationLeft = heavy
    expect(out.data[2]).toBe(0); // bcVibrationRight = light
  });
});
