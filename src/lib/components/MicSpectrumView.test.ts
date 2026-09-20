// @vitest-environment jsdom
import { render, screen, waitFor, cleanup } from '@testing-library/svelte';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import MicSpectrumView from './MicSpectrumView.svelte';
import { initI18n } from '$lib/i18n/init';

// MicSpectrumView reads the DualSense mic via navigator.mediaDevices. jsdom
// has no mediaDevices, no AudioContext and no canvas 2D — we stub mediaDevices
// so the component hits its error paths (#125). The success path (FFT render)
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

describe('MicSpectrumView error localization (#125)', () => {
  it('shows the localized no-device message when no DualSense mic is found', async () => {
    stubMediaDevices([]);
    render(MicSpectrumView, { props: { active: true } });
    await waitFor(() => {
      // Canonical tester.micNotFound wording (15d) — same key SpeakerMicLoopback uses.
      expect(
        screen.getByText(
          'Kein DualSense-Mikrofon gefunden. Controller per USB verbinden und Mic-Freigabe erteilen.'
        )
      ).toBeInTheDocument();
    });
  });

  it('shows the localized denied message when getUserMedia rejects with NotAllowedError', async () => {
    stubMediaDevices([ds5Mic], async () => {
      throw new DOMException('denied', 'NotAllowedError');
    });
    render(MicSpectrumView, { props: { active: true } });
    await waitFor(() => {
      expect(
        screen.getByText('Mikrofon-Zugriff verweigert. Bitte in den Browser-Einstellungen erlauben.')
      ).toBeInTheDocument();
    });
  });

  it('shows the localized error message with the cause on a generic failure', async () => {
    stubMediaDevices([ds5Mic], async () => {
      throw new Error('boom');
    });
    render(MicSpectrumView, { props: { active: true } });
    await waitFor(() => {
      expect(screen.getByText('Mikrofon-Fehler: boom')).toBeInTheDocument();
    });
  });
});