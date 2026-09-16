import { describe, it, expect, beforeEach } from 'vitest';
import { invoke } from './core';
import { mockState, resetMockState, getMockState, mockHidRuntime, mockFeatureReplies } from './state';
import { on } from './_shared';
import { validateBtInputCrc, fillOutputReportCrc } from '../controllers/crc32';

// The mock layer is ~700 lines of infrastructure that previously had zero
// tests. These exercise the invoke() routing, state-backed handlers, and the
// DualSense report builder — all without the Tauri backend.

beforeEach(() => {
  resetMockState();
  // Make the simulated flash sequences instant (no real delays in tests).
  mockState.update((s) => ({
    ...s,
    flash: { ...s.flash, read_step_ms: 0, write_step_ms: 0, verify_step_ms: 0 },
  }));
});

describe('mock invoke() routing', () => {
  it('returns undefined and warns for an unknown command', async () => {
    const r = await invoke('does_not_exist');
    expect(r).toBeUndefined();
  });

  it('returns the programmer list from state', async () => {
    mockState.update((s) => ({ ...s, flash: { ...s.flash, programmers: ['ch341a', 'rt809h'] } }));
    const r = await invoke<string[]>('flash_list_programmers');
    expect(r).toEqual(['ch341a', 'rt809h']);
  });

  it('returns the archive list from state', async () => {
    const r = await invoke<unknown[]>('archive_list_dumps');
    expect(Array.isArray(r)).toBe(true);
  });
});

describe('mock settings round-trip', () => {
  it('settings_save is reflected by a subsequent settings_get', async () => {
    await invoke('settings_save', { settings: { baud_rate: 9600, tablet_mode: true } });
    const got = await invoke<{ baud_rate: number; tablet_mode: boolean }>('settings_get');
    expect(got.baud_rate).toBe(9600);
    expect(got.tablet_mode).toBe(true);
  });
});

describe('mock search handlers substitute {query}', () => {
  it('uart_search_error_db interpolates the query into descriptions', async () => {
    const r = await invoke<{ description: string }[]>('uart_search_error_db', { query: 'thermal' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => !x.description.includes('{query}'))).toBe(true);
    expect(r.some((x) => x.description.includes('thermal'))).toBe(true);
  });

  it('i2c_search_xbox_db interpolates the query into descriptions', async () => {
    const r = await invoke<{ description: string }[]>('i2c_search_xbox_db', { query: 'overheat' });
    expect(r.length).toBeGreaterThan(0);
    expect(r.every((x) => !x.description.includes('{query}'))).toBe(true);
  });
});

describe('mock hid_poll builds a DS5 report from input state', () => {
  it('emits one report when connected, none when disconnected', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, connected: true } }));
    const connected = await invoke<{
      connected: boolean;
      reports: { report_id: number; data: number[] }[];
    }>('hid_poll');
    expect(connected.connected).toBe(true);
    expect(connected.reports).toHaveLength(1);
    expect(connected.reports[0].data).toHaveLength(64);

    mockState.update((s) => ({ ...s, hid: { ...s.hid, connected: false } }));
    const off = await invoke<{ connected: boolean; reports: unknown[] }>('hid_poll');
    expect(off.connected).toBe(false);
    expect(off.reports).toHaveLength(0);
  });

  it('encodes a full-throw left stick and cross button into the report bytes', async () => {
    mockState.update((s) => ({
      ...s,
      hid: {
        ...s.hid,
        connected: true,
        input: {
          ...s.hid.input,
          lx: 1,
          ly: 1, // full up-right → axis saturates to 255
          buttons: { ...s.hid.input.buttons, cross: true },
        },
      },
    }));
    const r = await invoke<{ reports: { data: number[] }[] }>('hid_poll');
    const data = r.reports[0].data;
    expect(data[0]).toBe(255); // lx saturated
    expect(data[1]).toBe(255); // ly saturated
    // cross is bit 0x20 of byte 7 (face-button nibble)
    expect(data[7] & 0x20).toBe(0x20);
  });

  it('encodes battery 100% as "complete" status (high nibble = 2)', async () => {
    mockState.update((s) => ({
      ...s,
      hid: { ...s.hid, connected: true, input: { ...s.hid.input, battery: 100, charging: false } },
    }));
    const r = await invoke<{ reports: { data: number[] }[] }>('hid_poll');
    const b = r.reports[0].data[52];
    expect((b >> 4) & 0x0f).toBe(2); // status = complete
    expect(b & 0x0f).toBe(10); // charge = 10 (100/10)
  });
});

