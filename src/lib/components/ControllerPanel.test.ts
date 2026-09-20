// @vitest-environment jsdom
import { render, screen, act, fireEvent, waitFor } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { get } from 'svelte/store';
import ControllerPanel from './ControllerPanel.svelte';
import { initI18n } from '$lib/i18n/init';
import {
  controllerConnected,
  controllerTransport,
  micConnected,
  headphoneConnected,
  batteryStatus,
  stickDeadzone,
  loadStickDeadzonePercent,
  controllerLog,
} from '$lib/stores/controller';
// Mock layer (14d): vitest has no MOCK alias for @tauri-apps/api, so the tests
// install a `window.__TAURI_INTERNALS__` shim that routes the real invoke()
// through the mock layer's handlers — driving behavior via mockState /
// mockHidRuntime, exactly the documented pattern (never vi.mock).
import { invoke as mockInvoke } from '$lib/mock/core';
import { mockState, mockHidRuntime, resetMockState } from '$lib/mock/state';

/**
 * Tests for the status row + HID diagnostics block + stick deadzone slider
 * (#124). The component reads its connection-related state from the shared
 * controller stores (the same way it derives it from the real poll loop), so
 * the tests drive the stores directly — no invoke() and no connect flow
 * (the vitest run has no MOCK alias for @tauri-apps/api, so the real invoke
 * would throw inside jsdom; the diagnostics poll catches that and keeps the
 * placeholder defaults, which the diagnostics test asserts).
 */
