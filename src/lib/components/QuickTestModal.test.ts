// @vitest-environment jsdom
import { render, screen, fireEvent, act } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import QuickTestModal from './QuickTestModal.svelte';
import { initI18n, setLocale } from '$lib/i18n/init';
import { get } from 'svelte/store';
import { controllerLog } from '$lib/stores/controller';

/**
 * Tests for the Bluetooth connection quick test (#119): a pure receive
 * measurement (no actuator output) that polls `getTransportStats()` for 10 s
 * and passes/fails on report count, packet loss and CRC-error ratio.
 *
 * The fake manager stubs only the methods QuickTestModal actually touches.
 * The verdict regexes (/ok|fail/i) are asserted against the *English* labels
 * ('✓ OK' / '✗ Fail') because the German fail label is '✗ Fehler', which
 * carries no 'fail' substring — so the locale is pinned to 'en' here.
 *
 * The second describe block covers the lifecycle fixes (#122) and needs the
 * per-test `test-<id>` / `status-<id>` testids (the #119 pattern, generalized
 * to every row). Later blocks cover the deferred-minors wave (9a/9b/9d/12a/
 * 12c/12d, N2): lights/mic generation tokens, abort log gating and the
 * speaker doneCb's own completed entry.
 */

/** Log entries pushed AFTER this call (delta snapshot, deferred 12d): the
 * controllerLog store is newest-first and shared across the whole file, so
 * absolute counts/positions shift with every neighboring test. */
function logMark(): number {
  return get(controllerLog)[0]?.id ?? -1;
}

function freshLogEntries(mark: number) {
  return get(controllerLog).filter((e) => e.id > mark);
}

beforeEach(() => {
  document.body.innerHTML = '';
  initI18n();
  setLocale('en');
});

afterEach(() => {
  setLocale('de');
  vi.useRealTimers();
});

function makeManager(transport: 'usb' | 'bt' = 'usb') {
  return {
    setVibration: vi.fn(async () => {}),
    setAdaptiveTrigger: vi.fn(async () => {}),
    setLightbarColor: vi.fn(async () => {}),
    setPlayerIndicator: vi.fn(async () => {}),
    setMuteLed: vi.fn(async () => {}),
    resetLights: vi.fn(async () => {}),
    setSpeakerTone: vi.fn(async (
      _output?: 'speaker' | 'headphones',
      _duration?: number,
      _doneCb?: (r: { success: boolean }) => void
    ) => {}),
    resetSpeakerSettings: vi.fn(async () => {}),
    getTransport: vi.fn(() => transport),
    resetTransportStats: vi.fn(),
    getTransportStats: vi.fn(
      (): { reports: number; seqGaps: number; crcErrors: number; lastSeq: number | null } => ({
        reports: 0,
        seqGaps: 0,
        crcErrors: 0,
        lastSeq: null,
      })
    ),
  };
}