describe('mock flash_read emits progress events', () => {
  it('fires read1 then read2 progress events through the event bus', async () => {
    const phases: string[] = [];
    const unlisten = on('flash://progress', (e) => {
      phases.push((e.payload as { phase: string }).phase);
    });
    await invoke('flash_read');
    unlisten();
    expect(phases[0]).toBe('read1');
    expect(phases.filter((p) => p === 'read2').length).toBeGreaterThan(0);
    expect(phases.filter((p) => p === 'read1').length).toBeGreaterThan(0);
  });

  it('returns a FlashReadResult with the serial from state', async () => {
    mockState.update((s) => ({
      ...s,
      flash: { ...s.flash, nvs: { ...s.flash.nvs, serial: 'MOCK12345' } },
    }));
    const r = await invoke<{ archive_path: string; nvs: { serial: string } }>('flash_read');
    expect(r.nvs.serial).toBe('MOCK12345');
    expect(r.archive_path).toContain('MOCK12345');
  });
});

describe('mock no-op commands', () => {
  it('open_path, save_text_file, archive_delete_dump resolve without throwing', async () => {
    await expect(invoke('open_path', { path: '/x' })).resolves.toBeUndefined();
    await expect(invoke('save_text_file', { path: '/x', content: 'hi' })).resolves.toBeUndefined();
    await expect(invoke('archive_delete_dump', { binPath: '/x' })).resolves.toBeUndefined();
  });
});

