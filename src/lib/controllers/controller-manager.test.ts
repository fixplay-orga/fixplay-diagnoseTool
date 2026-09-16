import { describe, it, expect } from 'vitest';
import { applyDeadzone, btSeqGapLoss } from './controller-manager';

/**
 * Unit tests for the radial stick deadzone (#124). The function is pure and
 * only used for the on-screen visualizer — protocol writes must never see it.
 */
describe('applyDeadzone (#124)', () => {
  it('returns the input unchanged for dz = 0 (slider default)', () => {
    expect(applyDeadzone(0.35, -0.2, 0)).toEqual({ x: 0.35, y: -0.2 });
    expect(applyDeadzone(0, 0, 0)).toEqual({ x: 0, y: 0 });
  });

  it('returns the input unchanged for a negative dz (clamped to "off")', () => {
    expect(applyDeadzone(0.3, 0.4, -5)).toEqual({ x: 0.3, y: 0.4 });
  });

  it('zeroes pairs below the threshold radius (dz percent → 0..1 fraction)', () => {
    // dz = 10 % → threshold radius 0.1; |(0.05, 0)| = 0.05 < 0.1 → zeroed.
    expect(applyDeadzone(0.05, 0, 10)).toEqual({ x: 0, y: 0 });
    // dz = 20 % → threshold 0.2; a small diagonal below it is zeroed too.
    expect(applyDeadzone(0.1, 0.1, 20)).toEqual({ x: 0, y: 0 });
  });

  it('keeps pairs at or above the threshold unchanged (strict <, no rescale)', () => {
    // Exactly on the threshold is not "below" it.
    expect(applyDeadzone(0.1, 0, 10)).toEqual({ x: 0.1, y: 0 });
    // Just above the threshold — passed through unchanged (the visualizer dot
    // keeps its true deflection; only the dead inner region collapses).
    expect(applyDeadzone(0.11, 0, 10)).toEqual({ x: 0.11, y: 0 });
    expect(applyDeadzone(-0.8, 0.6, 20)).toEqual({ x: -0.8, y: 0.6 }); // r = 1.0
  });

  it('works on both axes symmetrically (radial, not per-axis)', () => {
    // |(0, 0.08)| < 0.1 → zeroed, even though the y value alone might look
    // "usable" to a per-axis filter.
    expect(applyDeadzone(0, 0.08, 10)).toEqual({ x: 0, y: 0 });
  });
});

/**
 * BT input seq-gap loss counting (final-review M1): consecutive frames count
 * 0, a forward jump counts gap - 1, and an implausibly large mod-64 gap
 * (≥ 32 = half the window — what a reordered/duplicated frame pair reads as)
 * must NOT be counted as phantom losses.
 */
describe('btSeqGapLoss (#M1 — BT seq-gap resync)', () => {
  it('counts 0 for consecutive and duplicate frames', () => {
    expect(btSeqGapLoss(5, 6)).toBe(0);
    expect(btSeqGapLoss(5, 5)).toBe(0); // duplicate
  });

  it('counts gap - 1 losses for a plausible forward jump', () => {
    expect(btSeqGapLoss(5, 8)).toBe(2);
    // Just below the resync threshold: gap 31 = worst case still counted.
    expect(btSeqGapLoss(5, 36)).toBe(30);
  });

  it('treats a backward step as a resync (no phantom losses)', () => {
    // 5 → 4 mod 64 reads as gap 63 — a duplicate/reordered frame, not 62 losses.
    expect(btSeqGapLoss(5, 4)).toBe(0);
  });

  it('treats a forward jump ≥ 32 as a resync (half the window)', () => {
    expect(btSeqGapLoss(5, 37)).toBe(0); // gap 32
    expect(btSeqGapLoss(0, 33)).toBe(0); // gap 33
    expect(btSeqGapLoss(1, 0)).toBe(0); // gap 63 (max — reads as a backward step)
  });
});
