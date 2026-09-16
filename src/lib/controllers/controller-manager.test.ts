import { describe, it, expect } from 'vitest';
import { applyDeadzone } from './controller-manager';

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
