// Mock replacement for '@tauri-apps/api/core'.
// Returns fake data for every command the frontend invokes, so the UI can be
// exercised in a plain browser without the Tauri Rust backend or hardware.
// Only active in MOCK mode via the vite alias; the Tauri build is unaffected.
//
// Every fake value is read from the reactive `mockState` store (./state.ts) so
// the MockPanel can change it at runtime — edits apply to the next invoke().
import { emitLocal, delay, settingsStore } from './_shared';
import { mockState, getMockState, mockHidRuntime, mockFeatureReplies } from './state';
import type { MockControllerInput, HidErrorInjectable } from './state';
import { fillBtInputCrc, crc32 } from '../controllers/crc32';
import type {
  DeviceInfo,
  FlashReadResult,
  SerialArchive,
  ErrorSearchResult,
  FlashPreviewResult,
  AppSettings,
  UartPortInfo,
  UartPollResult,
  I2cPortInfo,
  I2cErrlogEntry,
  I2cInfo,
  I2cPollResult,
  I2cErrorSearchResult,
} from '../api/types';
import type { HidDeviceInfo, HidPollResult, HidDiagnostics } from '../controllers/tauri-hid-device';

const warn = (cmd: string) =>
  console.warn(`[mock] invoke('${cmd}') has no fake handler — returning undefined`);

/**
 * Build a 64-byte DualSense USB input-report body (report id stripped) from the
 * simulated controller state, mirroring the byte layout the real DS5 emits and
 * the ControllerManager parses: sticks @0-3, L2/R2 @4/5, dpad+face @7,
 * shoulder/misc @8, ps/touch/mute @9, battery @52.
 */
function buildDs5InputReport(input: MockControllerInput): number[] {
  const r = new Array<number>(64).fill(0);
  const axis = (v: number) => Math.round(((Math.max(-1, Math.min(1, v)) + 1) / 2) * 255);
  r[0] = axis(input.lx);
  r[1] = axis(input.ly);
  r[2] = axis(input.rx);
  r[3] = axis(input.ry);
  r[4] = Math.max(0, Math.min(255, Math.round(input.l2)));
  r[5] = Math.max(0, Math.min(255, Math.round(input.r2)));

  const b = input.buttons;
  // D-pad hat (low nibble of byte 7): 0=U 1=UR 2=R 3=DR 4=D 5=DL 6=L 7=UL 8=neutral
  const up = !!b.up;
  const down = !!b.down;
  const left = !!b.left;
  const right = !!b.right;
  let hat = 8;
  if (up && left) hat = 7;
  else if (up && right) hat = 1;
  else if (down && left) hat = 5;
  else if (down && right) hat = 3;
  else if (up) hat = 0;
  else if (right) hat = 2;
  else if (down) hat = 4;
  else if (left) hat = 6;
  r[7] =
    hat |
    (b.square ? 0x10 : 0) |
    (b.cross ? 0x20 : 0) |
    (b.circle ? 0x40 : 0) |
    (b.triangle ? 0x80 : 0);

  r[8] =
    (b.l1 ? 0x01 : 0) |
    (b.r1 ? 0x02 : 0) |
    (b.create ? 0x10 : 0) |
    (b.options ? 0x20 : 0) |
    (b.l3 ? 0x40 : 0) |
    (b.r3 ? 0x80 : 0);

  r[9] = (b.ps ? 0x01 : 0) | (b.touchpad ? 0x02 : 0) | (b.mute ? 0x04 : 0);

  // Battery @52: status<<4 | charge. status 0=discharge, 1=charging, 2=complete.
  const charge = Math.max(0, Math.min(10, Math.floor(input.battery / 10)));
  let status = 0;
  if (input.battery >= 100) status = 2;
  else if (input.charging) status = 1;
  r[52] = (status << 4) | charge;

  // IMU at rest (#56): accel Z = 1 g (8192 raw = 0x2000, little-endian at
  // struct offset 25 → low byte 25, high byte 26) so the dev-mode IMU
  // visualizer shows a realistic rest state instead of zeros.
  r[25] = 0x00;
  r[26] = 0x20;

  // Touchpad touch points (#57): two 4-byte points at touchpad offset 32.
  // Layout (mirrors ControllerManager._parseTouchPoints): byte0 = active flag
  // (bit7 set = NOT active) | finger id (low 7 bits); byte1 = x low;
  // byte2 = (x high nibble) | (y high nibble << 4); byte3 = y low.
  // x: 0..1919 (12-bit), y: 0..1079 (pad is 1920×1080, #125).
  const tp = input.touchPoints ?? [];
  for (let i = 0; i < 2; i++) {
    const p = tp[i] ?? { active: false, x: 0, y: 0 };
    const base = 32 + i * 4;
    const cx = Math.max(0, Math.min(1919, Math.round(p.x)));
    const cy = Math.max(0, Math.min(1079, Math.round(p.y)));
    r[base] = (p.active ? 0x00 : 0x80) | (i & 0x7f);
    r[base + 1] = cx & 0xff;
    r[base + 2] = ((cx >> 8) & 0x0f) | ((cy >> 4) & 0xf0);
    r[base + 3] = cy & 0xff;
  }

  return r;
}

