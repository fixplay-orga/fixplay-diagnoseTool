// Svelte stores for controller state (connection, sticks, buttons, battery).
import { writable } from 'svelte/store';
import type { SticksState, TouchPoint, ProcessedInput } from '$lib/controllers/controller-manager';
import type {
  ControllerInfo,
  NvStatus,
  ControllerTransport,
} from '$lib/controllers/base-controller';
import type { TextLogEntry } from '$lib/api/types';
import { createLogStore } from './log';
import { createConnectionStore } from './connection';

// Controller connection state backed by the shared createConnectionStore,
// matching the UART/I2C pattern.
const _controllerConnection = createConnectionStore();
export const controllerConnected = _controllerConnection.connected;
/** Unified controller connection status (coarse lifecycle + booleans). */
export const controllerConnection = _controllerConnection.status;
export const controllerModel = writable<string | null>(null);
/**
 * Active transport (USB vs BT), set by the ControllerPanel poll loop on every
 * input report (the manager detects it from the report id) and reset on
 * disconnect. A store instead of component state so the status row
 * (#124) and the quick-test modal read the same source.
 */
export const controllerTransport = writable<ControllerTransport>('usb');
export const controllerInfo = writable<ControllerInfo | null>(null);
export const controllerNvStatus = writable<NvStatus | null>(null);
export const controllerHasChanges = writable<boolean>(false);

export const stickState = writable<SticksState>({
  left: { x: 0, y: 0 },
  right: { x: 0, y: 0 },
});

export const buttonState = writable<Record<string, boolean>>({});
export const triggerState = writable<{ l2: number; r2: number }>({ l2: 0, r2: 0 });
export const touchPoints = writable<TouchPoint[]>([]);

/**
 * Last lightbar color applied to the controller (0-255 RGB). Driven by the
 * LightbarTester and mirrored live on the controller graphic's lightbar strip.
 * Ephemeral — not the controller's actual state, just the UI's last command.
 */
export const lightbarColor = writable<{ r: number; g: number; b: number }>({ r: 0, g: 0, b: 255 });

/** Whether a microphone is connected (input report byte 53 bit 1). */
export const micConnected = writable<boolean>(false);
/** Whether headphones are connected (input report byte 53 bit 0). */
export const headphoneConnected = writable<boolean>(false);

/**
 * Latest IMU sample (#56): gyro (°/s) + accel (g) from the DualSense input
 * report. Updated on every processed input; consumed by the IMU visualizer.
 */
export const imuState = writable<{
  gyro: { x: number; y: number; z: number };
  accel: { x: number; y: number; z: number };
}>({
  gyro: { x: 0, y: 0, z: 0 },
  accel: { x: 0, y: 0, z: 0 },
});

/**
 * Stick deadzone radius (0..0.2 of full deflection) used by the stick
 * visualizers and the range-calibration result. Driven by the ControllerPanel
 * deadzone slider (0-20 %) and persisted to localStorage under
 * `fixplay-stick-deadzone` (percent, try/catch'd like every other
 * localStorage access). Affects the VISUALIZER only (#124) — protocol writes
 * always see the raw stick pair.
 */
const STICK_DEADZONE_KEY = 'fixplay-stick-deadzone';
const STICK_DEADZONE_MAX_PCT = 20;

/** Load the persisted deadzone percent (clamped 0-20, default 0). Exported so
 * the persistence round-trip is unit-testable (the store initializes once at
 * module load). */
export function loadStickDeadzonePercent(): number {
  try {
    if (typeof localStorage === 'undefined') return 0; // SSR safety
    const raw = localStorage.getItem(STICK_DEADZONE_KEY);
    if (raw === null) return 0;
    const pct = Number(raw);
    if (Number.isFinite(pct)) {
      return Math.min(STICK_DEADZONE_MAX_PCT, Math.max(0, pct));
    }
  } catch {
    // Corrupt/unavailable localStorage — fall back to the default.
  }
  return 0;
}

export const stickDeadzone = writable<number>(loadStickDeadzonePercent() / 100);

/** Clamp+store a slider percent (0-20) into the store (fraction) + disk. */
export function setStickDeadzonePercent(pct: number): void {
  const clamped = Math.min(STICK_DEADZONE_MAX_PCT, Math.max(0, pct));
  stickDeadzone.set(clamped / 100);
  try {
    localStorage.setItem(STICK_DEADZONE_KEY, String(clamped));
  } catch {
    // Quota / private mode — ignore; the store still works in-memory.
  }
}

/**
 * Per-stick circularity polygon produced by range calibration: 48 radii (one
 * per angular bin, see CIRCULARITY_DATA_SIZE), or null when no range
 * calibration has been run yet. Consumed by the stick visualizer to render the
 * green/red circularity overlay.
 */
export const stickCircularity = writable<{ left: number[] | null; right: number[] | null }>({
  left: null,
  right: null,
});

export const batteryStatus = writable<{
  charge_level: number;
  cable_connected: boolean;
  is_charging: boolean;
  is_error: boolean;
  bat_txt: string;
}>({ charge_level: 0, cable_connected: false, is_charging: false, is_error: false, bat_txt: '' });

// Controller log: shares the message+level (TextLogEntry) style with the flash
// log, backed by the common createLogStore (monotonic id + capped prepend).
const _controllerLog = createLogStore<TextLogEntry>();
export const controllerLog = _controllerLog.entries;
export const nextControllerLogId = _controllerLog.nextId;

export function pushControllerLog(
  message: string,
  level: 'info' | 'warn' | 'error' = 'info'
): void {
  _controllerLog.push({ id: nextControllerLogId(), timestamp_ms: Date.now(), message, level });
}

export function applyProcessedInput(input: ProcessedInput): void {
  if (input.changes.sticks) stickState.set(input.changes.sticks);
  if (input.changes.l2_analog !== undefined || input.changes.r2_analog !== undefined) {
    triggerState.update((t) => ({
      l2: input.changes.l2_analog ?? t.l2,
      r2: input.changes.r2_analog ?? t.r2,
    }));
  }
  const btnChanges: Record<string, boolean> = {};
  for (const [key, val] of Object.entries(input.changes)) {
    if (key === 'sticks' || key === 'l2_analog' || key === 'r2_analog') continue;
    if (typeof val === 'boolean') btnChanges[key] = val;
  }
  if (Object.keys(btnChanges).length > 0) {
    buttonState.update((b) => ({ ...b, ...btnChanges }));
  }
  touchPoints.set(input.touchPoints);
  if (input.batteryStatus.changed) {
    batteryStatus.set(input.batteryStatus);
  }
  micConnected.set(input.micConnected);
  headphoneConnected.set(input.headphoneConnected);
  imuState.set(input.imu);
}
