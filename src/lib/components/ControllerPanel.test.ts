// @vitest-environment jsdom
import { render, screen, act } from '@testing-library/svelte';
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
} from '$lib/stores/controller';

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
});