// --- DS5 mock-parity helpers (#123) -----------------------------------------

const HID_INJECT_MESSAGES: Record<HidErrorInjectable, string> = {
  'hid-write': 'HID-Write fehlgeschlagen: Mock-Fehler-Injektion aktiv (hid-write)',
  'hid-connect': 'HID-Connect fehlgeschlagen: Mock-Fehler-Injektion aktiv (hid-connect)',
  'hid-read': 'HID-Read fehlgeschlagen: Mock-Fehler-Injektion aktiv (hid-read)',
};

/** Reject like a failed Tauri command while the MockPanel armed `what` (#123,
 * #126 hardware-validation rehearsal). The rejection is a plain string, the
 * same shape Tauri's `invoke` produces for `Result<T, String>` errors. */
function assertHidInjectable(what: HidErrorInjectable): void {
  if (getMockState().hid.injectErrors.includes(what)) {
    throw HID_INJECT_MESSAGES[what];
  }
}

/**
 * Extract the lightbar RGB from an output-report frame exactly as
 * `hid_send_output_report` receives it — with the report-id byte at index 0
 * (TauriHIDDevice.sendReport prepends it):
 *
 *   - USB (0x02): [id][47-byte common payload] → common[k] = frame[k + 1], so
 *     the RGB bytes sit at frame offsets 45-47 (common 44-46, kernel
 *     dualsense_output_report_usb layout; player LEDs @ common 43).
 *   - BT (0x31):  [id][seq<<4][0x10][47 common][24 pad][4 CRC] → RGB at 47-49.
 *
 * Returns null for unknown report ids / too-short frames — the mirror keeps
 * its previous value in that case.
 */
function extractLightbar(data: number[]): [number, number, number] | null {
  const commonOff = data[0] === 0x02 ? 1 : data[0] === 0x31 ? 3 : null;
  if (commonOff === null) return null;
  const off = commonOff + 44;
  if (data.length < off + 3) return null;
  return [data[off], data[off + 1], data[off + 2]];
}

/** Validate the CRC32 trailer of a BT output frame `[0x31, seq, 0x10, …,
 * CRC-LE]` (seed [0xA2, 0x31] over the frame minus id byte and 4 trailer
 * bytes — fillOutputReportCrc framing). A real controller silently drops
 * CRC-corrupt frames; the mock mirrors that (#123). */
function btOutputCrcValid(data: number[]): boolean {
  const end = data.length - 4;
  if (end <= 1) return false;
  const got =
    (data[end] | (data[end + 1] << 8) | (data[end + 2] << 16) | (data[end + 3] << 24)) >>> 0;
  return crc32(new Uint8Array(data.slice(1, end)), [0xa2, 0x31]) === got;
}

