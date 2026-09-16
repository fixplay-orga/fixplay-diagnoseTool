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
 * to every row).
 */
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
    await fireEvent.click(screen.getByTestId('test-bt'));
    await vi.advanceTimersByTimeAsync(10_500);
    expect(screen.getByTestId('status-bt')).toHaveTextContent(/ok/i);
    expect(manager.resetTransportStats).toHaveBeenCalled();
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
    const completedLights = () =>
      get(controllerLog).filter((e) => /quick test 'lights' completed/i.test(e.message));

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
});