describe('getMockState', () => {
  it('reflects live edits to the mockState store', () => {
    mockState.update((s) => ({ ...s, uart: { ...s.uart, db_count: 42 } }));
    expect(getMockState().uart.db_count).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Task 13 (#123) — Mock-Parität: output mirroring, canned DS5 feature replies,
// BT transport simulation, HID error injection.
//
// All tests drive behavior through the real mock export surface (`invoke` with
// the snake_case command names + `mockState`/`mockHidRuntime`) instead of the
// brief's sketch names (hidSendOutputReport/hidPoll) — the brief authorizes
// this adaptation; the mock's existing exports are never renamed.
// ---------------------------------------------------------------------------

/** USB output frame exactly as TauriHIDDevice.sendReport hands it to invoke():
 * [report id 0x02][47-byte common payload] → common[k] === frame[k + 1]. */
function usbOutputFrame(): number[] {
  return [0x02, ...new Array<number>(47).fill(0)];
}

describe('mock output mirroring (#123)', () => {
  beforeEach(() => resetMockState());

  it('hid_send_output_report stores the full frame in mockHidRuntime.lastOutputReport', async () => {
    const payload = usbOutputFrame();
    payload[45] = 0xff; // lightbar R — common[44] with the id byte at frame[0]
    await invoke('hid_send_output_report', { data: payload });
    expect(mockHidRuntime.lastOutputReport).not.toBeNull();
    expect(mockHidRuntime.lastOutputReport![0]).toBe(0x02); // id byte preserved
    expect(mockHidRuntime.lastOutputReport![45]).toBe(0xff);
    expect(mockHidRuntime.lastOutputReport).toHaveLength(48);
  });

  it('mirrors the lightbar color into mockHidRuntime.mirroredLightbar', async () => {
    // The mock receives the frame WITH the report-id byte (TauriHIDDevice.
    // sendReport prepends it), so the common payload sits at offset 1 and the
    // RGB bytes land at frame offsets 45-47 (common 44-46, kernel layout).
    const payload = usbOutputFrame();
    payload[45] = 10;
    payload[46] = 20;
    payload[47] = 30;
    await invoke('hid_send_output_report', { data: payload });
    expect(mockHidRuntime.mirroredLightbar).toEqual([10, 20, 30]);
  });

  it('mirrors the lightbar from a BT 0x31 output frame (common at offset 3)', async () => {
    // BT output: [0x31][seq<<4][0x10][47 common][24 pad][4 CRC] → RGB at 47-49.
    // The frame must carry a valid CRC trailer (seed 0xA2,0x31) or the mock —
    // like the real controller — drops it.
    const frame = new Uint8Array(77);
    frame[0] = 0x00;
    frame[1] = 0x10;
    frame[2 + 44] = 1;
    frame[2 + 45] = 2;
    frame[2 + 46] = 3;
    fillOutputReportCrc(frame);
    await invoke('hid_send_output_report', { data: [0x31, ...Array.from(frame)] });
    expect(mockHidRuntime.mirroredLightbar).toEqual([1, 2, 3]);
  });

  it('drops BT output frames with a bad CRC (a real controller ignores them)', async () => {
    const payload = [0x31, 0x00, 0x10, ...new Array<number>(75).fill(0)];
    payload[47] = 9;
    payload[48] = 9;
    payload[49] = 9;
    await invoke('hid_send_output_report', { data: payload }); // CRC trailer left zeroed
    expect(mockHidRuntime.mirroredLightbar).toEqual([0, 0, 0]);
    expect(mockHidRuntime.lastOutputReport).toBeNull();
  });

  it('resetMockState clears the mirror', async () => {
    await invoke('hid_send_output_report', { data: usbOutputFrame() });
    expect(mockHidRuntime.lastOutputReport).not.toBeNull();
    resetMockState();
    expect(mockHidRuntime.lastOutputReport).toBeNull();
    expect(mockHidRuntime.mirroredLightbar).toEqual([0, 0, 0]);
  });
});

describe('canned DS5 feature replies (#123)', () => {
  beforeEach(() => resetMockState());

  it('calibration command 0x82 answers on 0x83 with the big-endian ack rule', async () => {
    // Sticks range BEGIN: cmd [1,1,2] → 0x83010201 (calibrateRangeBegin).
    await invoke('hid_send_feature_report', { reportId: 0x82, data: [1, 1, 2] });
    let out = await invoke<number[]>('hid_receive_feature_report', {
      reportId: 0x83,
      length: 64,
    });
    expect(out.slice(0, 4)).toEqual([0x83, 0x01, 0x02, 0x01]);
    // Sticks range END: cmd [2,1,2] → 0x83010202 (calibrateRangeEnd).
    await invoke('hid_send_feature_report', { reportId: 0x82, data: [2, 1, 2] });
    out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x83, length: 64 });
    expect(out.slice(0, 4)).toEqual([0x83, 0x01, 0x02, 0x02]);
    // Sticks center BEGIN: cmd [1,1,1] → 0x83010101 (calibrateSticksBegin).
    await invoke('hid_send_feature_report', { reportId: 0x82, data: [1, 1, 1] });
    out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x83, length: 64 });
    expect(out.slice(0, 4)).toEqual([0x83, 0x01, 0x01, 0x01]);
    // Sticks center END: cmd [2,1,1] → 0x83010102 (calibrateSticksEnd).
    await invoke('hid_send_feature_report', { reportId: 0x82, data: [2, 1, 1] });
    out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x83, length: 64 });
    expect(out.slice(0, 4)).toEqual([0x83, 0x01, 0x01, 0x02]);
  });

  it('0x80 get-calibration answers a valid module blob (also staged under 0x80)', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x80, data: [1] });
    const out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x80, length: 64 });
    expect(out.length).toBeGreaterThan(10);
    expect(out[0]).toBe(0x80);
  });

  it('0x80 system-info command echoes on 0x81 as [0x81, base, num, 2, …] (getSystemInfo)', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x80, data: [1, 19] }); // serial
    const out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x81, length: 64 });
    expect(out[0]).toBe(0x81);
    expect(out[1]).toBe(1);
    expect(out[2]).toBe(19);
    expect(out[3]).toBe(2);
    // ASCII payload from offset 4 — a plausible mock serial.
    const text = String.fromCharCode(...out.slice(4, 21));
    expect(text).toMatch(/[A-Z0-9-]/);
  });

  it('0x80 NVS-status query [3,3] echoes 0x03030200 (unlocked) on 0x81 (queryNvStatus)', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x80, data: [3, 3] });
    const out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x81, length: 64 });
    const view = new DataView(new Uint8Array(out).buffer);
    expect(view.getUint32(1, false)).toBe(0x03030200); // unlocked, permanent
  });

  it('0x80 module-data query [12,2] echoes 12 u16 values on 0x81 (getInMemoryModuleData)', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x80, data: [12, 2] });
    const out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x81, length: 64 });
    const view = new DataView(new Uint8Array(out).buffer);
    expect(out[0]).toBe(129);
    expect(out[1]).toBe(12);
    expect(out[2]).toBe(2);
    expect(out[3]).toBe(2);
    const values = Array.from({ length: 12 }, (_, i) => view.getUint16(4 + i * 2, true));
    expect(values.every((v) => v >= 0 && v <= 0xffff)).toBe(true);
    expect(values.some((v) => v !== 0)).toBe(true);
  });

  it('0x80 BD-addr query [9,2] echoes six MAC bytes on 0x81 (getBdAddr)', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x80, data: [9, 2] });
    const out = await invoke<number[]>('hid_receive_feature_report', { reportId: 0x81, length: 64 });
    const view = new DataView(new Uint8Array(out).buffer);
    const bytes = [5, 4, 3, 2, 1, 0].map((i) => view.getUint8(4 + i)); // formatMacFromView order
    expect(bytes.every((b) => b !== 0)).toBe(true);
  });

  it('staged replies reset with resetMockState', async () => {
    await invoke('hid_send_feature_report', { reportId: 0x82, data: [1, 1, 1] });
    expect(mockFeatureReplies.size).toBeGreaterThan(0);
    resetMockState();
    expect(mockFeatureReplies.size).toBe(0);
  });
});