/**
 * Build a 77-byte BT input payload exactly as the Rust HID layer would deliver
 * it after stripping the report id (#123): `[seq<<2, …body…, CRC32-LE]`, CRC
 * over seed [0xA1, 0x31] via fillBtInputCrc (validateBtInputCrc framing — the
 * seq lives in the top 6 bits of byte 0 — the receiver reads
 * `(raw[0] >> 2) & 0x3f` and counts cyclic mod 64. The 64-byte USB body is
 * placed at offset 1 so every common offset (sticks @0-3, battery @52, …)
 * re-aligns once the ControllerManager drops the seq byte (BT common starts at
 * data[1], controller-manager.ts). Cyclic seq++ mod 64 per report.
 */
function buildBtInputFrame(input: MockControllerInput): number[] {
  const frame = new Uint8Array(77);
  frame[0] = (mockHidRuntime.btInputSeq & 0x3f) << 2;
  mockHidRuntime.btInputSeq = (mockHidRuntime.btInputSeq + 1) & 0x3f;
  frame.set(buildDs5InputReport(input), 1);
  fillBtInputCrc(frame);
  return Array.from(frame);
}

function padTo64(bytes: number[]): number[] {
  const out = bytes.slice(0, 64);
  while (out.length < 64) out.push(0);
  return out;
}

/** Mock serial for the system-info family: slice(4,6) = "ZB" so ds5Color()
 * resolves a known color code. */
const MOCK_SYSTEM_INFO = 'XXXXZB0001-MOCK01';
const MOCK_BD_ADDR = [0xa4, 0xb5, 0xc6, 0xd7, 0xe8, 0xf9];
/** In-memory module blob: 12 u16 stick-calibration values (center-ish). */
const MOCK_MODULE_DATA = [0x0400, 0x0400, 0x0800, 0x0800, 0x0c00, 0x0c00, 0, 0, 0, 0, 0, 0];

/**
 * Canned, protocol-correct DS5 device-info reply for feature report 0x20
 * (final-review I2). Byte layout mirrors every offset ds5-controller's
 * `_getInfo` parses from the 64-byte GET_REPORT(0x20) reply:
 *
 *   [0]      reply id 0x20 (validation gate: `cmd != 0x20` → ok:false)
 *   [1..12]  build date  (11 bytes ASCII — must NOT contain " 2020"/" 2021",
 *            which would set disable_bits |= 2)
 *   [12..20] build time  (8 bytes)
 *   [20]     fw type     u16 LE   (0x0001)
 *   [22]     fw series   u16 LE   (0x0019)
 *   [24]     hw info     u32 LE   (byte 2 = 0x05 → Board Model "BDM-030")
 *   [28]     fw version  u32 LE
 *   [44]     fw update   u16 LE   (0x0100)
 *   [46]     fw update info u8
 *   [48]     SBL fw version   u32 LE
 *   [52]     Venom fw version u32 LE
 *   [56]     Spider fw version u32 LE
 *
 * The legacy `i % 256` ramp dummy failed the [0] gate, so every MOCK=1
 * connect threw "Info-Abruf fehlgeschlagen" and snapshotCalibration() never
 * ran ("Verwerfen" stayed disabled). Module-level constant — deliberately not
 * routed through `mockFeatureReplies`/`resetMockState`, so the connect flow
 * survives a mock-state reset like the ramp dummy did.
 */
const MOCK_DEVICE_INFO = (() => {
  const r = new Array<number>(64).fill(0);
  r[0] = 0x20;
  const date = '2024-05-20 '; // 11 bytes incl. pad
  const time = '08:07:59'; // 8 bytes
  for (let i = 0; i < 11; i++) r[1 + i] = date.charCodeAt(i);
  for (let i = 0; i < 8; i++) r[12 + i] = time.charCodeAt(i);
  const set16 = (off: number, v: number) => {
    r[off] = v & 0xff;
    r[off + 1] = (v >> 8) & 0xff;
  };
  const set32 = (off: number, v: number) => {
    r[off] = v & 0xff;
    r[off + 1] = (v >> 8) & 0xff;
    r[off + 2] = (v >> 16) & 0xff;
    r[off + 3] = (v >> 24) & 0xff;
  };
  set16(20, 0x0001); // fw type
  set16(22, 0x0019); // fw series (25)
  set32(24, 0x00050000); // hw info → BDM-030
  set32(28, 0x03260104); // fw version
  set16(44, 0x0100); // fw update version
  r[46] = 0x00; // fw update info
  set32(48, 0x00010001); // SBL fw version
  set32(52, 0x00000000); // Venom fw version
  set32(56, 0x00000000); // Spider fw version
  return r;
})();

