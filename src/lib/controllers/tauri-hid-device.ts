import { invoke } from '@tauri-apps/api/core';
import type { HIDDeviceLike } from './base-controller';

export interface HidDeviceInfo {
  vendor_id: number;
  product_id: number;
  manufacturer: string | null;
  product: string | null;
  serial_number: string | null;
  usage_page: number;
  usage: number;
  /** OS-level device path (e.g. `/dev/hidraw4`) — empty string when unknown. */
  path: string;
}

export interface HidReport {
  report_id: number;
  data: number[];
}

export interface HidPollResult {
  connected: boolean;
  reports: HidReport[];
  dropped_reports: number;
}

/**
 * Implements HIDDeviceLike via Rust hidapi backend instead of WebHID.
 * Mirrors the same protocol as WebHID so existing controller logic (DS5Controller, etc.)
 * works without modification.
 */
export class TauriHIDDevice implements HIDDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  /** Device path this instance was opened with (undefined = VID/PID open). */
  readonly path?: string;

  opened = true;

  // Stub descriptor: reportCount 64 covers all DS5 feature reports (≤64 bytes).
  collections = [
    {
      featureReports: Array.from({ length: 256 }, (_, i) => ({
        reportId: i,
        items: [{ reportCount: 64 }],
      })),
    },
  ];

  oninputreport:
    ((event: { device: HIDDeviceLike; reportId: number; data: DataView }) => void) | null = null;

  constructor(vendorId: number, productId: number, path?: string) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.path = path;
  }

  async sendFeatureReport(reportId: number, data: BufferSource): Promise<void> {
    const buf = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
    const bytes = Array.from(new Uint8Array(buf));
    await invoke<void>('hid_send_feature_report', { reportId, data: bytes });
  }

  async receiveFeatureReport(reportId: number): Promise<DataView> {
    const bytes = await invoke<number[]>('hid_receive_feature_report', { reportId, length: 64 });
    return new DataView(new Uint8Array(bytes).buffer);
  }

  async sendReport(reportId: number, data: BufferSource): Promise<void> {
    const buf = data instanceof ArrayBuffer ? data : (data as ArrayBufferView).buffer;
    const bytes = [reportId, ...Array.from(new Uint8Array(buf))];
    await invoke<void>('hid_send_output_report', { data: bytes });
  }

  async close(): Promise<void> {
    this.opened = false;
    await invoke<void>('hid_disconnect');
  }
}

export async function hidConnect(
  vendorId: number,
  productId: number,
  path?: string
): Promise<TauriHIDDevice> {
  await invoke<void>('hid_connect', { vendorId, productId, path: path ?? null });
  return new TauriHIDDevice(vendorId, productId, path);
}

export async function hidListDevices(): Promise<HidDeviceInfo[]> {
  return invoke<HidDeviceInfo[]>('hid_list_devices');
}
