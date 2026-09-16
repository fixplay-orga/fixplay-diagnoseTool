<script lang="ts">
  import { onDestroy } from 'svelte';
  import { get } from 'svelte/store';
  import LL from '$lib/i18n/i18n-svelte';
  import {
    Gamepad2,
    Usb,
    Battery,
    BatteryCharging,
    Bluetooth,
    Mic,
    Headphones,
    Activity,
    Wrench,
    Zap,
    Lightbulb,
    RefreshCw,
    Power,
    Crosshair,
    Copy,
    WrapText,
    Download,
    Clock,
    Undo2,
  } from 'lucide-svelte';
  import { copyToClipboard } from '$lib/utils/clipboard';
  import { save as saveDialog } from '@tauri-apps/plugin-dialog';
  import { saveTextFile } from '$lib/api/tauri';
  import {
    logTimestampFormat,
    formatLogTimestamp,
    setLogTimestampFormat,
    type LogTimestampFormat,
  } from '$lib/utils/time';
  import StickVisualizer from './StickVisualizer.svelte';
  import DriftSparkline from './DriftSparkline.svelte';
  import ControllerVisualizer from './ControllerVisualizer.svelte';
  import TesterPanel from './TesterPanel.svelte';
  import CalibrationModal from './CalibrationModal.svelte';
  import QuickTestModal from './QuickTestModal.svelte';
  import {
    controllerConnected,
    controllerModel,
    controllerInfo,
    controllerTransport,
    batteryStatus,
    buttonState,
    triggerState,
    stickState,
    stickDeadzone,
    setStickDeadzonePercent,
    stickCircularity,
    controllerLog,
    pushControllerLog,
    applyProcessedInput,
    micConnected,
    headphoneConnected,
  } from '$lib/stores/controller';
  import { invoke } from '@tauri-apps/api/core';
  import { DS5Controller } from '$lib/controllers/ds5-controller';
  import { applyDeadzone } from '$lib/controllers/controller-manager';
  import {
    createControllerManager,
    createControllerForDevice,
    type ControllerManager,
    type ProcessedInput,
  } from '$lib/controllers/controller-manager';
  import {
    hidConnect,
    hidListDevices,
    hidDiagnostics,
    type HidPollResult,
    type HidDeviceInfo,
    type HidDiagnostics,
  } from '$lib/controllers/tauri-hid-device';

  let manager = $state<ControllerManager | null>(null);
  let calibOpen = $state(false);
  let circOpen = $state(false);
  let quickTestOpen = $state(false);
  let connecting = $state(false);
  let connectError = $state<string | null>(null);
  // Device picker: shown when several DualSenses (USB/BT) are listed at once.
  let pickerOpen = $state(false);
  let pickerDevices = $state<HidDeviceInfo[]>([]);
  let fwVersion = $state<string>('—');
  let macAddress = $state<string>('—');
  let copied = $state<string | null>(null);
  let wrapLog = $state(false);
  // In-memory calibration undo: a snapshot of the controller's finetune module
  // data taken on connect (and after every successful flash). "Verwerfen" writes
  // it back, discarding calibration changes made since the snapshot without
  // touching the persisted NVS — the discard counterpart to "Speichern".
  let calibSnapshot = $state<number[] | null>(null);

  async function snapshotCalibration(): Promise<void> {
    if (!manager) {
      calibSnapshot = null;
      return;
    }
    try {
      calibSnapshot = await manager.getInMemoryModuleData();
    } catch {
      calibSnapshot = null;
    }
  }
  const driftLeft = $derived(Math.sqrt($stickState.left.x ** 2 + $stickState.left.y ** 2));
  const driftRight = $derived(Math.sqrt($stickState.right.x ** 2 + $stickState.right.y ** 2));

  async function doCopy(text: string, label: string) {
    await copyToClipboard(text, (ok) => {
      if (ok) {
        copied = label;
        setTimeout(() => (copied = null), 1500);
      }
    });
  }

  function logToText(): string {
    return $controllerLog
      .map(
        (e) =>
          `${formatLogTimestamp(e.timestamp_ms, $logTimestampFormat)} [${e.level}] ${e.message}`
      )
      .join('\n');
  }

  async function copyLog() {
    await copyToClipboard(logToText(), (ok) => {
      if (ok) {
        copied = get(LL).controller.copyLog();
        setTimeout(() => (copied = null), 1500);
      }
    });
  }

  async function exportLog() {
    const path = await saveDialog({
      title: get(LL).controller.saveLogDialogTitle(),
      defaultPath: `controller-log-${Date.now()}.txt`,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    }).catch(() => null);
    if (path && typeof path === 'string') {
      await saveTextFile(path, logToText()).catch(console.error);
      copied = get(LL).controller.copyLogSaved();
      setTimeout(() => (copied = null), 1500);
    }
  }
  let pollInterval: ReturnType<typeof setInterval> | null = null;

  async function connect() {
    connecting = true;
    connectError = null;
    try {
      const all = await hidListDevices();
      const ds5 = all.filter(
        (d) => d.vendor_id === 0x054c && [0x0ce6, 0x0e5f, 0x0df2].includes(d.product_id)
      );
      if (ds5.length === 0) throw new Error(get(LL).controller.noDualSenseError());
      if (ds5.length === 1) {
        pickerOpen = false;
        await connectDevice(ds5[0]);
        return;
      }
      pickerDevices = ds5;
      pickerOpen = true;
    } catch (e) {
      connectError = e instanceof Error ? e.message : String(e);
      pushControllerLog(get(LL).controller.connectFailedLog({ error: connectError }), 'error');
    } finally {
      connecting = false;
    }
  }

  async function connectDevice(info: HidDeviceInfo) {
    connecting = true;
    connectError = null;
    pickerOpen = false;
    try {
      const device = await hidConnect(info.vendor_id, info.product_id, info.path || undefined);
      const ctrl = createControllerForDevice(device);
      if (!ctrl) throw new Error(get(LL).controller.unsupportedError());

      manager = createControllerManager();
      manager.setControllerInstance(ctrl);
      manager.setInputHandler((input: ProcessedInput) => applyProcessedInput(input));

      controllerConnected.set(true);
      controllerModel.set(ctrl.getModel());

      // Start polling before getInfo so transport (USB vs BT) is detected
      // from the first input report. Feature-report writes need correct CRC
      // framing on Bluetooth, and transport defaults to 'usb' until an input
      // report arrives — without this, getBdAddr's 0x80 write would be sent
      // without CRC on BT and silently dropped by the controller.
      pollInterval = setInterval(async () => {
        try {
          const result = await invoke<HidPollResult>('hid_poll');
          if (!result.connected) {
            await disconnect();
            return;
          }
          for (const report of result.reports) {
            const data = new DataView(new Uint8Array(report.data).buffer);
            manager?.processControllerInput({ data, reportId: report.report_id });
          }
          controllerTransport.set(manager?.getTransport() ?? 'usb');
        } catch {
          // ignore transient poll errors
        }
      }, 16);

      // Wait (max 1.5 s) for the first input report to set the transport.
      // Feature reports over BT need CRC framing; sending earlier would be
      // dropped silently by the controller. The poll interval is already
      // running and feeding inputs.
      const deadline = Date.now() + 1500;
      while (manager && manager.getTransport() === 'usb' && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 16));
      }

      const devInfo = await ctrl.getInfo();
      if (!devInfo.ok) {
        throw new Error(get(LL).controller.infoFailed({ error: String(devInfo.error) }));
      }
      controllerInfo.set(devInfo);
      fwVersion = devInfo.infoItems?.find((i) => i.key === 'FW Version')?.value ?? '—';
      macAddress = devInfo.infoItems?.find((i) => i.key === 'Bluetooth Address')?.value ?? '—';
      // Lightbar-Baseline: hebt den Kernel-LIGHT_OUT-Zustand auf und bestätigt mit
      // einem blauen Lichtblitz, dass Writes ankommen. Nicht fatal bei Fehlern.
      if (ctrl instanceof DS5Controller) {
        await ctrl.initializeCurrentOutputState();
      }
      pushControllerLog(get(LL).controller.connectedLog({ model: ctrl.getModel() }), 'info');
      // Snapshot the in-memory finetune data so "Verwerfen" can undo calibration
      // changes made this session back to the connected state.
      await snapshotCalibration();
    } catch (e) {
      connectError = e instanceof Error ? e.message : String(e);
      pushControllerLog(get(LL).controller.connectFailedLog({ error: connectError }), 'error');
    } finally {
      connecting = false;
    }
  }

  async function disconnect() {
    if (pollInterval !== null) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    if (manager) {
      await manager.disconnect();
      manager = null;
    }
    controllerTransport.set('usb');
    calibSnapshot = null;
    controllerConnected.set(false);
    controllerModel.set(null);
    controllerInfo.set(null);
    buttonState.set({});
    triggerState.set({ l2: 0, r2: 0 });
    stickState.set({ left: { x: 0, y: 0 }, right: { x: 0, y: 0 } });
    pushControllerLog(get(LL).controller.disconnectedLog(), 'info');
  }

  async function flashController() {
    if (!manager) return;
    try {
      const res = await manager.flash();
      pushControllerLog(
        res.success ? get(LL).controller.saveDoneLog() : res.message,
        res.success ? 'info' : 'error'
      );
      // Persisting the in-memory changes makes them the new undo baseline.
      if (res.success) await snapshotCalibration();
    } catch (e) {
      pushControllerLog(
        get(LL).controller.flashFailedLog({ error: e instanceof Error ? e.message : String(e) }),
        'error'
      );
    }
  }

  async function undoCalibration() {
    if (!manager || !calibSnapshot) return;
    try {
      await manager.writeFinetuneData(calibSnapshot);
      pushControllerLog(get(LL).controller.undoLog(), 'info');
    } catch (e) {
      pushControllerLog(
        get(LL).controller.undoFailedLog({ error: e instanceof Error ? e.message : String(e) }),
        'error'
      );
    }
  }

  async function resetController() {
    if (!manager) return;
    try {
      await manager.reset();
      pushControllerLog(get(LL).controller.resetLog(), 'info');
    } catch (e) {
      pushControllerLog(
        get(LL).controller.resetFailedLog({ error: e instanceof Error ? e.message : String(e) }),
        'error'
      );
    }
  }

  onDestroy(() => {
    disconnect().catch(() => {});
  });

  // --- HID diagnostics (#124) -------------------------------------------------
  // 2 s poll, ONLY while the collapsible block is open (no extra traffic while
  // closed or disconnected). Errors (device gone, no backend in dev/mock-less
  // contexts) keep the last value / the null placeholders.
  let diagOpen = $state(false);
  let diag = $state<HidDiagnostics | null>(null);

  async function pollDiagnostics(): Promise<void> {
    try {
      diag = await hidDiagnostics();
    } catch {
      // ignore — the block keeps its placeholders
    }
  }

  $effect(() => {
    if (diagOpen) {
      void pollDiagnostics();
      const t = setInterval(pollDiagnostics, 2000);
      return () => clearInterval(t);
    }
  });