/**
 * Fill `mockFeatureReplies` the way a real DS5 answers the feature protocol
 * (#123), so calibration / NVS / info flows run end-to-end in mock mode:
 *
 *   - calibration command family (0x82/0x83): reply staged on 0x83 with the
 *     verified big-endian rule `[0x83, 1, cmd[2], cmd[0] === 2 ? 2 : 1]`
 *     (calibrateSticks/Range begin+end each check getUint32(0, false)).
 *   - 0x80 family: the real flows read the reply back on 0x81 — getSystemInfo
 *     ([base,num]), NVS status ([3,3] → 0x03030200 unlocked/permanent), BD
 *     addr ([9,2]), module data ([12,2]) — so an echo
 *     `[0x81, cmd[0], cmd[1], 2, …payload]` satisfies every check. A 0x80
 *     blob is additionally staged for direct receive(0x80) reads (the task
 *     brief's mock-parity contract; no real flow reads 0x80 back).
 *   - calibration data writes (cmd[0] === 0x08) are fire-and-forget: accepted,
 *     no reply staged.
 */
function stageDs5FeatureReply(reportId: number, data: number[]): void {
  const buf = data;
  switch (reportId) {
    case 0x80: {
      if (buf[0] === 0x08) return; // calibration data write — accepted, no reply
      const reply = padTo64([0x81, buf[0] ?? 0, buf[1] ?? 0, 2]);
      if (buf[0] === 9) {
        // BD addr: formatMacFromView(data, 4) reads 6 bytes from offset 4.
        MOCK_BD_ADDR.forEach((b, i) => {
          reply[4 + i] = b;
        });
      } else if (buf[0] === 12) {
        // In-memory module data: 12 u16 LE values from offset 4.
        MOCK_MODULE_DATA.forEach((v, i) => {
          reply[4 + i * 2] = v & 0xff;
          reply[5 + i * 2] = (v >> 8) & 0xff;
        });
      } else if (buf[0] === 1 || buf[0] === 5) {
        // System-info family: ASCII payload, space-padded to the buffer end.
        for (let i = 4; i < 64; i++) reply[i] = 0x20;
        for (let i = 0; i < MOCK_SYSTEM_INFO.length; i++) {
          reply[4 + i] = MOCK_SYSTEM_INFO.charCodeAt(i);
        }
      }
      mockFeatureReplies.set(0x81, reply);
      const blob = reply.slice();
      blob[0] = 0x80;
      mockFeatureReplies.set(0x80, blob);
      return;
    }
    case 0x82:
    case 0x83: {
      // Calibration command ack — big-endian value in the 0x83 get.
      mockFeatureReplies.set(0x83, padTo64([0x83, 1, buf[2] ?? 0, buf[0] === 2 ? 2 : 1]));
      return;
    }
    default:
      // 0x90 (NVS unlock/lock) family etc. — no canned reply path exists in
      // the mock, so the legacy dummy pattern is returned by receive().
      return;
  }
}