describe('mock BT transport simulation (#123)', () => {
  beforeEach(() => resetMockState());

  it('defaults to USB framing (report id 1, 64-byte body)', async () => {
    expect(getMockState().hid.simulateTransport).toBe('usb');
    const r = await invoke<{ reports: { report_id: number; data: number[] }[] }>('hid_poll');
    expect(r.reports[0].report_id).toBe(1);
    expect(r.reports[0].data).toHaveLength(64);
  });

  it('delivers 77-byte 0x31 frames with a valid CRC and cyclic seq in BT mode', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, simulateTransport: 'bt' } }));
    const r = await invoke<{ reports: { report_id: number; data: number[] }[] }>('hid_poll');
    const rep = r.reports[0];
    expect(rep.report_id).toBe(0x31);
    expect(rep.data).toHaveLength(77);
    const raw = new Uint8Array(rep.data);
    // CRC over seed [0xA1,0xB2] must validate — the ControllerManager drops
    // frames that fail validateBtInputCrc (#118).
    expect(validateBtInputCrc(raw)).toBe(true);
    const seq0 = (raw[0] >> 2) & 0x3f;
    const r2 = await invoke<{ reports: { report_id: number; data: number[] }[] }>('hid_poll');
    const seq1 = (new Uint8Array(r2.reports[0].data)[0] >> 2) & 0x3f;
    expect(seq1).toBe((seq0 + 1) & 0x3f);
    // Common payload re-aligns with the USB offsets after dropping the seq
    // byte: battery 75 % → charge nibble 7 at frame offset 1 + 52.
    expect(r2.reports[0].data[53]).toBe(7);
  });

  it('wraps the seq counter cyclically at 64', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, simulateTransport: 'bt' } }));
    const first = await invoke<{ reports: { data: number[] }[] }>('hid_poll');
    const seq0 = (new Uint8Array(first.reports[0].data)[0] >> 2) & 0x3f;
    let seqLast = seq0;
    for (let i = 0; i < 64; i++) {
      const r = await invoke<{ reports: { data: number[] }[] }>('hid_poll');
      seqLast = (new Uint8Array(r.reports[0].data)[0] >> 2) & 0x3f;
    }
    expect(seqLast).toBe(seq0); // 64 further polls → exactly one full cycle
  });

  it('hid_connect remembers the transport from the product id (BT pid 0x0df2)', async () => {
    await invoke('hid_connect', { vendorId: 0x054c, productId: 0x0df2 });
    expect(getMockState().hid.simulateTransport).toBe('bt');
    expect(getMockState().hid.connected).toBe(true);
    await invoke('hid_connect', { vendorId: 0x054c, productId: 0x0ce6 });
    expect(getMockState().hid.simulateTransport).toBe('usb');
  });
});

