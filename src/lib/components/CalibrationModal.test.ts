// @vitest-environment jsdom
import { render, screen, act, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import CalibrationModal from './CalibrationModal.svelte';
import { initI18n } from '$lib/i18n/init';

/**
 * Tests for the before/after finetune comparison (#48). The modal auto-starts
 * center calibration on open via a `$effect`; a fake manager resolves every
 * calibration call and serves canned finetune data (a "before" snapshot then a
 * changed "after" snapshot) so the diff table renders without real hardware.
 */
beforeEach(() => {
  document.body.innerHTML = '';
  // CalibrationModal renders all labels via the reactive i18n store (`$LL`),
  // so the locales must be loaded before render. Idempotent.
  initI18n();
  // StickVisualizer renders to a <canvas>; jsdom has no 2D context, so its
  // $effect logs a harmless "Not implemented: getContext" warning. Stub a
  // minimal 2D context (with the methods StickVisualizer actually calls) so
  // the test output stays clean.
  const stubCtx = {
    setTransform() {},
    clearRect() {},
    save() {},
    restore() {},
    translate() {},
    scale() {},
    rotate() {},
    beginPath() {},
    arc() {},
    ellipse() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    stroke() {},
    fill() {},
    fillRect() {},
    strokeRect() {},
    fillText() {},
    strokeText() {},
    measureText: () => ({ width: 0 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
  } as unknown as CanvasRenderingContext2D;
  HTMLCanvasElement.prototype.getContext = (() =>
    stubCtx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

function makeManager(before: number[], after: number[]) {
  let calls = 0;
  return {
    calibrateSticksBegin: vi.fn(async () => {}),
    calibrateSticksSample: vi.fn(async () => {}),
    calibrateSticksEnd: vi.fn(async () => {}),
    calibrateRangeBegin: vi.fn(async () => {}),
    calibrateRangeEnd: vi.fn(async () => {}),
    getInMemoryModuleData: vi.fn(async () => {
      calls += 1;
      return calls === 1 ? before : after;
    }),
  };
}

describe('CalibrationModal before/after comparison (#48)', () => {
  it('shows the diff table with the per-value delta after a successful calibration', async () => {
    vi.useFakeTimers();
    try {
      // 12 u16 finetune values; index 1 changes 200 → 210 (+10), rest unchanged.
      const before = [100, 200, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
      const after = [100, 210, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
      const manager = makeManager(before, after);
      render(CalibrationModal, { props: { open: true, manager } });

      // Drive the modal through its sleeps + async calibration calls.
      await vi.advanceTimersByTimeAsync(2000);

      expect(screen.getByText('Vorher → Nachher')).toBeInTheDocument();
      expect(screen.getByText(/1 von 12 Werten geändert/)).toBeInTheDocument();
      // The changed value's delta (+10) is rendered.
      expect(screen.getByText('+10')).toBeInTheDocument();
      // The after value 210 is shown in the changed cell.
      expect(screen.getByText('210')).toBeInTheDocument();
      // Before + after snapshots were both read.
      expect(manager.getInMemoryModuleData).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not render the diff table when the finetune read fails', async () => {
    vi.useFakeTimers();
    try {
      const manager = {
        calibrateSticksBegin: async () => {},
        calibrateSticksSample: async () => {},
        calibrateSticksEnd: async () => {},
        calibrateRangeBegin: async () => {},
        calibrateRangeEnd: async () => {},
        getInMemoryModuleData: async () => null,
      };
      render(CalibrationModal, { props: { open: true, manager } });
      await vi.advanceTimersByTimeAsync(2000);
      expect(screen.queryByText('Vorher → Nachher')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Flush the auto-started flow across Svelte's effect scheduling: the mount
 * `$effect` fires start(), whose await chain (getInMemoryModuleData →
 * calibrateRangeBegin → step 2) runs on microtasks. A bare `act` (one
 * Svelte.tick) flushes the effect but not the full chain; two macrotask hops
 * plus a tick settle it — the second hop also lets the tests-setup animate
 * polyfill's `onfinish` timer remove outro'd elements (modal close).
 */
async function settle() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {});
}

/**
 * Range-flow behaviour (#121): busy must be released once the range flow
 * reaches its sampling step (otherwise the "Fertig" button is unreachable),
 * closing mid-sampling must send `calibrateRangeEnd` (otherwise the controller
 * stays in range mode), and an overtaken (stale) range run must not advance
 * the flow. The modal auto-starts the flow on `open` via a `$effect`, so tests
 * drive it through the DOM and `act` (the range flow has no sleeps — only
 * awaits of the fake manager's promises).
 */
describe('CalibrationModal range flow (#121)', () => {
  it('releases busy at the sampling step so the Fertig button is reachable (#121)', async () => {
    const manager = makeManager([], []);
    render(CalibrationModal, { props: { open: true, manager, initialMode: 'range' } });

    // Let the auto-started range flow settle: getInMemoryModuleData →
    // calibrateRangeBegin → step 2 (sampling), busy released.
    await settle();

    // Bug 1: runRangeCalibration used to leave busy=true on the success path,
    // so the Fertig button (`step === 2 && !busy` gate) never rendered.
    const done = screen.getByRole('button', { name: 'Fertig' });
    expect(done).not.toBeDisabled();

    // From this state the flow finishes end-to-end.
    await act(async () => {
      fireEvent.click(done);
    });
    await settle();
    expect(manager.calibrateRangeEnd).toHaveBeenCalledTimes(1);
  });

  it('sends calibrateRangeEnd when closed during the sampling step (#121)', async () => {
    const manager = makeManager([], []);
    render(CalibrationModal, { props: { open: true, manager, initialMode: 'range' } });
    await settle();

    const cancel = screen.getByRole('button', { name: 'Abbrechen' });
    await act(async () => {
      fireEvent.click(cancel);
    });
    await settle();

    // Bug 2: close() used to drop the flow silently — the controller stayed
    // in range mode hardware-side.
    expect(manager.calibrateRangeEnd).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Fertig' })).toBeNull();
  });

  it('ignores a stale range run when a new start overtakes it (#121)', async () => {
    const manager = makeManager([], []);
    // Gate calibrateRangeBegin on manual resolvers so two runs can be in
    // flight at once (oldest resolver first: run 1, then run 2).
    const resolvers: Array<() => void> = [];
    manager.calibrateRangeBegin.mockImplementation(
      () => new Promise<void>((res) => resolvers.push(res))
    );
    const { rerender } = render(CalibrationModal, {
      props: { open: false, manager, initialMode: 'range' },
    });

    // Run 1: opens the modal → auto-start, stuck pending in calibrateRangeBegin.
    await act(async () => {
      await rerender({ open: true });
    });
    await settle();
    expect(manager.calibrateRangeBegin).toHaveBeenCalledTimes(1);

    // Run 2: close via the prop (no close() handler → run 1 keeps running in
    // the background), reopen → a second start overtakes the first.
    await act(async () => {
      await rerender({ open: false });
    });
    await act(async () => {
      await rerender({ open: true });
    });
    await settle();
    expect(manager.calibrateRangeBegin).toHaveBeenCalledTimes(2);

    // Bug 3: resolving the STALE run's begin must not advance the flow —
    // without a run token the old continuation would jump to step 2.
    await act(async () => {
      resolvers[0]();
    });
    await settle();
    expect(screen.getByText('Schritt 1 / 4')).toBeInTheDocument();

    // Resolving the CURRENT run's begin finishes its begin phase normally.
    await act(async () => {
      resolvers[1]();
    });
    await settle();
    expect(screen.getByRole('button', { name: 'Fertig' })).not.toBeDisabled();
    expect(manager.calibrateRangeEnd).not.toHaveBeenCalled();
  });
});