async function flashReadSequence(): Promise<FlashReadResult> {
  const s = getMockState();
  // Simulate the read1 / read2 progress events the real backend emits.
  for (let pct = 0; pct <= 100; pct += 10) {
    emitLocal('flash://progress', { phase: 'read1', percent: pct });
    await delay(s.flash.read_step_ms);
  }
  for (let pct = 0; pct <= 100; pct += 10) {
    emitLocal('flash://progress', { phase: 'read2', percent: pct });
    await delay(s.flash.read_step_ms);
  }
  const serial = s.flash.nvs.serial;
  const result: FlashReadResult = {
    dumps_match: s.flash.dumps_match,
    validation: { ...s.flash.validation },
    nvs: { ...s.flash.nvs },
    archive_path: `/mock/archive/${serial}/2026-07-01_read.bin`,
  };
  emitLocal('flash://status', {
    message: 'NOR-Dump erfolgreich gelesen und archiviert.',
    level: 'info',
  });
  emitLocal('flash://result', result);
  return result;
}

async function flashWriteSequence(): Promise<void> {
  const s = getMockState();
  for (let pct = 0; pct <= 100; pct += 10) {
    emitLocal('flash://progress', { phase: 'write', percent: pct });
    await delay(s.flash.write_step_ms);
  }
  emitLocal('flash://status', {
    message: 'Schreiben abgeschlossen, starte Verify …',
    level: 'info',
  });
  for (let pct = 0; pct <= 100; pct += 10) {
    emitLocal('flash://progress', { phase: 'verify', percent: pct });
    await delay(s.flash.verify_step_ms);
  }
  emitLocal('flash://status', {
    message: 'Verify OK — NOR erfolgreich beschrieben.',
    level: 'info',
  });
}

