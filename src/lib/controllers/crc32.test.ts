import { describe, it, expect } from 'vitest';
import { validateBtInputCrc, fillBtInputCrc, crc32 } from './crc32';

// BT input framing (#118, final-review C1): payload after the (already-stripped)
// report id is [seq, …body…, CRC32-LE]; the CRC is computed over the payload
// minus the 4 trailer bytes with seed [0xA1, 0x31]. The kernel
// (hid-playstation.c, dualsense_parse_report) CRCs the ENTIRE wire frame —
// including the 0x31 report-id byte — with the single seed byte 0xA1
// (PS_INPUT_CRC32_SEED); after the Rust layer strips the id, the equivalent
// prefix over the stripped payload is [0xA1, 0x31]. seq lives in the upper
// 6 bits of payload[0].
describe('BT input CRC (#118, C1)', () => {
  it('accepts a frame with a correct CRC trailer', () => {
    const frame = new Uint8Array(77);
    frame[0] = 0x10 << 2; // seq 0x10 in den oberen 6 Bit
    frame[1] = 0xff;
    fillBtInputCrc(frame);
    expect(validateBtInputCrc(frame)).toBe(true);
  });

  it('rejects a corrupted frame and a too-short frame', () => {
    const frame = new Uint8Array(77);
    fillBtInputCrc(frame);
    frame[5] ^= 0xff;
    expect(validateBtInputCrc(frame)).toBe(false);
    expect(validateBtInputCrc(new Uint8Array(10))).toBe(false);
  });

  it('pins the [0xA1, 0x31] seed against an independently computed CRC (C1)', () => {
    const frame = new Uint8Array(77);
    frame[0] = 0x10 << 2;
    frame[1] = 0xff;
    fillBtInputCrc(frame);
    const got = frame[73] | (frame[74] << 8) | (frame[75] << 16) | ((frame[76] << 24) >>> 0);
    // 0x1b0f01ac = crc32([0xA1, 0x31] ++ frame[0..73]) — computed independently
    // from the CRC table (0xEDB88320 reflected). The previous (wrong) second
    // seed byte 0xB2 yields 0x92480a07 for the same frame — a value no real
    // DualSense ever emits (kernel/RPCS3/daidr all use the report id byte).
    expect(got).toBe(0x1b0f01ac);
  });

  it('matches the kernel wire-frame convention: seed 0xA1 over the frame INCLUDING the 0x31 report id', () => {
    // The kernel validates BT input frames as crc32([0xA1] ++ full wire frame
    // [0x31, seq, …body…]) — the Rust layer strips the id byte, which makes the
    // equivalent stripped-buffer prefix [0xA1, 0x31]. This test pins the
    // identity so a future prefix change cannot silently break real hardware.
    const frame = new Uint8Array(77);
    frame[0] = 0x2a << 2;
    frame[3] = 0x7f;
    fillBtInputCrc(frame);
    const wire = new Uint8Array(78);
    wire[0] = 0x31; // DS5_BT_INPUT_REPORT_ID, re-prepended
    wire.set(frame.subarray(0, 73), 1);
    const trailer = frame[73] | (frame[74] << 8) | (frame[75] << 16) | ((frame[76] << 24) >>> 0);
    expect(crc32(wire.subarray(0, 74), [0xa1])).toBe(trailer >>> 0);
  });

  it('throws RangeError for frames shorter than 5 bytes instead of corrupting the head', () => {
    // Pre-fix, end = length - 4 went negative and the trailer writes landed on
    // real head bytes (length 3 overwrites bytes 0-2 with CRC bytes 1-3, …).
    for (const len of [0, 1, 2, 3, 4]) {
      const frame = new Uint8Array(len);
      frame[0] = 0x40; // observable pre-fix corruption marker
      expect(() => fillBtInputCrc(frame)).toThrow(RangeError);
    }
    // First clean length: 5 bytes → CRC at 1..4, byte 0 untouched.
    const frame = new Uint8Array(5);
    frame[0] = 0x40;
    fillBtInputCrc(frame);
    const expected = crc32(frame.subarray(0, 1), [0xa1, 0x31]);
    const got = frame[1] | (frame[2] << 8) | (frame[3] << 16) | (frame[4] << 24);
    expect(got >>> 0).toBe(expected);
    expect(frame[0]).toBe(0x40);
  });
});