beforeEach(() => {
  document.body.innerHTML = '';
  // All labels render via the reactive i18n store ($LL) — locales must be
  // loaded before render. Idempotent.
  initI18n();
  // Reset the stores the status row derives from (render() is sticky across
  // tests because the stores are module-level).
  controllerConnected.set(false);
  controllerTransport.set('usb');
  micConnected.set(false);
  headphoneConnected.set(false);
  batteryStatus.set({
    charge_level: 0,
    cable_connected: false,
    is_charging: false,
    is_error: false,
    bat_txt: '',
  });
  stickDeadzone.set(0);
  try {
    localStorage.removeItem('fixplay-stick-deadzone');
  } catch {
    /* ignored */
  }
  // Several child components render to a <canvas>; jsdom has no 2D context.
  // Stub a minimal 2D context (methods the renderers actually call) so the
  // test output stays clean — same pattern as CalibrationModal.test.ts.
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

afterEach(() => {
  // Drop leftover DOM (details blocks etc.) — render() below unmounts itself.
  document.body.innerHTML = '';
});

describe('ControllerPanel status row (#124)', () => {
  it('shows the BT transport badge when the transport is bt', async () => {
    controllerConnected.set(true);
    controllerTransport.set('bt');
    render(ControllerPanel);
    const badge = await screen.findByTestId('transport-badge');
    expect(badge).toHaveTextContent('BT');
  });

  it('shows the USB transport badge by default', async () => {
    controllerConnected.set(true);
    controllerTransport.set('usb');
    render(ControllerPanel);
    const badge = await screen.findByTestId('transport-badge');
    expect(badge).toHaveTextContent('USB');
  });

  it('is hidden while no controller is connected', () => {
    controllerConnected.set(false);
    render(ControllerPanel);
    expect(screen.queryByTestId('transport-badge')).toBeNull();
    expect(screen.queryByTestId('status-row')).toBeNull();
  });

  it('shows the battery badge with the existing batteryStatus text', async () => {
    controllerConnected.set(true);
    batteryStatus.set({
      charge_level: 75,
      cable_connected: false,
      is_charging: true,
      is_error: false,
      bat_txt: 'Voll (75%)',
    });
    render(ControllerPanel);
    const badge = await screen.findByTestId('battery-badge');
    expect(badge).toHaveTextContent('Voll (75%)');
  });

  it('shows mic and headphone badges only when connected', async () => {
    controllerConnected.set(true);
    render(ControllerPanel);
    expect(screen.queryByTestId('mic-badge')).toBeNull();
    expect(screen.queryByTestId('headphone-badge')).toBeNull();

    await act(async () => {
      micConnected.set(true);
      headphoneConnected.set(true);
    });
    expect(screen.getByTestId('mic-badge')).toBeInTheDocument();
    expect(screen.getByTestId('headphone-badge')).toBeInTheDocument();
  });
});

describe('ControllerPanel HID diagnostics block (#124)', () => {
  it('renders the collapsible block with placeholder defaults', async () => {
    controllerConnected.set(true);
    const { unmount } = render(ControllerPanel);
    const details = screen.getByTestId('hid-diagnostics') as HTMLDetailsElement;
    // Collapsed by default — the 2 s poll must not be running yet (nothing
    // observed here; the important part is that opening below works).
    expect(details.open).toBe(false);

    // Open it: Svelte's <details bind:open> listens for the toggle event —
    // jsdom does not fire one automatically for a property write.
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    // The poll ran (invoke fails silently without a Tauri backend) and the
    // placeholder defaults render.
    expect(details.textContent).toContain('HID-Diagnose');
    expect(details.textContent).toContain('Writes');
    expect(details.textContent).toMatch(/0/);
    expect(details.textContent).toContain('—');
    unmount();
  });
});

describe('ControllerPanel stick deadzone slider (#124)', () => {
  it('starts at 0 and persists the percent to store + localStorage', async () => {
    controllerConnected.set(true);
    const { unmount } = render(ControllerPanel);
    const slider = screen.getByTestId('deadzone-slider') as HTMLInputElement;
    expect(Number(slider.value)).toBe(0);
    expect(get(stickDeadzone)).toBe(0);

    await act(async () => {
      slider.value = '15';
      slider.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(get(stickDeadzone)).toBeCloseTo(0.15, 6);
    expect(localStorage.getItem('fixplay-stick-deadzone')).toBe('15');
    unmount();
  });

  it('loads and clamps a persisted percent from localStorage', () => {
    // The store itself initializes once at module load (app startup), so the
    // restore path is tested through the exported loader.
    localStorage.setItem('fixplay-stick-deadzone', '7');
    expect(loadStickDeadzonePercent()).toBe(7);
    // Out of range → clamped to the slider maximum.
    localStorage.setItem('fixplay-stick-deadzone', '55');
    expect(loadStickDeadzonePercent()).toBe(20);
    // Corrupt value → default.
    localStorage.setItem('fixplay-stick-deadzone', 'bogus');
    expect(loadStickDeadzonePercent()).toBe(0);
  });

  it('rounds a persisted fractional percent to an integer (14e)', () => {
    // Older versions persisted fractional percents — the slider round-trips
    // integers only, so the loader must round on read.
    localStorage.setItem('fixplay-stick-deadzone', '7.5');
    expect(loadStickDeadzonePercent()).toBe(8);
    localStorage.setItem('fixplay-stick-deadzone', '0.4');
    expect(loadStickDeadzonePercent()).toBe(0);
    localStorage.setItem('fixplay-stick-deadzone', '19.6');
    expect(loadStickDeadzonePercent()).toBe(20);
  });
});

/**
 * Deferred-minors wave (2a/7b/14b/14c/14d/14f + the mode badge): these tests
 * drive the REAL connect flow through the mock layer via the
 * `window.__TAURI_INTERNALS__` shim (vitest has no MOCK alias) so mockState /
 * mockHidRuntime seeds reach the component's invokes.
 */
describe('ControllerPanel connect flow via mock layer (deferred 2a/7b/14b/14c/14d/14f, mode badge)', () => {
  /** Delta snapshot of the shared, newest-first controllerLog (12d pattern). */
  function logMark(): number {
    return get(controllerLog)[0]?.id ?? -1;
  }
  function freshLogEntries(mark: number) {
    return get(controllerLog).filter((e) => e.id > mark);
  }

  function shimTauri(): void {
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      invoke: (cmd: string, args?: Record<string, unknown>) => mockInvoke(cmd, args),
    };
  }

  function ds5Device(pid: number, path: string) {
    return {
      vendor_id: 0x054c,
      product_id: pid,
      manufacturer: 'Sony Interactive Entertainment',
      product: 'DualSense Wireless Controller',
      serial_number: null,
      usage_page: 1,
      usage: 5,
      path,
    };
  }

  beforeEach(() => {
    shimTauri();
    resetMockState();
  });

  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    try {
      localStorage.removeItem('fixplay-mock-state');
    } catch {
      /* ignored */
    }
  });

  async function connectSingleDevice(pid: number) {
    mockState.update((s) => ({
      ...s,
      hid: { ...s.hid, devices: [ds5Device(pid, '/dev/hidraw4')] },
    }));
    const { unmount } = render(ControllerPanel);
    fireEvent.click(await screen.findByRole('button', { name: 'Verbinden' }));
    await screen.findByTestId('transport-badge'); // connected
    return unmount;
  }

  it('renders the mocked write counters verbatim as the discriminator (14d)', async () => {
    // Drive the counters through the mock layer — pre-fix the test could only
    // assert the (invoke-failing) placeholders, which a placeholder-drift bug
    // would also satisfy.
    mockHidRuntime.writeCount = 7;
    mockHidRuntime.writeErrors = 1;
    mockHidRuntime.lastWriteError = 'Mock-Fehler-Injektion 14d';
    const { unmount } = render(ControllerPanel);
    const details = (await screen.findByTestId('hid-diagnostics')) as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await waitFor(() => expect(details.textContent).toContain('Writes: 7'));
    expect(details.textContent).toContain('Write-Fehler: 1');
    expect(details.textContent).toContain('Mock-Fehler-Injektion 14d');
    unmount();
  });

  it('renders the diagnostics block while disconnected (14c)', async () => {
    controllerConnected.set(false);
    // Disconnected mock state: the counters read back as nulls/'—'.
    mockState.update((s) => ({ ...s, hid: { ...s.hid, connected: false } }));
    render(ControllerPanel);
    // The block left the connected branch (14c): it must exist even without a
    // connection, showing the null placeholders.
    const details = (await screen.findByTestId('hid-diagnostics')) as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await waitFor(() => expect(details.textContent).toContain('HID-Diagnose'));
    expect(details.textContent).toContain('—');
  });

  it('clears the diagnostics snapshot on disconnect (14b)', async () => {
    const unmount = await connectSingleDevice(0x0ce6);
    // The connect's baseline write is the session's first counted write — the
    // connect chain (info reads + sleeps) runs in the background, so allow it
    // to finish.
    const details = screen.getByTestId('hid-diagnostics') as HTMLDetailsElement;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle'));
    });
    await waitFor(() => expect(details.textContent).toContain('Writes: 1'), { timeout: 5000 });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Trennen' }));
    });
    // The block stays rendered (14c) but shows the cleared placeholders — no
    // stale session counters. The disconnect tail runs across an await chain,
    // so poll for the cleared block instead of asserting immediately.
    await waitFor(() => {
      expect(screen.getByTestId('hid-diagnostics')).toBeInTheDocument();
      expect(details.textContent).not.toContain('Writes: 1');
    });
    expect(details.textContent).toContain('—');
    unmount();
  });

  it('resets the transport store when the connect attempt fails (14f)', async () => {
    controllerTransport.set('bt'); // stale from a previous session
    mockState.update((s) => ({ ...s, hid: { ...s.hid, devices: [] } }));
    render(ControllerPanel);
    fireEvent.click(await screen.findByRole('button', { name: 'Verbinden' }));
    await screen.findByText(/Kein DualSense/);
    expect(get(controllerTransport)).toBe('usb');
  });

  it('pushes a German baseline-failed log entry on a failed baseline write (2a)', async () => {
    // Command-level injection (#72) on the output-report command only: since
    // deferred 13c the armed 'hid-write' transport injection ALSO rejects
    // feature sends, which fails the connect's info read before the baseline
    // write is ever attempted — this test pins the baseline log specifically.
    mockState.update((s) => ({
      ...s,
      errors: { hid_send_output_report: 'HID-Write fehlgeschlagen (injiziert)' },
    }));
    const mark = logMark();
    const unmount = await connectSingleDevice(0x0ce6);
    // The baseline write happens mid-connect (after the info reads), so the
    // transport badge can appear before the log entry does.
    await waitFor(
      () =>
        expect(
          freshLogEntries(mark).some(
            (e) => e.level === 'error' && e.message.includes('Lichtbar-Baseline fehlgeschlagen')
          )
        ).toBe(true),
      { timeout: 5000 }
    );
    // The failure is non-fatal: the connected log still follows.
    expect(freshLogEntries(mark).some((e) => e.message.includes('Controller verbunden'))).toBe(
      true
    );
    unmount();
  });

  it('closes the device picker on Escape and offers the device choices (7b)', async () => {
    mockState.update((s) => ({
      ...s,
      hid: {
        ...s.hid,
        devices: [ds5Device(0x0ce6, '/dev/hidrawA'), ds5Device(0x0e5f, '/dev/hidrawB')],
      },
    }));
    const { unmount } = render(ControllerPanel);
    fireEvent.click(await screen.findByRole('button', { name: 'Verbinden' }));
    const dialog = await screen.findByRole('dialog');
    expect(screen.getByText('Controller wählen')).toBeInTheDocument();
    // Both devices are offered; the first is the default focus target of the
    // shared trapFocus action in the browser. (jsdom cannot assert the focus:
    // its layout is never computed, so trapFocus's offsetParent visibility
    // filter finds no focusables in tests — the action itself is unchanged and
    // already covered by the other modals.)
    const buttons = dialog.querySelectorAll('button');
    expect(buttons.length).toBe(3); // 2 devices + Abbrechen

    // Escape closes the picker like every other modal.
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // The connect attempt was cancelled, not failed: no error banner.
    expect(screen.queryByText(/Kein DualSense/)).toBeNull();
    unmount();
  });

  it('shows the Edge mode badge for productId 0x0e5f', async () => {
    const unmount = await connectSingleDevice(0x0e5f);
    expect(screen.getByTestId('mode-badge')).toHaveTextContent('Edge');
    unmount();
  });

  it('shows the Standard mode badge for productId 0x0ce6', async () => {
    const unmount = await connectSingleDevice(0x0ce6);
    expect(screen.getByTestId('mode-badge')).toHaveTextContent('Standard');
    unmount();
  });

  it('shows no mode badge for the Bluetooth productId 0x0df2', async () => {
    const unmount = await connectSingleDevice(0x0df2);
    expect(screen.queryByTestId('mode-badge')).toBeNull();
    unmount();
  });
});