const handlers: Record<string, (args: Record<string, unknown>) => Promise<unknown> | unknown> = {
  // --- flash ---
  scan_devices: () => {
    const s = getMockState();
    return <DeviceInfo[]>s.flash.devices;
  },
  flash_list_programmers: () => {
    const s = getMockState();
    return <string[]>s.flash.programmers;
  },
  flash_read: () => flashReadSequence(),
  flash_write: () => flashWriteSequence(),
  flash_validate_file: (args) => {
    const s = getMockState();
    return <FlashPreviewResult>{
      path: String(args?.path ?? '/mock/dump.bin'),
      size_bytes: 2 * 1024 * 1024,
      validation: { ...s.flash.validation },
      nvs: { ...s.flash.nvs },
    };
  },
  open_path: (args) => {
    console.log(`[mock] open_path(${args?.path}) — no-op in browser`);
  },
  save_text_file: (args) => {
    const len = (args?.content as string | undefined)?.length ?? 0;
    console.log(`[mock] save_text_file(${args?.path}, ${len} bytes) — no-op in browser`);
  },
  app_data_dir_path: () => {
    return '/mock/app-data';
  },

  // --- archive ---
  archive_list_dumps: () => {
    const s = getMockState();
    return <SerialArchive[]>s.flash.archive;
  },
  archive_delete_dump: (args) => {
    console.log(`[mock] archive_delete_dump(${args?.binPath}) — no-op in browser`);
  },
  flash_free_disk_space: () => {
    // Mock: 12 GiB free of a 256 GiB volume — plenty for NOR dumps.
    return { free_bytes: 12 * 1024 * 1024 * 1024, total_bytes: 256 * 1024 * 1024 * 1024 };
  },

  // --- uart ---
  uart_list_ports: () => {
    const s = getMockState();
    return <UartPortInfo[]>s.uart.ports;
  },
  uart_connect: async () => {
    await delay(150);
  },
  uart_disconnect: () => {},
  uart_send_errlog: async () => {
    await delay(120);
    emitLocal('uart://status', { message: 'errlog gesendet', level: 'info' });
  },
  uart_send_version: async () => {
    await delay(120);
  },
  uart_send_raw: async (args) => {
    // Mock raw terminal: echo the sent line back as a received line so the
    // terminal shows the round-trip in dev mode (real devices mirror input).
    await delay(60);
    const line = String(args?.line ?? '');
    if (line) {
      emitLocal('uart://status', { message: `↩ ${line}`, level: 'info' });
    }
  },
  uart_clear_errlog: () => {},
  uart_set_auto_poll: () => {},
  uart_set_auto_reconnect: () => {},
  uart_update_error_db: async () => {
    await delay(400);
    emitLocal('uart://db-status', { count: 1280, status: 'cached' });
    return 1280;
  },
  uart_get_db_info: () => {
    const s = getMockState();
    return <number | null>s.uart.db_count;
  },
  uart_poll: () => {
    const s = getMockState();
    return <UartPollResult>{
      connected: s.uart.connected,
      reconnecting: s.uart.reconnecting,
      lines: [...s.uart.lines],
      entries: s.uart.entries.map((e) => ({ ...e, entry: { ...e.entry } })),
      db_count: s.uart.db_count,
      dropped_lines: 0,
    };
  },
  uart_loopback_test: async () => {
    await delay(200);
    return getMockState().uart.loopback_ok;
  },
  uart_search_error_db: (args) => {
    const s = getMockState();
    const query = String(args?.query ?? '');
    return <ErrorSearchResult[]>s.uart.search_results.map((r) => ({
      ...r,
      description: r.description.replace('{query}', query),
    }));
  },

  // --- settings ---
  settings_get: () => ({ ...settingsStore }) as AppSettings,
  settings_save: (args) => {
    Object.assign(settingsStore, args?.settings);
  },

  // --- hid / controller ---
  hid_connect: async (args) => {
    assertHidInjectable('hid-connect');
    await delay(100);
    console.log(`[mock] hid_connect(vid=${args?.vendorId}, pid=${args?.productId})`);
    // Remember the transport the way a real connection presents it (#123):
    // BT pid 0x0df2 delivers 0x31 input frames, the USB pids 0x01/0x02.
    const transport = Number(args?.productId) === 0x0df2 ? 'bt' : 'usb';
    mockState.update((s) => ({
      ...s,
      hid: { ...s.hid, connected: true, simulateTransport: transport },
    }));
  },
  hid_disconnect: () => {
    mockState.update((s) => ({ ...s, hid: { ...s.hid, connected: false } }));
  },
  hid_list_devices: () => {
    const s = getMockState();
    return <HidDeviceInfo[]>s.hid.devices;
  },
  hid_send_feature_report: (args) => {
    const reportId = Number(args?.reportId ?? 0);
    const data = (args?.data as number[] | undefined) ?? [];
    stageDs5FeatureReply(reportId, data);
    // void, like the Rust command boundary (Result<(), String>).
  },
  hid_receive_feature_report: (args) => {
    const reportId = Number(args?.reportId ?? 0);
    const len = Number(args?.length ?? 64);
    // Device-info GET_REPORT(0x20): a real DS5 answers directly (no preceding
    // send), so the canned reply is served here — not via stageDs5FeatureReply
    // (final-review I2: _getInfo's ok-gate made the legacy ramp dummy fail
    // every MOCK connect).
    if (reportId === 0x20) {
      return MOCK_DEVICE_INFO.slice(0, len);
    }
    const staged = mockFeatureReplies.get(reportId);
    if (staged) {
      const out = staged.slice(0, len);
      while (out.length < len) out.push(0);
      return out;
    }
    return Array.from({ length: len }, (_, i) => i % 256);
  },
  hid_send_output_report: (args) => {
    const data = (args?.data as number[] | undefined) ?? [];
    if (getMockState().hid.injectErrors.includes('hid-write')) {
      // Diagnostics parity (#124): the Rust layer counts a failed write in
      // write_errors and records last_write_error.
      mockHidRuntime.writeErrors += 1;
      mockHidRuntime.lastWriteError = HID_INJECT_MESSAGES['hid-write'];
      throw HID_INJECT_MESSAGES['hid-write'];
    }
    // A write was issued to the transport — counted even if the controller
    // drops the frame afterwards (a CRC-invalid BT frame is dropped by the
    // device, which is not a host-side write failure).
    mockHidRuntime.writeCount += 1;
    // BT output frames: a real controller silently drops CRC-corrupt frames.
    if (data[0] === 0x31 && !btOutputCrcValid(data)) return;
    // Mirror the DS5 output report (report id 0x02, 47-byte common payload)
    // so tests can assert protocol behavior without hardware (#123).
    mockHidRuntime.lastOutputReport = [...data];
    const lightbar = extractLightbar(data);
    if (lightbar) mockHidRuntime.mirroredLightbar = lightbar;
  },
  hid_poll: () => {
    assertHidInjectable('hid-read');
    const s = getMockState();
    if (!s.hid.connected) {
      return <HidPollResult>{ connected: false, reports: [], dropped_reports: 0 };
    }
    if (s.hid.simulateTransport === 'bt') {
      return <HidPollResult>{
        connected: true,
        reports: [{ report_id: 0x31, data: buildBtInputFrame(s.hid.input) }],
        dropped_reports: 0,
      };
    }
    return <HidPollResult>{
      connected: true,
      reports: [{ report_id: 1, data: buildDs5InputReport(s.hid.input) }],
      dropped_reports: 0,
    };
  },
  // Diagnostics read (#124): same shape as the Rust `HidDiagnostics`. The
  // write counters live in mockHidRuntime (see state.ts); connected/open_path
  // mirror the persisted mock connection + the (only) mock device's path.
  hid_diagnostics: () => {
    const s = getMockState();
    return <HidDiagnostics>{
      connected: s.hid.connected,
      open_path: s.hid.connected ? (s.hid.devices[0]?.path ?? null) : null,
      write_count: mockHidRuntime.writeCount,
      write_errors: mockHidRuntime.writeErrors,
      dropped_reports: mockHidRuntime.droppedReports,
      last_write_error: mockHidRuntime.lastWriteError,
    };
  },

  // --- i2c / Pico bridge / Xbox error-DB ---
  i2c_list_ports: () => {
    const s = getMockState();
    return <I2cPortInfo[]>s.i2c.ports;
  },
  i2c_connect: async () => {
    await delay(120);
  },
  i2c_disconnect: () => {},
  i2c_scan: () => {
    const s = getMockState();
    return <number[]>[...s.i2c.scan_results];
  },
  i2c_read: (args) => {
    const len = Number(args?.len ?? 16);
    return <number[]>Array.from({ length: len }, (_, i) => (i % 17 === 0 ? 0xff : i & 0xff));
  },
  i2c_write: () => {},
  i2c_read_eeprom: (args) => {
    const len = Number(args?.len ?? 256);
    return <number[]>Array.from({ length: len }, (_, i) => (i * 7 + 3) & 0xff);
  },
  i2c_errlog: () => {
    const s = getMockState();
    return <I2cErrlogEntry[]>s.i2c.errlog.map((e) => ({ ...e }));
  },
  i2c_info: () => {
    const s = getMockState();
    return <I2cInfo | null>(s.i2c.info ? { ...s.i2c.info } : null);
  },
  i2c_poll: () => {
    const s = getMockState();
    return <I2cPollResult>{
      connected: s.i2c.connected,
      db_count: s.i2c.db_count,
    };
  },
  i2c_update_xbox_db: async () => {
    await delay(400);
    emitLocal('i2c://db-status', { count: 960, status: 'cached' });
    return 960;
  },
  i2c_get_db_info: () => {
    const s = getMockState();
    return <number | null>s.i2c.db_count;
  },
  i2c_search_xbox_db: (args) => {
    const s = getMockState();
    const query = String(args?.query ?? '');
    return <I2cErrorSearchResult[]>s.i2c.search_results.map((r) => ({
      ...r,
      description: r.description.replace('{query}', query),
    }));
  },
};

/** Drop-in replacement for Tauri's `invoke`. */
export async function invoke<T = unknown>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  // Error injection: if the MockPanel armed an error for this command, reject
  // with the configured message so the UI's error handling is exercised.
  const err = getMockState().errors[cmd];
  if (err) {
    throw new Error(err);
  }
  const handler = handlers[cmd];
  if (!handler) {
    warn(cmd);
    return undefined as T;
  }
  const result = await handler(args ?? {});
  return result as T;
}
