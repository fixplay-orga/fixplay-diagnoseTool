// @vitest-environment jsdom
import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import QuickTestModal from './QuickTestModal.svelte';
import { initI18n, setLocale } from '$lib/i18n/init';

/**
 * Tests for the Bluetooth connection quick test (#119): a pure receive
 * measurement (no actuator output) that polls `getTransportStats()` for 10 s
 * and passes/fails on report count, packet loss and CRC-error ratio.
 *
 * The fake manager stubs only the methods QuickTestModal actually touches.
 * The verdict regexes (/ok|fail/i) are asserted against the *English* labels
 * ('✓ OK' / '✗ Fail') because the German fail label is '✗ Fehler', which
 * carries no 'fail' substring — so the locale is pinned to 'en' here.
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
    setSpeakerTone: vi.fn(async () => {}),
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