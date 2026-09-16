import { describe, it, expect } from 'vitest';
import { validateBtInputCrc, fillBtInputCrc } from './crc32';

// BT input framing (#118): payload after the (already-stripped) report id is
// [seq, …body…, CRC32-LE]; the CRC is computed over the payload minus the
// 4 trailer bytes with seed [0xA1, 0xB2] (kernel hid-playstation.c:
// dualsense_input_report_bt). seq lives in the upper 6 bits of payload[0].
describe('BT input CRC (#118)', () => {
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
});