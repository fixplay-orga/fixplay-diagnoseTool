// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MicLevelMeter from './MicLevelMeter.svelte';
import { initI18n } from '$lib/i18n/init';

// MicLevelMeter reads the DualSense mic via navigator.mediaDevices. jsdom has
// no mediaDevices and no AudioContext — we stub mediaDevices so the component
// hits its two error paths (#125): no DualSense device found, and a denied /
// generic getUserMedia failure. The success path (AudioContext + AnalyserNode)
// is out of scope here — jsdom has no WebAudio.

interface StubDevice {
  kind: string;
  label: string;
  deviceId: string;
}

function stubMediaDevices(devices: StubDevice[], getUserMedia?: () => Promise<MediaStream>) {
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    get: () => ({
      enumerateDevices: async () => devices,
      getUserMedia,
    }),
  });
}

const ds5Mic: StubDevice = { kind: 'audioinput', label: 'DualSense', deviceId: 'mic-1' };

beforeEach(() => {
  initI18n();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  // Restore the (undefined) original so tests don't leak the stub.
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, get: () => undefined });
});

describe('MicLevelMeter error localization (#125)', () => {
  it('shows the localized no-device message when no DualSense mic is found', async () => {
    stubMediaDevices([]);
    render(MicLevelMeter, { props: { active: true } });
    await waitFor(() => {
      expect(screen.getByText('Kein DualSense-Mikrofon gefunden')).toBeInTheDocument();
    });
  });

  it('shows the localized denied message when getUserMedia rejects with NotAllowedError', async () => {
    stubMediaDevices([ds5Mic], async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(MicLevelMeter, { props: { active: true } });
    await waitFor(() => {
      expect(
        screen.getByText('Mikrofon-Zugriff verweigert — in den Systemeinstellungen erlauben')
      ).toBeInTheDocument();
    });
  });

  it('shows the localized error message with the cause on a generic failure', async () => {
    stubMediaDevices([ds5Mic], async () => {
      throw new Error('boom');
    });
    render(MicLevelMeter, { props: { active: true } });
    await waitFor(() => {
      expect(screen.getByText('Mikrofon-Fehler: boom')).toBeInTheDocument();
    });
  });
});