describe('QuickTestModal Bluetooth connection test (#119)', () => {
  it('passes with clean transport stats and resets them first', async () => {
    vi.useFakeTimers();
    const manager = makeManager('bt');
    // getTransportStats serves 200 clean frames.
    manager.getTransportStats = vi.fn(() => ({ reports: 200, seqGaps: 0, crcErrors: 0, lastSeq: 7 }));
    render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
    const mark = logMark();
    await fireEvent.click(screen.getByTestId('test-bt'));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(screen.getByTestId('status-bt')).toHaveTextContent(/ok/i);
    expect(manager.resetTransportStats).toHaveBeenCalled();
    // Pin the btOk summary (deferred 9d): the verdict text must carry the
    // reports/loss/CRC numbers so a summary-key drift cannot slip through.
    const status = screen.getByTestId('status-bt');
    expect(status).toHaveTextContent('200 reports');
    expect(status).toHaveTextContent('0% loss');
    expect(status).toHaveTextContent('0 CRC errors');
    // The verdict is also pushed to the controller log (delta-scoped).
    expect(
      freshLogEntries(mark).some((e) => e.message.includes('Stable: 200 reports'))
    ).toBe(true);
  });

  it('pins the CRC-failure verdict text (9d)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('bt');
    manager.getTransportStats = vi.fn(() => ({
      reports: 100,
      seqGaps: 0,
      crcErrors: 10,
      lastSeq: 3,
    }));
    render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
    await fireEvent.click(screen.getByTestId('test-bt'));
    await vi.advanceTimersByTimeAsync(10_500);
    const status = screen.getByTestId('status-bt');
    expect(status).toHaveTextContent(/fail/i);
    expect(status).toHaveTextContent('Too many CRC errors (> 5%)');
    expect(status).not.toHaveTextContent('packet loss');
  });

  it('pins the packet-loss verdict text (9d)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('bt');
    manager.getTransportStats = vi.fn(() => ({
      reports: 100,
      seqGaps: 5,
      crcErrors: 0,
      lastSeq: 3,
    }));
    render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
    await fireEvent.click(screen.getByTestId('test-bt'));
    await vi.advanceTimersByTimeAsync(10_500);
    const status = screen.getByTestId('status-bt');
    expect(status).toHaveTextContent(/fail/i);
    expect(status).toHaveTextContent('Too much packet loss (> 2%)');
    expect(status).not.toHaveTextContent('CRC errors (> 5%)');
  });

  it('fails on packet loss', async () => {
    vi.useFakeTimers();
    const manager = makeManager('bt');
    manager.getTransportStats = vi.fn(() => ({ reports: 100, seqGaps: 20, crcErrors: 0, lastSeq: 5 }));
    render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
    await fireEvent.click(screen.getByTestId('test-bt'));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(screen.getByTestId('status-bt')).toHaveTextContent(/fail/i);
  });

  it('is not rendered on USB transport', () => {
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    expect(screen.queryByTestId('test-bt')).not.toBeInTheDocument();
  });
});

/**
 * Lifecycle fixes (#122): the actuator token invalidates stale async
 * continuations (speaker doneCb), close()/unmount reset every actuator, and
 * the lights test logs its 'completed' entry only once a verdict exists
 * (startLightsTest returns immediately, so the generic post-switch log used
 * to fire at start with no verdict).
 */
describe('QuickTestModal lifecycle (#122)', () => {
  it('stale speaker done callback does not overwrite a newer test status (#122)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });

    // Start the speaker test — the fake manager stores its doneCb unresolved.
    await fireEvent.click(screen.getByTestId('test-speaker'));
    expect(screen.getByTestId('status-speaker')).toHaveTextContent(/running/i);

    // A newer test starts: every runTest entry bumps the actuator token.
    await fireEvent.click(screen.getByTestId('test-haptic'));

    // The stale speaker doneCb fires late.
    const staleDone = manager.setSpeakerTone.mock.calls[0][2];
    if (!staleDone) throw new Error('speaker test did not capture a doneCb');
    await act(async () => {
      staleDone({ success: true });
    });

    // Without the token the stale cb would flip the speaker row to '✓ OK'
    // even though the newer (haptic) test is the current run.
    expect(screen.getByTestId('status-speaker')).toHaveTextContent(/running/i);
  });

  it('resets actuators on unmount (#122)', () => {
    const manager = makeManager('usb');
    const { unmount } = render(QuickTestModal, {
      props: { open: true, manager, transport: 'usb' },
    });
    unmount();
    expect(manager.setVibration).toHaveBeenCalledWith(0, 0);
    expect(manager.setAdaptiveTrigger).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'off' }),
      expect.objectContaining({ mode: 'off' })
    );
    expect(manager.resetLights).toHaveBeenCalled();
    expect(manager.resetSpeakerSettings).toHaveBeenCalled();
  });

  it("logs the lights 'completed' entry only after the verdict (#122)", async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    // Delta snapshot (deferred 12d): only entries appended after the mark —
    // absolute counts would shift with every neighboring test's log output.
    const mark = logMark();
    const completedLights = () =>
      freshLogEntries(mark).filter((e) => /quick test 'lights' completed/i.test(e.message));

    // Start the lights test (cycles colors/patterns on a 200 ms interval) and
    // let it run: no 'completed' entry yet — the verdict is still pending.
    await fireEvent.click(screen.getByTestId('test-lights'));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(completedLights()).toHaveLength(0);

    // Stopping produces the verdict (pass here) and with it the log entry.
    await fireEvent.click(screen.getByLabelText('Stop'));
    await vi.advanceTimersByTimeAsync(0);
    expect(completedLights()).toHaveLength(1);
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/ok/i);
  });

  it('close() mid-haptic-test gates the re-buzz (final-review M2)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });

    // Start the haptic test: heavy motor on.
    await fireEvent.click(screen.getByTestId('test-haptic'));
    expect(manager.setVibration).toHaveBeenCalledWith(255, 0);

    // Close mid-test — close() silences the actuators once.
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(manager.setVibration).toHaveBeenCalledWith(0, 0);

    // Advance past the haptic chain's first delay: the stale continuation must
    // NOT re-buzz with the light motor (that would override close()'s reset).
    await vi.advanceTimersByTimeAsync(700);
    expect(manager.setVibration).not.toHaveBeenCalledWith(0, 255);
  });

  it('stale haptic continuation does not overwrite a newer test status (final-review M2)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    await fireEvent.click(screen.getByTestId('test-haptic'));
    // A newer run replaces the haptic test; the stale chain must neither
    // re-buzz nor flip the row's status after the newer run owns the UI.
    await fireEvent.click(screen.getByTestId('test-lights'));
    await vi.advanceTimersByTimeAsync(700);
    expect(manager.setVibration).not.toHaveBeenCalledWith(0, 255);
    expect(screen.getByTestId('status-haptic')).toHaveTextContent(/running/i);
  });
});