</script>

<div class="flex h-full flex-col gap-4 p-4 overflow-y-auto">
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <Gamepad2 class="h-6 w-6 text-blue-500" />
      <div>
        <h1 class="text-lg font-semibold text-gray-100">{$LL.header.controller()}</h1>
        <p class="text-xs text-gray-500">{$LL.controller.subtitle()}</p>
      </div>
    </div>
    <div class="flex items-center gap-2">
      {#if $controllerConnected}
        <button
          class="flex items-center gap-1.5 rounded-lg bg-red-600/20 px-3 py-2 text-sm text-red-400 hover:bg-red-600/30"
          onclick={disconnect}
        >
          <Power class="h-4 w-4" />
          {$LL.controller.disconnectBtn()}
        </button>
      {:else}
        <button
          class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          onclick={connect}
          disabled={connecting}
        >
          <Usb class="h-4 w-4" />
          {connecting ? $LL.controller.connecting() : $LL.controller.connectBtn()}
        </button>
      {/if}
    </div>
  </div>

  {#if connectError}
    <div class="rounded-lg bg-red-900/30 p-3 text-sm text-red-300">{connectError}</div>
  {/if}

  {#if pickerOpen}
    <div
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
    >
      <div class="w-full max-w-md rounded-2xl bg-gray-900 p-5 shadow-2xl">
        <h2 class="mb-3 text-lg font-semibold text-gray-100">{$LL.controller.pickerTitle()}</h2>
        <div class="flex flex-col gap-2">
          {#each pickerDevices as dev (dev.path)}
            <button
              class="flex flex-col items-start rounded-lg bg-gray-800 px-3 py-2 text-left hover:bg-gray-700"
              onclick={() => connectDevice(dev)}
            >
              <span class="text-sm text-gray-100"
                >{dev.product || $LL.controller.pickerUnknown()}</span
              >
              <span class="text-xs text-gray-500">
                {#if dev.serial_number}{dev.serial_number} ·
                {/if}{dev.path}
              </span>
            </button>
          {/each}
          <button
            class="mt-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:text-gray-200"
            onclick={() => (pickerOpen = false)}
          >
            {$LL.common.cancel()}
          </button>
        </div>
      </div>
    </div>
  {/if}

  {#if !$controllerConnected}
    <div class="flex flex-1 flex-col items-center justify-center gap-4 text-center">
      <Gamepad2 class="h-16 w-16 text-gray-600" />
      <div>
        <p class="text-gray-400">{$LL.controller.notConnected()}</p>
        <p class="text-sm text-gray-600">{$LL.controller.notConnectedHint()}</p>
      </div>
    </div>
  {:else}
    <!-- Status row (#124): transport / battery / mic+headphone badges, derived
         from the existing poll stores — no extra polling. -->
    <div
      class="flex flex-wrap items-center gap-2 rounded-lg bg-gray-900 px-3 py-2"
      data-testid="status-row"
    >
      <span
        class="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-200"
        data-testid="transport-badge"
        title={$LL.controller.transportTitle({
          transport:
            $controllerTransport === 'bt'
              ? $LL.controller.transportBt()
              : $LL.controller.transportUsb(),
        })}
      >
        {#if $controllerTransport === 'bt'}
          <Bluetooth class="h-3 w-3 text-blue-400" />
          {$LL.controller.transportBt()}
        {:else}
          <Usb class="h-3 w-3 text-gray-400" />
          {$LL.controller.transportUsb()}
        {/if}
      </span>
      <span
        class="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-xs {$batteryStatus.is_error
          ? 'text-red-400'
          : 'text-gray-200'}"
        data-testid="battery-badge"
        title={$LL.controller.batteryTitle()}
      >
        {#if $batteryStatus.is_charging}
          <BatteryCharging class="h-3 w-3 text-green-400" />
        {:else}
          <Battery class="h-3 w-3 text-gray-400" />
        {/if}
        {$batteryStatus.bat_txt || '—'}
      </span>
      {#if $micConnected}
        <span
          class="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-200"
          data-testid="mic-badge"
          title={$LL.controller.micBadge()}
        >
          <Mic class="h-3 w-3 text-teal-400" />
        </span>
      {/if}
      {#if $headphoneConnected}
        <span
          class="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-xs text-gray-200"
          data-testid="headphone-badge"
          title={$LL.controller.headphoneBadge()}
        >
          <Headphones class="h-3 w-3 text-teal-400" />
        </span>
      {/if}
    </div>

    <!-- Info bar -->
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <div class="rounded-lg bg-gray-800/60 p-3" title={$LL.controller.modelTitle()}>
        <div class="text-xs text-gray-500">{$LL.controller.model()}</div>
        <div class="text-sm font-medium text-gray-200">{$controllerModel ?? '—'}</div>
      </div>
      <div class="rounded-lg bg-gray-800/60 p-3" title={$LL.controller.batteryTitle()}>
        <div class="text-xs text-gray-500">{$LL.controller.battery()}</div>
        <div
          class="flex items-center gap-1.5 text-sm font-medium {$batteryStatus.is_error
            ? 'text-red-400'
            : 'text-gray-200'}"
          title={$batteryStatus.is_error
            ? $LL.controller.batteryErrorTitle()
            : $LL.controller.batteryTitle()}
        >
          <Battery class="h-4 w-4" />
          {$batteryStatus.bat_txt || '—'}
        </div>
      </div>
      <div class="rounded-lg bg-gray-800/60 p-3" title={$LL.controller.macTitle()}>
        <div class="text-xs text-gray-500">{$LL.controller.mac()}</div>
        <div class="flex items-center justify-between gap-1">
          <div class="text-sm font-medium text-gray-200 truncate">{macAddress}</div>
          <button
            class="text-gray-600 hover:text-gray-300 shrink-0"
            onclick={() => doCopy(macAddress, $LL.controller.copyMac())}
            title={$LL.controller.copyMacTitle()}
          >
            <Copy class="h-3 w-3" />
          </button>
        </div>
      </div>
      <div class="rounded-lg bg-gray-800/60 p-3" title={$LL.controller.fwTitle()}>
        <div class="text-xs text-gray-500">{$LL.controller.firmware()}</div>
        <div class="flex items-center justify-between gap-1">
          <div class="text-sm font-medium text-gray-200 truncate">{fwVersion}</div>
          <button
            class="text-gray-600 hover:text-gray-300 shrink-0"
            onclick={() => doCopy(fwVersion, $LL.controller.copyFw())}
            title={$LL.controller.copyFwTitle()}
          >
            <Copy class="h-3 w-3" />
          </button>
        </div>
      </div>
    </div>

    <!-- BT feature-flow gate (#120): calibration/NVS/save need USB -->
    {#if $controllerTransport === 'bt'}
      <div
        class="rounded-lg border border-amber-700/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200"
      >
        {$LL.controller.btFeatureGate()}
      </div>
    {/if}

    <!-- Quick actions — calibration, circularity test, quick test (most important, at top) -->
    <div class="flex flex-wrap gap-2">
      <button
        class="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={() => (calibOpen = true)}
        disabled={$controllerTransport === 'bt'}
        title={$controllerTransport === 'bt'
          ? $LL.controller.btFeatureGate()
          : $LL.controller.calibration()}
      >
        <Wrench class="h-4 w-4" />
        {$LL.controller.calibration()}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-teal-600 px-4 py-2 text-sm text-white hover:bg-teal-700 disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={() => (circOpen = true)}
        disabled={$controllerTransport === 'bt'}
        title={$controllerTransport === 'bt'
          ? $LL.controller.btFeatureGate()
          : $LL.controller.circularity()}
      >
        <Crosshair class="h-4 w-4" />
        {$LL.controller.circularity()}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-purple-600 px-4 py-2 text-sm text-white hover:bg-purple-700"
        onclick={() => (quickTestOpen = true)}
      >
        <Zap class="h-4 w-4" />
        {$LL.controller.quickTest()}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-amber-600/20 px-4 py-2 text-sm text-amber-400 hover:bg-amber-600/30 disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={flashController}
        disabled={$controllerTransport === 'bt'}
        title={$controllerTransport === 'bt'
          ? $LL.controller.btFeatureGate()
          : $LL.controller.saveTitle()}
      >
        <Lightbulb class="h-4 w-4" />
        {$LL.controller.save()}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600 disabled:opacity-40 disabled:cursor-not-allowed"
        onclick={undoCalibration}
        disabled={!calibSnapshot || $controllerTransport === 'bt'}
        title={$controllerTransport === 'bt'
          ? $LL.controller.btFeatureGate()
          : calibSnapshot
            ? $LL.controller.discardTitleAvail()
            : $LL.controller.discardTitleNone()}
      >
        <Undo2 class="h-4 w-4" />
        {$LL.controller.discard()}
      </button>
      <button
        class="flex items-center gap-1.5 rounded-lg bg-gray-700 px-4 py-2 text-sm text-gray-300 hover:bg-gray-600"
        onclick={resetController}
      >
        <RefreshCw class="h-4 w-4" />
        {$LL.controller.reset()}
      </button>
    </div>

    <!-- Live controller graphic — buttons/sticks/triggers highlight as pressed -->
    <div class="rounded-xl bg-gray-800/40 p-4">
      <div class="mb-2 flex items-center gap-2 text-sm font-medium text-gray-300">
        <Gamepad2 class="h-4 w-4" />
        {$LL.controller.liveController()}
      </div>
      <div class="flex justify-center">
        <ControllerVisualizer size={460} />
      </div>
    </div>

    <!-- Manual testers: lights / vibration / adaptive triggers -->
    <TesterPanel {manager} />

    <!-- Sticks -->
    <div class="rounded-xl bg-gray-800/40 p-4">
      <div class="mb-3 flex items-center gap-2 text-sm font-medium text-gray-300">
        <Activity class="h-4 w-4" />
        {$LL.controller.sticks()}
      </div>
      <!-- Deadzone slider (#124): radial display deadzone for the visualizers
           only (applyDeadzone) — never written to the protocol. -->
      <div class="mb-3 flex items-center gap-2 text-xs text-gray-500">
        <label class="shrink-0" for="stick-deadzone">{$LL.controller.deadzoneLabel()}</label>
        <input
          id="stick-deadzone"
          data-testid="deadzone-slider"
          type="range"
          min="0"
          max="20"
          step="1"
          class="w-40 accent-teal-500"
          value={Math.round($stickDeadzone * 100)}
          oninput={(e) => setStickDeadzonePercent(Number(e.currentTarget.value))}
          title={$LL.controller.deadzoneTitle()}
        />
        <span class="w-10 shrink-0 tabular-nums">{Math.round($stickDeadzone * 100)} %</span>
      </div>
      <div class="flex justify-center gap-6">
        <div class="flex flex-col items-center gap-2">
          <StickVisualizer
            side="left"
            size={140}
            enableZoomCenter
            deadzone={$stickDeadzone}
            stick={applyDeadzone(
              $stickState.left.x,
              $stickState.left.y,
              Math.round($stickDeadzone * 100)
            )}
            circularityData={$stickCircularity.left}
          />
          <span class="text-xs text-gray-500">{$LL.controller.stickLeft()}</span>
          <span
            class="text-[10px] {driftLeft < 0.05
              ? 'text-green-500'
              : driftLeft < 0.15
                ? 'text-amber-400'
                : 'text-red-400'}"
          >
            {$LL.controller.drift({ value: (driftLeft * 100).toFixed(1) })}
          </span>
          <DriftSparkline side="left" />
        </div>
        <div class="flex flex-col items-center gap-2">
          <StickVisualizer
            side="right"
            size={140}
            enableZoomCenter
            deadzone={$stickDeadzone}
            stick={applyDeadzone(
              $stickState.right.x,
              $stickState.right.y,
              Math.round($stickDeadzone * 100)
            )}
            circularityData={$stickCircularity.right}
          />
          <span class="text-xs text-gray-500">{$LL.controller.stickRight()}</span>
          <span
            class="text-[10px] {driftRight < 0.05
              ? 'text-green-500'
              : driftRight < 0.15
                ? 'text-amber-400'
                : 'text-red-400'}"
          >
            {$LL.controller.drift({ value: (driftRight * 100).toFixed(1) })}
          </span>
          <DriftSparkline side="right" />
        </div>
      </div>
    </div>

    <!-- Triggers -->
    <div class="rounded-xl bg-gray-800/40 p-4">
      <div class="mb-3 text-sm font-medium text-gray-300">{$LL.controller.triggers()}</div>
      <div class="grid grid-cols-2 gap-4">
        <div>
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <span>L2</span><span>{$triggerState.l2}</span>
          </div>
          <div class="h-3 overflow-hidden rounded-full bg-gray-700">
            <div
              class="h-full bg-blue-500 transition-all"
              style="width: {($triggerState.l2 / 255) * 100}%"
            ></div>
          </div>
        </div>
        <div>
          <div class="mb-1 flex justify-between text-xs text-gray-500">
            <span>R2</span><span>{$triggerState.r2}</span>
          </div>
          <div class="h-3 overflow-hidden rounded-full bg-gray-700">
            <div
              class="h-full bg-blue-500 transition-all"
              style="width: {($triggerState.r2 / 255) * 100}%"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- Log -->
    <div class="rounded-xl bg-gray-900/60 p-3">
      <div class="mb-2 flex items-center justify-between">
        <span class="text-xs font-medium text-gray-500">{$LL.controller.log()}</span>
        <div class="flex items-center gap-1">
          <button
            class="text-gray-600 hover:text-gray-300 p-0.5"
            onclick={copyLog}
            title={$LL.controller.copyLogTitle()}
          >
            <Copy class="h-3 w-3" />
          </button>
          <button
            class="text-gray-600 hover:text-gray-300 p-0.5"
            onclick={exportLog}
            title={$LL.controller.saveLogTitle()}
          >
            <Download class="h-3 w-3" />
          </button>
          <button
            class="text-gray-600 hover:text-gray-300 p-0.5"
            onclick={() => {
              const order: LogTimestampFormat[] = ['local', 'iso', 'seconds'];
              const cur = $logTimestampFormat;
              setLogTimestampFormat(order[(order.indexOf(cur) + 1) % order.length]);
            }}
            title={$LL.controller.timestampTitle({ format: $logTimestampFormat })}
          >
            <Clock class="h-3 w-3" />
          </button>
          <button
            class="text-gray-600 hover:text-gray-300 p-0.5"
            onclick={() => (wrapLog = !wrapLog)}
            title={wrapLog ? $LL.controller.wrapOff() : $LL.controller.wrapOn()}
          >
            <WrapText class="h-3 w-3 {wrapLog ? 'text-teal-400' : ''}" />
          </button>
          <button
            class="text-gray-600 hover:text-gray-300 p-0.5"
            onclick={() => controllerLog.set([])}
            title={$LL.controller.clearLogTitle()}
          >
            <RefreshCw class="h-3 w-3" />
          </button>
        </div>
      </div>
      <div
        class="max-h-40 space-y-1 overflow-y-auto text-xs font-mono {wrapLog
          ? 'break-words'
          : 'whitespace-nowrap'}"
      >
        {#each $controllerLog as entry (entry.id)}
          <div
            class={entry.level === 'error'
              ? 'text-red-400'
              : entry.level === 'warn'
                ? 'text-amber-400'
                : 'text-gray-400'}
          >
            <span class="text-gray-600"
              >{formatLogTimestamp(entry.timestamp_ms, $logTimestampFormat)}</span
            >
            {entry.message}
          </div>
        {/each}
      </div>
    </div>
    {#if copied}
      <div
        class="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-lg bg-teal-600 px-4 py-2 text-xs text-white shadow-lg z-50 transition-opacity"
      >
        {$LL.controller.copiedToast({ label: copied })}
      </div>
    {/if}

    <!-- HID diagnostics block (#124): collapsible, 2 s poll only while open. -->
    <details
      class="rounded-xl bg-gray-900/60 px-3 py-2 text-xs text-gray-400"
      data-testid="hid-diagnostics"
      bind:open={diagOpen}
    >
      <summary class="cursor-pointer select-none">{$LL.controller.diagnosticsTitle()}</summary>
      <div class="mt-2 grid grid-cols-2 gap-1">
        <span>{$LL.controller.diagWrites()}: {diag?.write_count ?? 0}</span>
        <span>{$LL.controller.diagWriteErrors()}: {diag?.write_errors ?? 0}</span>
        <span>{$LL.controller.diagDropped()}: {diag?.dropped_reports ?? 0}</span>
        <span class="truncate">{$LL.controller.diagPath()}: {diag?.open_path ?? '—'}</span>
        {#if diag?.last_write_error}
          <span class="col-span-2 text-red-300"
            >{$LL.controller.diagLastWriteError()}: {diag.last_write_error}</span
          >
        {/if}
      </div>
    </details>
  {/if}
</div>

<CalibrationModal bind:open={calibOpen} {manager} />
<CalibrationModal bind:open={circOpen} {manager} initialMode="range" />
<QuickTestModal bind:open={quickTestOpen} {manager} transport={$controllerTransport} />