describe('mock HID error injection (#123)', () => {
  beforeEach(() => resetMockState());

  it('armed hid-write makes hid_send_output_report reject with a Tauri-style string', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, injectErrors: ['hid-write'] } }));
    const err = await invoke('hid_send_output_report', { data: usbOutputFrame() }).then(
      () => null,
      (e) => e
    );
    expect(typeof err).toBe('string');
    expect(err).toContain('HID-Write');
    // Without the arming the command runs normally again.
    mockState.update((s) => ({ ...s, hid: { ...s.hid, injectErrors: [] } }));
    await expect(invoke('hid_send_output_report', { data: usbOutputFrame() })).resolves.toBeUndefined();
  });

  it('armed hid-connect makes hid_connect reject', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, injectErrors: ['hid-connect'] } }));
    const err = await invoke('hid_connect', { vendorId: 0x054c, productId: 0x0ce6 }).then(
      () => null,
      (e) => e
    );
    expect(typeof err).toBe('string');
    expect(err).toContain('HID-Connect');
  });

  it('armed hid-read makes hid_poll reject', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, injectErrors: ['hid-read'] } }));
    const err = await invoke('hid_poll').then(
      () => null,
      (e) => e
    );
    expect(typeof err).toBe('string');
    expect(err).toContain('HID-Read');
  });

  it('injection arming does not leak into other hid commands', async () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, injectErrors: ['hid-read'] } }));
    await expect(invoke('hid_send_output_report', { data: usbOutputFrame() })).resolves.toBeUndefined();
    await expect(
      invoke('hid_send_feature_report', { reportId: 0x82, data: [1, 1, 1] })
    ).resolves.toBeUndefined();
  });
});

describe('mock error injection (#72)', () => {
  it('rejects with the armed message instead of running the handler', async () => {
    mockState.update((s) => ({ ...s, errors: { flash_read: 'Programmer nicht gefunden' } }));
    await expect(invoke('flash_read')).rejects.toThrow('Programmer nicht gefunden');
  });

  it('clears the armed error when the message is removed', async () => {
    mockState.update((s) => ({ ...s, errors: { uart_connect: 'port busy' } }));
    await expect(invoke('uart_connect')).rejects.toThrow('port busy');
    mockState.update((s) => {
      const e = { ...s.errors };
      delete e.uart_connect;
      return { ...s, errors: e };
    });
    await expect(invoke('uart_connect')).resolves.toBeUndefined();
  });

  it('leaves commands without an armed error unaffected', async () => {
    mockState.update((s) => ({ ...s, errors: { flash_read: 'boom' } }));
    const r = await invoke<string[]>('flash_list_programmers');
    expect(Array.isArray(r)).toBe(true);
  });
});