/**
 * Deferred-minors wave: lights/mic generation tokens (9a/N2), the abort log
 * gate (9b), the close-time speaker token pin (12a), the interval-error pad
 * reset (12c) and the delta-scoped log assertions (12d).
 */
describe('QuickTestModal generations + abort gating (deferred 9a/9b/12a/12c/N2)', () => {
  it('a stale lights tick neither kills the newer run nor flips its row (9a)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    // Manually-controlled setLightbarColor promises: the first (stale) tick
    // stays pending until rejected late; every later tick resolves at once.
    const pending: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];
    let rejectMode = true;
    manager.setLightbarColor = vi.fn(
      () =>
        new Promise<void>((resolve, reject) => {
          if (rejectMode) pending.push({ resolve, reject });
          else resolve();
        })
    );
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });

    await fireEvent.click(screen.getByTestId('test-lights'));
    await vi.advanceTimersByTimeAsync(200); // run A's first tick is pending
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/running/i);

    // Stop run A (writes its 'pass' verdict), then immediately start run B.
    await fireEvent.click(screen.getByLabelText('Stop'));
    await vi.advanceTimersByTimeAsync(0);
    rejectMode = false; // run B's ticks resolve immediately
    await fireEvent.click(screen.getByTestId('test-lights'));
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/running/i);

    // Now reject run A's stale pending promise. Pre-fix: the stale catch
    // cleared the (newer) interval and flipped the row to 'fail'.
    await act(async () => {
      pending[0].reject(new Error('stale tick'));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/running/i);
    // Run B keeps cycling — the newer interval was not killed.
    const callsBefore = manager.setLightbarColor.mock.calls.length;
    await vi.advanceTimersByTimeAsync(200);
    expect(manager.setLightbarColor.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('a late lights rejection after Stop does not overwrite the pass verdict (9a)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    const rejecters: Array<(e: Error) => void> = [];
    manager.setLightbarColor = vi.fn(
      () => new Promise<void>((_resolve, reject) => rejecters.push(reject))
    );
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    const mark = logMark();
    const completedLights = () =>
      freshLogEntries(mark).filter((e) => /quick test 'lights' completed/i.test(e.message));

    await fireEvent.click(screen.getByTestId('test-lights'));
    await vi.advanceTimersByTimeAsync(200); // first tick pending
    await fireEvent.click(screen.getByLabelText('Stop'));
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/ok/i);
    expect(completedLights()).toHaveLength(1);

    // The stale tick's rejection arrives after the verdict was written.
    await act(async () => {
      rejecters[0](new Error('late failure'));
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/ok/i);
    expect(completedLights()).toHaveLength(1);
  });

  it('resets the pad when the lights interval hits a write error (12c)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    manager.setLightbarColor = vi.fn(async () => {
      throw new Error('hid write gone');
    });
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    const mark = logMark();
    await fireEvent.click(screen.getByTestId('test-lights'));
    await vi.advanceTimersByTimeAsync(300);
    // The pad must not keep the last cycled color / the start mute LED.
    expect(manager.resetLights).toHaveBeenCalled();
    expect(screen.getByTestId('status-lights')).toHaveTextContent(/fail/i);
    const pushed = freshLogEntries(mark);
    expect(pushed.some((e) => e.message.includes('hid write gone'))).toBe(true);
    expect(pushed.filter((e) => /quick test 'lights' completed/i.test(e.message))).toHaveLength(1);
  });

  it('does not push a completed entry when the bt test is aborted by close() (9b)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('bt');
    manager.getTransportStats = vi.fn(() => ({
      reports: 200,
      seqGaps: 0,
      crcErrors: 0,
      lastSeq: 7,
    }));
    render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
    const mark = logMark();
    await fireEvent.click(screen.getByTestId('test-bt'));
    // Close mid-measurement: close() aborts the bt loop and bumps the token.
    await fireEvent.keyDown(window, { key: 'Escape' });
    await vi.advanceTimersByTimeAsync(600);
    // Pre-fix: runTest pushed the generic 'completed' entry although the run
    // was aborted without a verdict (statuses.bt = 'idle').
    expect(freshLogEntries(mark).filter((e) => /completed/i.test(e.message))).toHaveLength(0);
  });

  it('does not push a completed entry when the buttons test is aborted (9b)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    const mark = logMark();
    await fireEvent.click(screen.getByTestId('test-buttons'));
    expect(screen.getByTestId('status-buttons')).toHaveTextContent(/running/i);
    await fireEvent.keyDown(window, { key: 'Escape' });
    await vi.advanceTimersByTimeAsync(0);
    expect(freshLogEntries(mark).filter((e) => /completed/i.test(e.message))).toHaveLength(0);
  });

  it('close() bumps the actuator token — a stale speaker doneCb writes nothing (12a)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    const mark = logMark();
    // Start the speaker test — the fake manager stores its doneCb unresolved.
    await fireEvent.click(screen.getByTestId('test-speaker'));
    expect(screen.getByTestId('status-speaker')).toHaveTextContent(/running/i);
    // Close while the tone is playing: close() bumps the token + resets the
    // actuators (the outro freezes the row's label, so the actuator reset is
    // the observable here — the row itself is skipped by Svelte's teardown).
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(manager.resetSpeakerSettings).toHaveBeenCalled();
    const staleDone = manager.setSpeakerTone.mock.calls[0][2];
    if (!staleDone) throw new Error('speaker test did not capture a doneCb');
    await act(async () => {
      staleDone({ success: true });
    });
    // The stale callback must not log a completed entry (pre-fix it did).
    expect(freshLogEntries(mark)).toHaveLength(0);
  });

  it('a replaced mic run unmounts the meter and un-sticks the row (N2)', async () => {
    vi.useFakeTimers();
    const manager = makeManager('usb');
    render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
    await fireEvent.click(screen.getByTestId('test-microphone'));
    expect(screen.getByTestId('status-microphone')).toHaveTextContent(/running/i);
    // The mic level meter block is mounted while the row is 'running'.
    const micRow = screen.getByTestId('status-microphone').closest('div.rounded-lg');
    expect(micRow?.querySelector('.mt-2')).not.toBeNull();

    // A newer test replaces the mic run within the 500 ms window.
    await fireEvent.click(screen.getByTestId('test-haptic'));
    await vi.advanceTimersByTimeAsync(500);
    // Pre-fix: the stale continuation bailed and left the row 'running' with
    // the (getUserMedia-holding) meter mounted until close().
    expect(screen.getByTestId('status-microphone')).toHaveTextContent(/not tested/i);
    expect(micRow?.querySelector('.mt-2')).toBeNull();
    // The haptic run proceeds normally.
    expect(screen.getByTestId('status-haptic')).toHaveTextContent(/running/i);
    expect(manager.setVibration).toHaveBeenCalledWith(0, 255);
  });
});
