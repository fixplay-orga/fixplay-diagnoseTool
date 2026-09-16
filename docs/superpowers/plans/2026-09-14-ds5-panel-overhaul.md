# DS5-Controller-Panel: Überarbeitung „Reparieren + Aufrüsten" — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** DualSense-Panel im diagnoseTool komplett überarbeiten: den Lichttest-Root-Cause fixen (flag2/lightbar_setup war nie sendbar), Rust-HID-Layer robuster machen (async, Unplug-Erkennung, Write-Ergebnis), Bluetooth sauber unterstützen (inkl. BT-Verbindungstest), Kalibrierung/QuickTest-Lifecycle reparieren, Mock-Parität herstellen und UI (Picker, Statuszeile, HID-Diagnose, i18n) aufrüsten.

**Architecture:** Frontend-Protokoll-Layer (`src/lib/controllers/ds5-controller.ts`) wird um die verifizierten fehlenden Bytes (valid_flag2-Region) erweitert, ohne das als korrekt verifizierte USB-Byte-Layout zu ändern. Rust `src-tauri/src/commands/hid.rs` wird auf `Arc<HidShared>`-State + async Commands + spawn_blocking umgebaut. Bluetooth läuft über den bestehenden Transport-Layer mit CRC-Validierung beider Richtungen. Mock-Layer spiegelt Output-Reports und Feature-Responses protokollgerecht.

**Tech Stack:** SvelteKit 2/Svelte 5 (runes) + TypeScript + Vitest + typesafe-i18n (de first) / Rust 2021 workspace + hidapi 2.x + Tauri v2 Commands.

**Spec:** `docs/superpowers/specs/2026-09-14-ds5-panel-overhaul-design.md` (16 verifizierte Bugs mit file:line, Byte-Layout-Verifikation gegen 4 Quellen)

## Global Constraints

Diese gelten für **jede** Aufgabe implizit:

- **Host hat kein cargo, nur Node 18** — alles über Docker:
  - Frontend-Tests: `docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 npx vitest run <pfad>`
  - Frontend-Check: `docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 npm run check`
  - Rust-Tests: `docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app rust:1.86 sh -lc "apt-get update -qq && apt-get install -y -qq libudev-dev pkg-config >/dev/null && cargo test --workspace"`
  - Lint: gleiches Docker-Pattern mit `cargo clippy --workspace -- -D warnings` bzw. `npm run lint`
- **NIEMALS `cargo fmt` ausführen** (hand-aligned Style, nicht CI-erzwungen). Prettier/eslint für TS wie bisher.
- **Commits:** conventional (`feat:`/`fix:`/`test:`/`refactor:`/`chore:`/`docs:`) + ROADMAP-Item-Nummer: `feat(#111): …`. ROADMAP.md ist das Issue-Tracker-of-Record; neue Items #111–#126 werden in Task 1 angelegt.
- **Frontend-Tests mocken NIEMALS `@tauri-apps/api`** — sie importieren den Mock-Layer (`$lib/mock/core`, `$lib/mock/state`) und treiben Verhalten über `mockState`/`resetMockState()`. Component-Tests brauchen `initI18n()` in `beforeEach`.
- **i18n:** typesafe-i18n, baseLocale `de` — Key zuerst in `src/lib/i18n/de/index.ts`, dann in `en/index.ts` spiegeln (fehlender `en`-Key = Compile-Fehler), danach `npm run i18n` (regeneriert types). `$LL` in Markup, `get(LL)` im Script.
- **Rust-Regeln:** Command-Boundary `Result<T, String>`; User-facing Strings Deutsch, Code/Kommentare Englisch; „sync hardware, async commands" (spawn_blocking); `lock().unwrap()`-Stil; alle 7 HID-Commands bleiben in `lib.rs` registriert (Namen dürfen sich ändern, Registrationen müssen mitziehen).
- **Das USB-Output-Byte-Layout ist als korrekt verifiziert** (kernel `hid-playstation.c`, daidr, Ohjurot DS5-Windows, nondebug explorer): player_leds@43, RGB@44–46, Right-Trigger@10–20, Left-Trigger@21–31, common = 47 Byte. **Nur die bisher genullten Offsets 9/37/38/41/42 dürfen neu beschrieben werden** — nichts anderes verschieben.
- **CRC-Seeds:** BT-Output `0xA2,0x31` (existiert), BT-Feature `0x53` (existiert, seed), BT-Input `0xA1,0xB2` (neu). CRC am Frame-Ende, little-endian.
- **Rust-Tests** sind inline `#[cfg(test)]` auf extrahierte Pure-Functions; es gibt keine `tests/`-Verzeichnisse.

---

## Datei-Map (wer was verantwortet)

| Datei | Verantwortung | Task |
|---|---|---|
| `src/lib/controllers/ds5-controller.ts` | Protokoll: flags, pack(), setter, battery | 1, 2, 3, 4 |
| `src/lib/controllers/base-controller.ts` | defaults für neue Setter | 1, 3 |
| `src/lib/controllers/controller-manager.ts` | Wrappers, Transport-Stats, PID-Liste | 1, 3, 7, 8 |
| `src/lib/components/ControllerPanel.svelte` | connect/pick/Statuszeile/Diagnose/Gating | 2, 4, 7, 8, 10, 14, 15 |
| `src/lib/components/TesterPanel.svelte` | frequency-Verkabelung, Brightness-Slider | 3 |
| `src/lib/components/CalibrationModal.svelte` | Range-Busy-Fix, RangeEnd bei Cancel, Run-Token | 11 |
| `src/lib/components/QuickTestModal.svelte` | Lights-Verdict, Reset bei Close/Unmount, BT-Test | 9, 12 |
| `src-tauri/src/state.rs` | `HidShared` statt 7 Einzel-Felder | 5 |
| `src-tauri/src/commands/hid.rs` | async, Write-Ergebnis, Unplug, Path-Open, Diagnostics | 5, 6, 7 |
| `src/lib/controllers/tauri-hid-device.ts` | path-Param, hidListDevices-Import, hidDiagnostics | 7, 14 |
| `src/lib/controllers/crc32.ts` | BT-Input-CRC validate/fill | 8 |
| `src/lib/mock/{state,core}.ts`, `src/lib/components/MockPanel.svelte` | Mock-Parität | 13 |
| `src/lib/stores/controller.ts` | tote Stores weg, controllerTransport rein | 10, 15 |
| `src/lib/controllers/touch-gesture.ts`, TouchpadGestureVisualizer, mock/core | Touchpad 1920×1080 | 15 |
| `src/lib/i18n/{de,en}/index.ts` | alle neuen Keys | 2, 4, 7, 9, 10, 14, 15 |

---

## Task 1: ROADMAP-Einträge + Protokoll-Layer flag2/lightbar_setup (Lichttest-Root-Cause)

**Files:**
- Modify: `ROADMAP.md` (neue Items anhängen)
- Modify: `src/lib/controllers/ds5-controller.ts:77-84` (flags), `:159-187` (pack), `:693-714` (setLightbarColor)
- Modify: `src/lib/controllers/base-controller.ts` (zwei Default-Setter)
- Modify: `src/lib/controllers/controller-manager.ts` (zwei Wrappers)
- Test: `src/lib/controllers/ds5-controller.test.ts`

**Interfaces:**
- Consumes: bestehendes `DS5OutputStruct`/`OutputState` (Felder `validFlag2`, `lightbarSetup`, `ledBrightness` existieren bereits im Interface), `makeFakeDevice()`-Testharness mit `lastOut()` (`out.data` = Payload OHNE Report-Id-Byte; USB = 47-Byte-common, BT = `[seq,0x10,...common...,crc]`).
- Produces: `DS5_VALID_FLAG1` (bereinigt), `DS5_VALID_FLAG2`, `DS5_LIGHTBAR_SETUP` (module-private consts); `setLightbarSetup(mode: 'light-on' | 'light-out')`, `setLedBrightness(percent: number)` auf `DS5Controller` + `BaseController`-Defaults + `ControllerManager`-Wrappers gleicher Signatur.

- [ ] **Step 1: ROADMAP-Einträge anlegen**

An das Ende von `ROADMAP.md` anhängen (Einzeiler je Item, Format der bestehenden Items folgen):

```markdown
## #111 Protokoll-Layer: flag2/lightbar_setup/led_brightness sendbar machen (Lichttest-Fix)
## #112 Connect-Baseline (blauer Blitz) + Akku-Status 0xF als Fehler
## #113 Adaptive-Trigger-Parametrik pro Modus + setVibration-Flag0-Semantik
## #114 Player-LED-0x20-Legacy-Fallback + lokalisierte Save-Logs
## #115 Rust hid.rs: async Commands, Write-Ergebnis, Feature-Send-Guard, try_send
## #116 Rust hid.rs: Unplug-Erkennung, Teardown-nach-Open, Thread-Join
## #117 Device-Picker + Pfad-Open + Edge-USB-PID 0x0e5f
## #118 BT-Input-CRC-Validierung + Transport-Wait + Transport-Statistiken
## #119 BT-Verbindungstest im QuickTest-Modal
## #120 Feature-Flows über BT sperren („nur über USB")
## #121 Range-Kalibrierung: Busy-Fix, calibrateRangeEnd bei Abbruch, Run-Token
## #122 QuickTest-Lifecycle: Lights-Verdict, Aktuatoren bei Close/Unmount resetten
## #123 Mock-Parität: Output-Spiegelung, Canned-Feature-Responses, BT-Modus, Error-Injection
## #124 Statuszeile + HID-Diagnose-Block + Deadzone-Slider
## #125 Store-Hygiene + Touchpad 1920×1080 + i18n-Leaks
## #126 Deployment auf dev-diagnosetool.fixplay.de + Hardware-Validierung
```

- [ ] **Step 2: Failing Tests schreiben**

In `src/lib/controllers/ds5-controller.test.ts` an das Ende der bestehenden Layout-`describe` anhängen (nutzt den dortigen `makeFakeDevice()`-Helper; `lastOut()` liefert den letzten `{reportId, data}`-Eintrag):

```ts
describe('flag2 / lightbar_setup region (#111)', () => {
  it('setLightbarColor sends valid_flag2 enable + lightbar_setup light-on next to the color', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLightbarColor(255, 0, 0);
    const out = device.lastOut();
    expect(out.reportId).toBe(0x02);
    expect(out.data[1] & 0x04).toBe(0x04); // flag1 LIGHTBAR_COLOR
    expect(out.data[38]).toBe(0x02); // flag2 LIGHTBAR_SETUP_CONTROL_ENABLE
    expect(out.data[41]).toBe(0x00); // lightbar_setup = light-on
    expect(out.data[42]).toBe(255); // led_brightness bleibt voll an
    expect(out.data[44]).toBe(255); // RGB rot
    expect(out.data[45]).toBe(0);
    expect(out.data[46]).toBe(0);
  });

  it('setLightbarSetup("light-out") writes LIGHT_OUT with flag2 enable', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLightbarSetup('light-out');
    const out = device.lastOut();
    expect(out.data[38]).toBe(0x02);
    expect(out.data[41]).toBe(0x02); // LIGHT_OUT
  });

  it('setLedBrightness(50) writes the brightness byte with flag2 enable', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLedBrightness(50);
    const out = device.lastOut();
    expect(out.data[38]).toBe(0x02);
    expect(out.data[42]).toBe(Math.round((50 / 100) * 255)); // 128
  });

  it('setLedBrightness clamps percent to 0..100', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setLedBrightness(500);
    expect(device.lastOut().data[42]).toBe(255);
    await ctrl.setLedBrightness(-10);
    expect(device.lastOut().data[42]).toBe(0);
  });
});
```

- [ ] **Step 3: Tests laufen lassen — erwartet FAIL**

```bash
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 \
  npx vitest run src/lib/controllers/ds5-controller.test.ts
```
Erwartet: FAIL — `ctrl.setLightbarSetup is not a function` (bzw. Layout-Assertions schlagen fehl, weil Out 41/38 nullt).

- [ ] **Step 4: Flags bereinigen + pack() erweitern**

In `ds5-controller.ts` die `DS5_VALID_FLAG1`-Konstante (Zeilen 77–84) ersetzen — die Bits `LED_BRIGHTNESS: 0x20` und `LIGHTBAR_SETUP: 0x40` sind erfunden (kein flag1-Bit dafür im Protokoll) und werden durch die echten Kernel-Bits ersetzt:

```ts
const DS5_VALID_FLAG1 = {
  MUTE_LED: 0x01,
  POWER_SAVE_MUTE: 0x02,
  LIGHTBAR_COLOR: 0x04,
  RELEASE_LEDS: 0x08,
  PLAYER_INDICATOR: 0x10,
  AUDIO_CONTROL2: 0x80,
} as const;

/**
 * valid_flag2 lives at common offset 38 (second flag word). Bit 1
 * (LIGHTBAR_SETUP_CONTROL_ENABLE) gates the lightbar_setup (41) and
 * led_brightness (42) bytes — without it the pad ignores both. The kernel
 * driver leaves the lightbar in LIGHT_OUT (faded) mode when it releases the
 * device, and in that mode pure color writes (flag1 bit2) are visually
 * ignored: this region is the root-cause fix for the "light test does
 * nothing" report.
 */
const DS5_VALID_FLAG2 = {
  LIGHTBAR_SETUP_CONTROL_ENABLE: 0x02,
  COMPATIBLE_VIBRATION2: 0x04,
} as const;

/** lightbar_setup byte values (kernel hid-playstation.c, LIGHT_OUT = BIT(1)). */
const DS5_LIGHTBAR_SETUP = {
  LIGHT_ON: 0x00,
  LIGHT_OUT: 0x02,
} as const;
```

In `pack()` (Zeilen 159–187): `v.setUint8(9, 0);` ersetzen durch `v.setUint8(9, s.powerSaveMuteControl);` und den Zero-Block ersetzen:

```ts
// vorher: for (let i = 32; i <= 42; i++) v.setUint8(i, 0);
for (let i = 32; i <= 36; i++) v.setUint8(i, 0);
v.setUint8(37, s.audioControl2);
v.setUint8(38, s.validFlag2);
v.setUint8(39, 0);
v.setUint8(40, 0);
v.setUint8(41, s.lightbarSetup);
v.setUint8(42, s.ledBrightness);
```

(Offsets 43 playerIndicator, 44–46 RGB bleiben unverändert an ihrem Platz.)

- [ ] **Step 5: setLightbarSetup + setLedBrightness implementieren**

Neue Methoden in `DS5Controller` (Stil wie `setMuteLed`):

```ts
async setLightbarSetup(mode: 'light-on' | 'light-out'): Promise<{ success: boolean; message: string }> {
  try {
    const { validFlag2 } = this.currentOutputState;
    const outputStruct = new DS5OutputStruct({
      ...this.currentOutputState,
      lightbarSetup: mode === 'light-out' ? DS5_LIGHTBAR_SETUP.LIGHT_OUT : DS5_LIGHTBAR_SETUP.LIGHT_ON,
      ledBrightness: this.currentOutputState.ledBrightness || 255,
      validFlag2: validFlag2 | DS5_VALID_FLAG2.LIGHTBAR_SETUP_CONTROL_ENABLE,
    });
    await this.sendOutputReport(outputStruct.pack(), 'set lightbar setup');
    this.updateCurrentOutputState(outputStruct);
    return { success: true, message: '' };
  } catch (error) {
    throw new Error('Failed to set lightbar setup', { cause: error });
  }
}

/** Brightness lives in the valid_flag2 region (led_brightness@42) and is sent
 * with flag2 bit1. percent is UI-friendly 0..100 and scales to 0..255. */
async setLedBrightness(percent = 100): Promise<{ success: boolean; message: string }> {
  try {
    const { validFlag2 } = this.currentOutputState;
    const value = Math.max(0, Math.min(255, Math.round((Math.max(0, Math.min(100, percent)) / 100) * 255)));
    const outputStruct = new DS5OutputStruct({
      ...this.currentOutputState,
      ledBrightness: value,
      validFlag2: validFlag2 | DS5_VALID_FLAG2.LIGHTBAR_SETUP_CONTROL_ENABLE,
    });
    await this.sendOutputReport(outputStruct.pack(), 'set LED brightness');
    this.updateCurrentOutputState(outputStruct);
    return { success: true, message: '' };
  } catch (error) {
    throw new Error('Failed to set LED brightness', { cause: error });
  }
}
```

`setLightbarColor` erweitern — jeder Farbschreibvorgang hebt den Kernel-LIGHT_OUT-Zustand mit auf (das ist der eigentliche Kern-Fix; fehlschlagende Writes bleiben das einzige „gar nichts"-Restrisiko, sichtbar über Task-5-Write-Ergebnisse):

```ts
const outputStruct = new DS5OutputStruct({
  ...this.currentOutputState,
  ledCRed: Math.max(0, Math.min(255, red)),
  ledCGreen: Math.max(0, Math.min(255, green)),
  ledCBlue: Math.max(0, Math.min(255, blue)),
  lightbarSetup: DS5_LIGHTBAR_SETUP.LIGHT_ON,
  ledBrightness: this.currentOutputState.ledBrightness || 255,
  validFlag1: validFlag1 | DS5_VALID_FLAG1.LIGHTBAR_COLOR,
  validFlag2: validFlag2 | DS5_VALID_FLAG2.LIGHTBAR_SETUP_CONTROL_ENABLE,
});
```
(Die nachträgliche `&= ~DS5_VALID_FLAG1.LIGHTBAR_COLOR`-Zeile bleibt; ergänze dieselbe Freigabe für flag2-Bit: `outputStruct.state.validFlag2 &= ~DS5_VALID_FLAG2.LIGHTBAR_SETUP_CONTROL_ENABLE;` — `lightbarSetup`/`ledBrightness` im State bleiben, damit Folgewrites konsistent sind.)

`resetLights()` erweitern (nach `setLightbarColor(0,0,0)`): `await this.setLightbarSetup('light-on');`

- [ ] **Step 6: BaseController-Defaults + Manager-Wrappers**

In `base-controller.ts` neben den anderen Default-Settern:

```ts
async setLightbarSetup(
  _mode: 'light-on' | 'light-out'
): Promise<{ success: boolean; message: string }> {
  return { success: true, message: 'This controller does not support lightbar setup' };
}

async setLedBrightness(_percent = 100): Promise<{ success: boolean; message: string }> {
  return { success: true, message: 'This controller does not support LED brightness' };
}
```

In `controller-manager.ts` neben den bestehenden Lightbar-Wrappers (Signatur von `setLightbarColor` abschauen):

```ts
async setLightbarSetup(mode: 'light-on' | 'light-out'): Promise<{ success: boolean; message: string }> {
  if (!this.currentController) throw new Error('No controller connected');
  return this.currentController.setLightbarSetup(mode);
}

async setLedBrightness(percent = 100): Promise<{ success: boolean; message: string }> {
  if (!this.currentController) throw new Error('No controller connected');
  return this.currentController.setLedBrightness(percent);
}
```

- [ ] **Step 7: Tests laufen lassen — erwartet PASS**

Gleicher Vitest-Befehl wie Step 3. Falls ein bestehender Pinned-Test (z. B. ein ganzer `data[1]`-Bytevergleich) an den neuen Bits hängt: nur die Assertion aktualisieren (Byte-Layout an sich ist unverändert), nicht den Test löschen.

- [ ] **Step 8: Commit**

```bash
git add ROADMAP.md src/lib/controllers/ds5-controller.ts src/lib/controllers/base-controller.ts src/lib/controllers/controller-manager.ts src/lib/controllers/ds5-controller.test.ts
git commit -m "feat(#111): send valid_flag2/lightbar_setup/led_brightness — root-cause fix for the dark lightbar"
```

---

## Task 2: Connect-Baseline (blauer Blitz) + Akku-Status 0xF als Fehler

**Files:**
- Modify: `src/lib/controllers/ds5-controller.ts:264-279` (initializeCurrentOutputState), `:761-798` (parseBatteryStatus)
- Modify: `src/lib/components/ControllerPanel.svelte` (connect-Pfad)
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts` (Keys `controller.infoFailed`)
- Test: `src/lib/controllers/ds5-controller.test.ts`

**Interfaces:**
- Consumes: `DS5_VALID_FLAG1/FLAG2/LIGHTBAR_SETUP` aus Task 1; `pushControllerLog` (Store).
- Produces: `initializeCurrentOutputState()` — jetzt mit flag2-Baseline; `parseBatteryStatus` meldet `is_error: true` für `batStatus === 15`.

- [ ] **Step 1: Failing Tests schreiben**

```ts
describe('connect baseline + battery 0xF (#112)', () => {
  it('initializeCurrentOutputState flashes blue with the lightbar setup enabled', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.initializeCurrentOutputState();
    const out = device.lastOut();
    expect(out.data[1] & 0x04).toBe(0x04); // flag1 LIGHTBAR_COLOR
    expect(out.data[38]).toBe(0x02); // flag2 enable
    expect(out.data[41]).toBe(0x00); // light-on
    expect(out.data[42]).toBe(255); // volle Helligkeit
    expect(out.data[44]).toBe(0);
    expect(out.data[45]).toBe(0);
    expect(out.data[46]).toBe(255); // blau
  });

  it('parseBatteryStatus treats status 0xF as an error, not as charging', () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    const buf = new ArrayBuffer(64);
    const view = new DataView(buf);
    view.setUint8(52, 0xf0); // status 0xF, charge 0
    const s = ctrl.parseBatteryStatus(view);
    expect(s.is_error).toBe(true);
    expect(s.is_charging).toBe(false);
    expect(s.cable_connected).toBe(false);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — erwartet FAIL** (init sendet altes flag1 `0b1111_0111` und kein flag2; 0xF ist aktuell `is_charging: true`)

Gleicher Vitest-Befehl wie in Task 1.

- [ ] **Step 3: Implementieren**

`initializeCurrentOutputState()` in `ds5-controller.ts` komplett ersetzen:

```ts
/**
 * Connect baseline: enable the lightbar setup group (flag2 bit1), switch the
 * lightbar to light-on (undoes the kernel driver's LIGHT_OUT faded state),
 * request full LED brightness and set blue — a visible confirmation that
 * output writes reach the pad. Failures are logged, not fatal (USB writes
 * themselves are verified by hid.rs, see #115).
 */
async initializeCurrentOutputState(): Promise<void> {
  try {
    this.currentOutputState = {
      ...this.currentOutputState,
      validFlag1: DS5_VALID_FLAG1.LIGHTBAR_COLOR,
      validFlag2: DS5_VALID_FLAG2.LIGHTBAR_SETUP_CONTROL_ENABLE,
      lightbarSetup: DS5_LIGHTBAR_SETUP.LIGHT_ON,
      ledBrightness: 255,
      ledCRed: 0,
      ledCGreen: 0,
      ledCBlue: 255,
    };
    const outputStruct = new DS5OutputStruct(this.currentOutputState);
    await this.sendOutputReport(outputStruct.pack(), 'init default states');
    this.updateCurrentOutputState(outputStruct);
  } catch (error) {
    console.warn('Failed to initialize DS5 output state:', error);
  }
}
```

In `parseBatteryStatus` den `case 15:`-Body ersetzen:

```ts
case 15:
  // 0xF = no battery / error condition — NOT "charging 0 %" (old behaviour
  // showed a charging bolt on an empty pad).
  isError = true;
  break;
```

`ControllerPanel.svelte` `connect()`: nach `const info = await ctrl.getInfo();` das `info.ok` prüfen und die Baseline senden (Import `DS5Controller` aus `$lib/controllers/ds5-controller` ergänzen):

```ts
const info = await ctrl.getInfo();
if (!info.ok) {
  throw new Error(get(LL).controller.infoFailed({ error: String(info.error) }));
}
controllerInfo.set(info);
// Lightbar-Baseline: hebt den Kernel-LIGHT_OUT-Zustand auf und bestätigt mit
// einem blauen Lichtblitz, dass Writes ankommen. Nicht fatal bei Fehlern.
if (ctrl instanceof DS5Controller) {
  await ctrl.initializeCurrentOutputState();
}
```

i18n (`de` zuerst, dann `en` spiegeln, danach `npm run i18n` via Docker):

```ts
// de/index.ts, in controller: { ... }
infoFailed: 'Info-Abruf fehlgeschlagen: {error}',
// en/index.ts
infoFailed: 'Failed to read controller info: {error}',
```

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (+ `npm run check` für i18n-Types)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(#112): connect baseline write (blue flash) + battery 0xF as error state"
```

---

## Task 3: Adaptive-Trigger-Parametrik + setVibration-Flag0 + TesterPanel-Verkabelung

**Files:**
- Modify: `src/lib/controllers/base-controller.ts:60-65` (AdaptiveTriggerConfig), `ds5-controller.ts:66-75` (FLAG0), `:580-636` (setAdaptiveTrigger/setVibration)
- Modify: `src/lib/components/TesterPanel.svelte` (applyTriggers, brightness)
- Test: `src/lib/controllers/ds5-controller.test.ts`

**Interfaces:**
- Consumes: `AdaptiveTriggerConfig`-Typ; TesterPanel-State (`lFreq`/`rFreq`-Slider existieren bereits).
- Produces: `AdaptiveTriggerConfig.frequency?: number` (optional); mode-spezifische Params: `resistance → [start, force, 0]`, `auto → [frequency, force, start]`, `single → [start, end, force]`, `off → [0,0,0]`; `DS5_VALID_FLAG0` heißt `COMPATIBLE_VIBRATION: 0x01` / `HAPTICS_SELECT: 0x02`.

- [ ] **Step 1: Failing Tests schreiben**

```ts
describe('adaptive trigger parametrik (#113)', () => {
  it('resistance packs [start, force, 0]', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setAdaptiveTrigger(
      { mode: 'resistance', start: 10, end: 255, force: 200 },
      { mode: 'resistance', start: 20, end: 255, force: 210 }
    );
    const out = device.lastOut();
    expect(out.data[10]).toBe(0x01); // mode RIGHT
    expect(out.data[11]).toBe(10); // param0 = start
    expect(out.data[12]).toBe(200); // param1 = force
    expect(out.data[13]).toBe(0);
    expect(out.data[21]).toBe(0x01); // mode LEFT
    expect(out.data[22]).toBe(20);
    expect(out.data[23]).toBe(210);
  });

  it('auto packs [frequency, force, start] and clamps 0..255', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setAdaptiveTrigger(
      { mode: 'auto', start: 30, end: 0, force: 400, frequency: 12 },
      { mode: 'auto', start: 40, end: 0, force: 99, frequency: 7 }
    );
    const out = device.lastOut();
    expect(out.data[11]).toBe(12); // param0 = frequency
    expect(out.data[12]).toBe(255); // force clamped
    expect(out.data[13]).toBe(30); // param2 = start
    expect(out.data[31]).toBe(7);
    expect(out.data[32]).toBe(99);
    expect(out.data[33]).toBe(40);
  });

  it('setVibration sets COMPATIBLE_VIBRATION and HAPTICS_SELECT together', async () => {
    const device = makeFakeDevice();
    const ctrl = new DS5Controller(device);
    await ctrl.setVibration(255, 0);
    const out = device.lastOut();
    expect(out.data[0] & 0x03).toBe(0x03); // beide Bits gemeinsam
    expect(out.data[3]).toBe(255); // bcVibrationLeft = heavy
    expect(out.data[2]).toBe(0); // bcVibrationRight = light
  });
});
```

- [ ] **Step 2: Tests laufen lassen — erwartet FAIL** (resistance packt aktuell `[start, end, force]` → `out.data[13]` ist 255 statt 0; flag0-Bits heißen LEFT/RIGHT_VIBRATION und werden einzeln gesetzt)

- [ ] **Step 3: Implementieren**

`base-controller.ts` — Config-Typ erweitern:

```ts
export interface AdaptiveTriggerConfig {
  mode: 'off' | 'single' | 'auto' | 'resistance';
  start: number;
  end: number;
  force: number;
  /** Effect frequency (0..255), only meaningful for mode 'auto' (param0). */
  frequency?: number;
}
```

`ds5-controller.ts` — `DS5_VALID_FLAG0`-Namen (Kernel-Semantik, Werte unverändert):

```ts
const DS5_VALID_FLAG0 = {
  COMPATIBLE_VIBRATION: 0x01,
  HAPTICS_SELECT: 0x02,
  LEFT_TRIGGER: 0x04,
  RIGHT_TRIGGER: 0x08,
  HEADPHONE_VOLUME: 0x10,
  SPEAKER_VOLUME: 0x20,
  MIC_VOLUME: 0x40,
  AUDIO_CONTROL: 0x80,
} as const;
```

`setAdaptiveTrigger` (Body innerhalb des try ersetzen):

```ts
const modeMap: Record<string, number> = {
  off: DS5_TRIGGER_EFFECT_MODE.OFF,
  single: DS5_TRIGGER_EFFECT_MODE.TRIGGER,
  auto: DS5_TRIGGER_EFFECT_MODE.AUTO_TRIGGER,
  resistance: DS5_TRIGGER_EFFECT_MODE.RESISTANCE,
};
const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
// Mode-specific parametrik (reference: daidr dualsense-tester TriggerEffect.vue):
// resistance → [start, force], auto → [frequency, force, start],
// single (trigger effect) → [start, end, force].
const params = (cfg: AdaptiveTriggerConfig): [number, number, number] => {
  switch (cfg.mode) {
    case 'resistance':
      return [clamp(cfg.start), clamp(cfg.force), 0];
    case 'auto':
      return [clamp(cfg.frequency ?? 0), clamp(cfg.force), clamp(cfg.start)];
    case 'single':
      return [clamp(cfg.start), clamp(cfg.end), clamp(cfg.force)];
    default:
      return [0, 0, 0];
  }
};
const [lp0, lp1, lp2] = params(left);
const [rp0, rp1, rp2] = params(right);
const { validFlag0 } = this.currentOutputState;
const outputStruct = new DS5OutputStruct({
  ...this.currentOutputState,
  adaptiveTriggerLeftMode: modeMap[left.mode],
  adaptiveTriggerLeftParam0: lp0,
  adaptiveTriggerLeftParam1: lp1,
  adaptiveTriggerLeftParam2: lp2,
  adaptiveTriggerRightMode: modeMap[right.mode],
  adaptiveTriggerRightParam0: rp0,
  adaptiveTriggerRightParam1: rp1,
  adaptiveTriggerRightParam2: rp2,
  validFlag0: validFlag0 | DS5_VALID_FLAG0.LEFT_TRIGGER | DS5_VALID_FLAG0.RIGHT_TRIGGER,
});
```

`setVibration` — Flag-Zeile ersetzen (Auf-/Ableiten beide Male):

```ts
validFlag0: validFlag0 | DS5_VALID_FLAG0.COMPATIBLE_VIBRATION | DS5_VALID_FLAG0.HAPTICS_SELECT,
```
und die `&= ~`-Zeile analog auf dieselben beiden Konstanten.

`TesterPanel.svelte` `applyTriggers` — den cast-Hack entfernen, frequency direkt setzen:

```ts
const left: AdaptiveTriggerConfig = {
  mode: lMode,
  start: lStart,
  end: lEnd,
  force: lForce,
  frequency: lFreq,
};
const right: AdaptiveTriggerConfig = {
  mode: rMode,
  start: rStart,
  end: rEnd,
  force: rForce,
  frequency: rFreq,
};
await manager.setAdaptiveTrigger(left, right);
```

- [ ] **Step 4: Tests laufen lassen — erwartet PASS**

- [ ] **Step 5: Commit**

```bash
git add src/lib/controllers/base-controller.ts src/lib/controllers/ds5-controller.ts src/lib/components/TesterPanel.svelte src/lib/controllers/ds5-controller.test.ts
git commit -m "feat(#113): mode-specific adaptive trigger params + kernel vibration flag semantics"
```

---

## Task 4: Player-LED-0x20-Fallback + lokalisierte Save-Logs + Akku-Fehler-Anzeige

**Files:**
- Modify: `src/lib/controllers/ds5-controller.ts:716-731` (setPlayerIndicator)
- Modify: `src/lib/components/ControllerPanel.svelte` (flashController-Log, Batterie-Karte)
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts` (Keys `controller.saveDoneLog`, `controller.batteryErrorTitle`)
- Test: `src/lib/controllers/ds5-controller.test.ts`

**Interfaces:**
- Consumes: `device.sendReport` (TauriHIDDevice/Betonung: report id wird vom Device-Layer prepended).
- Produces: `setPlayerIndicator` sendet zusätzlich Legacy-Report `0x20` (best-effort, Fehler ignoriert); ControllerPanel loggt Save-Ergebnis lokalisiert statt `res.message`.

- [ ] **Step 1: Failing Test schreiben**

```ts
it('setPlayerIndicator additionally sends the legacy 0x20 report (old BDM boards)', async () => {
  const device = makeFakeDevice();
  const ctrl = new DS5Controller(device);
  await ctrl.setPlayerIndicator(0b01010);
  const legacy = device.sent.find((s: { reportId: number }) => s.reportId === 0x20);
  expect(legacy).toBeDefined();
  expect(legacy!.data[0]).toBe(0b01010);
});
```
(Hinweis: `makeFakeDevice` muss dafür `sent` vollständig aufzeichnen — tut es laut bestehender Tests bereits.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (`sent` enthält keinen 0x20-Eintrag)

- [ ] **Step 3: Implementieren**

`setPlayerIndicator` — nach dem bestehenden `sendOutputReport`-Aufruf, **vor** `updateCurrentOutputState`:

```ts
// Legacy 0x20 output report for old boards (BDM-010/020) that drive their
// player LEDs from the dedicated report instead of the common one. Newer
// boards reject it harmlessly, so a failure here is NOT fatal.
try {
  await this.device.sendReport(0x20, new Uint8Array([Math.max(0, Math.min(31, pattern))]));
} catch {
  // ignore legacy report errors
}
```

`ControllerPanel.svelte` `flashController` — `res.message` (englisch) nicht mehr loggen:

```ts
const res = await manager.flash();
pushControllerLog(res.success ? get(LL).controller.saveDoneLog() : res.message, res.success ? 'info' : 'error');
```
(Wegen Task 2 bleibt `ds5.flash()` selbst unverändert — seine interne Message wird nur im Fehlerfall durchgereicht.)

i18n: `de`: `saveDoneLog: 'Kalibrierungsänderungen gespeichert'`, `en`: `saveDoneLog: 'Calibration changes saved'`.

Batterie-Karte in `ControllerPanel.svelte` (Info-Bar, Zeile ~315–321): rote Kennzeichnung bei Fehler:

```svelte
<div class="flex items-center gap-1.5 text-sm font-medium { $batteryStatus.is_error ? 'text-red-400' : 'text-gray-200' }"
  title={$batteryStatus.is_error ? $LL.controller.batteryErrorTitle() : $LL.controller.batteryTitle()}>
```
i18n: `de`: `batteryErrorTitle: 'Akkustand nicht lesbar (Fehlerzustand)'`, `en`: `batteryErrorTitle: 'Battery level unreadable (error state)'`.

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (+ `npm run check`)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(#114): legacy 0x20 player-LED fallback + localized save/battery-error logs"
```
---

## Task 5: Rust hid.rs — `HidShared`-State, async Commands, Write-Ergebnis, Guards, try_send

**Files:**
- Modify: `src-tauri/src/state.rs` (HID-Felder → `HidShared`)
- Modify: `src-tauri/src/commands/hid.rs` (nahezu vollständig)
- Test: inline `#[cfg(test)]` in `hid.rs`

**Interfaces:**
- Consumes: `AppState` (Feldnamen ändern sich — alle Verweise in hid.rs ziehen mit; sonstige Nutzer der HID-Felder: nur `hid.rs`).
- Produces: `HidShared` (pub struct in state.rs, Felder sie unten); `hid_send_output_report(data) -> Result<usize, String>` (bytes_written); `hid_send_feature_report` mit 512-Guard; `hid_diagnostics() -> HidDiagnostics` (sync, nur State-Read); `send_cmd!`-Makro mit `try_send`; alle bisherigen Command-Namen bleiben (`hid_list_devices`, `hid_connect`, `hid_disconnect`, `hid_send_feature_report`, `hid_receive_feature_report`, `hid_send_output_report`, `hid_poll`) — `lib.rs`-Registrationen bleiben unverändert.

- [ ] **Step 1: Failing Rust-Tests schreiben**

In `hid.rs` `#[cfg(test)]`-Modul ergänzen:

```rust
#[test]
fn write_output_check_full_write_is_ok() {
    assert_eq!(check_write_result(47, 47), Ok(47));
}

#[test]
fn write_output_check_partial_write_is_err() {
    let r = check_write_result(30, 47);
    assert!(r.is_err());
    assert!(r.unwrap_err().contains("30"), "Meldung nennt geschriebene Bytes");
}

#[test]
fn write_output_check_zero_bytes_is_err() {
    assert!(check_write_result(0, 47).is_err());
}
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (`check_write_result` existiert nicht)

```bash
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app rust:1.86 \
  sh -lc "apt-get update -qq && apt-get install -y -qq libudev-dev pkg-config >/dev/null && cargo test -p fixplay-tauri hid::tests::write_output_check"
```

- [ ] **Step 3: state.rs umstellen**

In `state.rs` die Felder `hid_cmd_tx`, `hid_stop`, `hid_alive`, `hid_reports`, `hid_dropped_reports` entfernen und durch EIN Feld ersetzen (`std::thread::JoinHandle`-Import existiert bereits):

```rust
/// Shared HID connection state — reader thread, command channel, counters.
/// Held as one Arc so async commands can clone it into spawn_blocking
/// closures without borrowing `State<'_>`.
pub struct HidShared {
    /// Command channel to the HID reader thread.
    pub cmd_tx:           Mutex<Option<mpsc::SyncSender<HidCmd>>>,
    /// Stop flag for the HID reader thread.
    pub stop:             Mutex<Option<Arc<AtomicBool>>>,
    /// Liveness flag — set false on thread exit (any path, via AliveGuard).
    pub alive:            Mutex<Option<Arc<AtomicBool>>>,
    /// Join handle of the reader thread — joined on reconnect/disconnect.
    pub thread:           Mutex<Option<JoinHandle<()>>>,
    /// Input reports buffered for `hid_poll`.
    pub reports:          Mutex<VecDeque<HidReport>>,
    /// Input reports dropped because the buffer was full (512 cap).
    pub dropped_reports:  AtomicU64,
    /// Successful output writes (byte-count verified).
    pub write_count:      AtomicU64,
    /// Failed output writes (partial write or hidapi error).
    pub write_errors:     AtomicU64,
    /// Last write error message, for the HID-diagnostics block.
    pub last_write_error: Mutex<Option<String>>,
    /// OS device path the connection was opened with (device picker, #117).
    pub open_path:        Mutex<Option<String>>,
}

// in AppState:
/// HID connection state (reader thread + channel + write statistics).
pub hid: Arc<HidShared>,
```
(`Default for AppState` entsprechend: `hid: Arc::new(HidShared::default())`, `HidShared` bekommt ein passendes `impl Default` — jedes Feld wie zuvor initialisiert.)

- [ ] **Step 4: hid.rs umschreiben**

Neu/erweitert in `hid.rs` (bestehende Helfer `feature_report_packet`, `make_get_feature_buf`, `parse_input_report`, `push_report`, `AliveGuard` und ihre Tests **bleiben unverändert**):

```rust
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

pub enum HidCmd {
    SendFeatureReport(u8, Vec<u8>, mpsc::SyncSender<Result<(), String>>),
    GetFeatureReport(u8, usize, mpsc::SyncSender<Result<Vec<u8>, String>>),
    /// Reply carries the bytes actually written — hidapi's write() result was
    /// previously discarded, making a failed write indistinguishable from a
    /// successful one (#115).
    WriteOutput(Vec<u8>, mpsc::SyncSender<Result<usize, String>>),
    Stop,
}

/// Pure check of the hidapi write result against the expected payload length
/// (unit-testable, German user-facing message).
fn check_write_result(written: usize, expected: usize) -> Result<usize, String> {
    if written == expected {
        Ok(written)
    } else {
        Err(format!("HID-Write unvollständig: {written} von {expected} Bytes"))
    }
}
```

Thread-Body für `WriteOutput` (in `run_hid_thread` — die Signatur bekommt zusätzlich `shared: &HidShared`, siehe Task 6; hier reicht: Counters aktualisieren):

```rust
Ok(HidCmd::WriteOutput(data, reply)) => {
    let expected = data.len();
    let r = match device.write(&data) {
        Ok(n) => check_write_result(n, expected),
        Err(e) => Err(e.to_string()),
    };
    match &r {
        Ok(_) => shared.write_count.fetch_add(1, Ordering::Relaxed),
        Err(e) => {
            shared.write_errors.fetch_add(1, Ordering::Relaxed);
            *shared.last_write_error.lock().unwrap() = Some(e.clone());
        }
    };
    reply.send(r).ok();
}
```

`send_cmd!`-Makro ersetzen — `try_send` statt blockierendem `send` (kein Deadlock bei voller Queue), Lock nur um den `try_send`:

```rust
macro_rules! send_cmd {
    ($cmd_tx:expr, $cmd:expr) => {{
        let (reply_tx, reply_rx) = mpsc::sync_channel(1);
        {
            let guard = $cmd_tx.lock().unwrap();
            let tx = guard
                .as_ref()
                .ok_or_else(|| "Kein HID-Gerät verbunden".to_string())?;
            tx.try_send($cmd(reply_tx))
                .map_err(|_| "HID-Warteschlange voll oder HID-Thread weg".to_string())?;
        }
        reply_rx.recv().map_err(|_| "HID-Thread beendet".to_string())?
    }};
}
```

Alle Commands async + spawn_blocking (Muster für alle 5 send/receive/write-Commands; `hid_list_devices` und `hid_diagnostics` bleiben sync — reine Enumeration/State-Reads ohne offenes Gerät):

```rust
#[tauri::command]
pub async fn hid_send_output_report(
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let cmd_tx = Arc::clone(&state.hid.cmd_tx_arc());
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    tokio::task::spawn_blocking(move || {
        send_cmd!(cmd_tx, |reply| HidCmd::WriteOutput(data, reply))
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}
```
**Wichtig (Design-Entscheidung):** damit der `Arc`-Clone funktioniert, wird `HidShared.cmd_tx` zu `Arc<Mutex<Option<mpsc::SyncSender<HidCmd>>>>` (nicht plain Mutex) — analog `hid_connect`/`hid_disconnect`/Feature-Commands mit `Arc::clone(&state.hid.cmd_tx)`. Die `Mutex`-Felder `thread`/`alive`/`stop`/`reports`/`open_path` bleiben plain (nur in spawn_blocking-Kontexten erreicht, die sich `Arc<HidShared>` holen — dafür wird `HidShared` selbst als `Arc<HidShared>` im State gehalten und die Blocking-Closures bekommen `Arc<HidShared>` statt Feld-Clones):

```rust
// state.rs — endgültige Form:
pub hid: Arc<HidShared>, // HidShared wie oben, cmd_tx als Arc<Mutex<Option<SyncSender<HidCmd>>>>

// Command-Muster (gilt für hid_send_feature_report, hid_receive_feature_report, hid_send_output_report):
#[tauri::command]
pub async fn hid_send_feature_report(
    report_id: u8,
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if data.len() > 512 {
        return Err(format!(
            "Feature-Report-Länge {} überschreitet Maximum 512",
            data.len()
        ));
    }
    let hid = Arc::clone(&state.hid);
    tokio::task::spawn_blocking(move || {
        send_cmd!(hid.cmd_tx, |reply| HidCmd::SendFeatureReport(report_id, data, reply))
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}
```

Diagnostics-Command (neu):

```rust
/// Frontend-facing HID diagnostics (write statistics + last error) for the
/// repair-context diagnose block (#124). Pure state read — sync is fine.
#[derive(Serialize)]
pub struct HidDiagnostics {
    pub connected:        bool,
    pub open_path:        Option<String>,
    pub write_count:      u64,
    pub write_errors:     u64,
    pub dropped_reports:  u64,
    pub last_write_error: Option<String>,
}

#[tauri::command]
pub fn hid_diagnostics(state: State<'_, AppState>) -> HidDiagnostics {
    let hid = &state.hid;
    let alive = hid
        .alive
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.load(Ordering::Relaxed))
        .unwrap_or(false);
    HidDiagnostics {
        connected: alive && hid.cmd_tx.lock().unwrap().is_some(),
        open_path: hid.open_path.lock().unwrap().clone(),
        write_count: hid.write_count.load(Ordering::Relaxed),
        write_errors: hid.write_errors.load(Ordering::Relaxed),
        dropped_reports: hid.dropped_reports.load(Ordering::Relaxed),
        last_write_error: hid.last_write_error.lock().unwrap().clone(),
    }
}
```

`hid_poll` auf die neuen Felder umstellen (`state.hid.reports`, `state.hid.dropped_reports`, `state.hid.cmd_tx`, `state.hid.alive` — Logik unverändert). `hid_connect`/`hid_disconnect` bekommen in diesem Task nur die minimalen Anpassungen, damit sie mit `HidShared` kompilieren (Teardown-Reihenfolge/Uplug folgt in Task 6).

- [ ] **Step 5: Tests laufen lassen — erwartet PASS** (alle bestehenden hid.rs-Tests grün, neue Write-Checks PASS, `cargo test --workspace` + `cargo clippy --workspace -- -D warnings`)

- [ ] **Step 6: Commit**

```bash
git add src-tauri/src/state.rs src-tauri/src/commands/hid.rs
git commit -m "feat(#115): async HID commands, verified write results, feature-send guard, try_send backpressure"
```

---

## Task 6: Rust hid.rs — Unplug-Erkennung, Teardown-nach-Open, Thread-Join

**Files:**
- Modify: `src-tauri/src/commands/hid.rs` (run_hid_thread, hid_connect, hid_disconnect)
- Test: inline `#[cfg(test)]` in `hid.rs`

**Interfaces:**
- Consumes: `HidShared` aus Task 5.
- Produces: `teardown_hid(hid: &HidShared)` (Join + Flags), `reader_should_exit(consecutive_errors: u32) -> bool`, `read_error_backoff_ms(consecutive_errors: u32) -> u64`, `MAX_CONSECUTIVE_READ_ERRORS = 3`; `hid_connect`/`hid_disconnect` sind jetzt `async fn` + `spawn_blocking`.

- [ ] **Step 1: Failing Tests schreiben**

```rust
#[test]
fn reader_should_exit_after_threshold() {
    assert!(!reader_should_exit(0));
    assert!(!reader_should_exit(2));
    assert!(reader_should_exit(3)); // MAX_CONSECUTIVE_READ_ERRORS
}

#[test]
fn read_error_backoff_grows_and_caps() {
    assert_eq!(read_error_backoff_ms(1), 10);
    assert_eq!(read_error_backoff_ms(2), 20);
    assert_eq!(read_error_backoff_ms(10), 50); // cap
}
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren**

Konstanten + Helfer (oben in `hid.rs`):

```rust
/// Consecutive read errors after which the reader thread declares the device
/// gone (unplug). Below the threshold errors are tolerated with a backoff —
/// a single failed read is not necessarily a disconnect.
const MAX_CONSECUTIVE_READ_ERRORS: u32 = 3;

fn reader_should_exit(consecutive_errors: u32) -> bool {
    consecutive_errors >= MAX_CONSECUTIVE_READ_ERRORS
}

fn read_error_backoff_ms(consecutive_errors: u32) -> u64 {
    (10u64 * consecutive_errors as u64).min(50)
}
```

`run_hid_thread` — Read-Teil der Loop ersetzen:

```rust
let mut read_errors = 0u32;
while !stop.load(Ordering::Relaxed) {
    // … Command-Drain unverändert …

    match device.read_timeout(&mut buf, 5) {
        Ok(n) => {
            read_errors = 0;
            if let Some(report) = parse_input_report(&buf, n) {
                let mut q = shared.reports.lock().unwrap();
                push_report(&mut q, &shared.dropped_reports, report);
            }
        }
        Err(e) => {
            read_errors += 1;
            if reader_should_exit(read_errors) {
                info!("HID: {} aufeinanderfolgende Lesefehler — Gerät getrennt ({e})",
                    MAX_CONSECUTIVE_READ_ERRORS);
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(
                read_error_backoff_ms(read_errors),
            ));
        }
    }
}
```
(`shared` ist `Arc<HidShared>`; `push_report` nimmt `&AtomicU64` — Aufruf anpassen: `&shared.dropped_reports`.)

Teardown-Helfer + Reconnect-Reihenfolge:

```rust
/// Stop the reader thread and join it. Called AFTER a successful open of the
/// new device (previously teardown ran BEFORE the open — a failed open then
/// destroyed a working connection) and on disconnect.
fn teardown_hid(hid: &HidShared) {
    if let Some(tx) = hid.cmd_tx.lock().unwrap().take() {
        let _ = tx.send(HidCmd::Stop);
    }
    if let Some(s) = hid.stop.lock().unwrap().take() {
        s.store(true, Ordering::Relaxed);
    }
    if let Some(h) = hid.thread.lock().unwrap().take() {
        let _ = h.join();
    }
    hid.alive.lock().unwrap().take();
}
```

`hid_connect` (ersetzt die aktuelle sync-Fassung):

```rust
#[tauri::command]
pub async fn hid_connect(
    vendor_id: u16,
    product_id: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let hid = Arc::clone(&state.hid);
    tokio::task::spawn_blocking(move || {
        // 1. Open FIRST — a failed open must not destroy a working connection.
        let api = HidApi::new().map_err(|e| e.to_string())?;
        let device = api.open(vendor_id, product_id).map_err(|e| e.to_string())?;
        // 2. Only now tear down the previous reader thread (and join it).
        teardown_hid(&hid);
        let (cmd_tx, cmd_rx) = mpsc::sync_channel::<HidCmd>(32);
        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let alive = Arc::new(AtomicBool::new(true));
        let alive_clone = Arc::clone(&alive);
        hid.reports.lock().unwrap().clear();
        hid.dropped_reports.store(0, Ordering::Relaxed);
        *hid.last_write_error.lock().unwrap() = None;
        hid.write_count.store(0, Ordering::Relaxed);
        hid.write_errors.store(0, Ordering::Relaxed);
        *hid.cmd_tx.lock().unwrap() = Some(cmd_tx);
        *hid.stop.lock().unwrap() = Some(stop);
        *hid.alive.lock().unwrap() = Some(alive);
        let shared = Arc::clone(&hid);
        let handle = std::thread::spawn(move || {
            run_hid_thread(device, cmd_rx, shared, stop_clone, alive_clone)
        });
        *hid.thread.lock().unwrap() = Some(handle);
        info!("HID connected: vendor={:#06x} product={:#06x}", vendor_id, product_id);
        Ok(())
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}
```

`run_hid_thread`-Signatur: `fn run_hid_thread(device: hidapi::HidDevice, cmd_rx: mpsc::Receiver<HidCmd>, shared: Arc<HidShared>, stop: Arc<AtomicBool>, alive: Arc<AtomicBool>)` — Counters via `shared.*` (Task 5).

`hid_disconnect`:

```rust
#[tauri::command]
pub async fn hid_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let hid = Arc::clone(&state.hid);
    tokio::task::spawn_blocking(move || {
        teardown_hid(&hid);
        hid.reports.lock().unwrap().clear();
        info!("HID disconnected");
        Ok(())
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}
```

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (`cargo test --workspace`, clippy `-D warnings`)

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/commands/hid.rs
git commit -m "feat(#116): HID unplug detection (read-error threshold + backoff), teardown after open, thread join"
```

---

## Task 7: Device-Picker + Pfad-Open + Edge-USB-PID

**Files:**
- Modify: `src-tauri/src/commands/hid.rs` (`HidDeviceInfo.path`, `hid_connect(path)`)
- Modify: `src/lib/controllers/tauri-hid-device.ts` (`hidConnect(path)`, `TauriHIDDevice.path`)
- Modify: `src/lib/components/ControllerPanel.svelte` (Picker)
- Modify: `src/lib/controllers/controller-manager.ts:465-473` (PIDs)
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts` (Picker-Keys)
- Test: `src/lib/components/ControllerPanel.test.ts` (falls vorhanden — sonst neues Minimal-Testfile für `createControllerForDevice` in `controller-manager.test.ts`)

**Interfaces:**
- Consumes: `hid_list_devices()` (existiert, ungefiltert), `hidConnect` (tauri-hid-device.ts).
- Produces: `HidDeviceInfo.path: string` (Rust + TS-Typ); `hidConnect(vendorId, productId, path?)`; `createControllerForDevice` akzeptiert `0x0ce6 | 0x0e5f | 0x0df2`; Rust `hid_connect(vendor_id, product_id, path: Option<String>)`.

- [ ] **Step 1: Failing Tests schreiben**

In `src/lib/controllers/controller-manager.test.ts` (oder neuem File, jsdom-Direktive + `initI18n()` nur falls Komponenten beteiligt):

```ts
describe('DS5 PID table (#117)', () => {
  it('creates a DS5Controller for the Edge USB PID 0x0e5f', () => {
    const device = { opened: true, collections: [], oninputreport: null,
      sendFeatureReport: async () => {}, receiveFeatureReport: async () => new DataView(new ArrayBuffer(0)),
      sendReport: async () => {}, close: async () => {}, vendorId: 0x054c, productId: 0x0e5f };
    expect(createControllerForDevice(device as any)?.getModel()).toBe('DS5');
  });
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (0x0e5f → `null`)

- [ ] **Step 3: Rust — path-Feld + open_path**

`HidDeviceInfo` um `pub path: String` erweitern; in `hid_list_devices` füllen (`hidapi`-DeviceInfo liefert den Pfad via `d.path()` — falls die Signatur `Option<&CStr>` ist: `.map(|p| p.to_string_lossy().into_owned()).unwrap_or_default()`):

```rust
path: d.path().to_string(),
```

`hid_connect` um `path: Option<String>` erweitern — Open-Block:

```rust
let device = match &path {
    Some(p) => api
        .open_path(p)
        .or_else(|_| api.open(vendor_id, product_id))
        .map_err(|e| e.to_string())?,
    None => api.open(vendor_id, product_id).map_err(|e| e.to_string())?,
};
*hid.open_path.lock().unwrap() = path.clone();
```
(hidapi 2.x: `HidApi::open_path(&self, path: &str)`; Fallback VID/PID falls der Pfad zwischen Listing und Open verschwindet.)

Frontend `tauri-hid-device.ts`:

```ts
export interface HidDeviceInfo {
  // … bestehende Felder …
  path: string;
}

export class TauriHIDDevice implements HIDDeviceLike {
  readonly vendorId: number;
  readonly productId: number;
  readonly path?: string;
  constructor(vendorId: number, productId: number, path?: string) {
    this.vendorId = vendorId;
    this.productId = productId;
    this.path = path;
  }
  // … Rest unverändert …
}

export async function hidConnect(
  vendorId: number,
  productId: number,
  path?: string
): Promise<TauriHIDDevice> {
  await invoke<void>('hid_connect', { vendorId, productId, path: path ?? null });
  return new TauriHIDDevice(vendorId, productId, path);
}
```

- [ ] **Step 4: PID-Tabelle korrigieren**

`controller-manager.ts` `createControllerForDevice`:

```ts
// DualSense: USB 0x0ce6 (Standard) / 0x0e5f (DualSense Edge), BT 0x0df2
if (vendorId === 0x054c && (productId === 0x0ce6 || productId === 0x0e5f || productId === 0x0df2)) {
  return new DS5Controller(device);
}
```

- [ ] **Step 5: Picker in ControllerPanel**

`ControllerPanel.svelte` — Import ergänzen: `import { hidConnect, hidListDevices } from '$lib/controllers/tauri-hid-device';` (ersetzt den bisherigen `hidConnect`-Importort falls abweichend) + State:

```ts
let pickerOpen = $state(false);
let pickerDevices = $state<HidDeviceInfo[]>([]);
```

`connect()` umschreiben (alter PID-Loop mit falschem „Edge"-Kommentar entfällt):

```ts
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
  try {
    const device = await hidConnect(info.vendor_id, info.product_id, info.path || undefined);
    // … bestehender Körper von connect() ab „const ctrl = createControllerForDevice(device)"
    // unverändert hier fortgesetzt (Manager, Polling, Transport-Wait, getInfo, snapshot) …
  } catch (e) {
    connectError = e instanceof Error ? e.message : String(e);
    pushControllerLog(get(LL).controller.connectFailedLog({ error: connectError }), 'error');
  } finally {
    connecting = false;
  }
}
```

Picker-Markup (nach dem connectError-Block):

```svelte
{#if pickerOpen}
  <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60" role="dialog" aria-modal="true">
    <div class="w-full max-w-md rounded-2xl bg-gray-900 p-5 shadow-2xl">
      <h2 class="mb-3 text-lg font-semibold text-gray-100">{$LL.controller.pickerTitle()}</h2>
      <div class="flex flex-col gap-2">
        {#each pickerDevices as dev (dev.path)}
          <button
            class="flex flex-col items-start rounded-lg bg-gray-800 px-3 py-2 text-left hover:bg-gray-700"
            onclick={() => connectDevice(dev)}
          >
            <span class="text-sm text-gray-100">{dev.product || $LL.controller.pickerUnknown()}</span>
            <span class="text-xs text-gray-500">
              {#if dev.serial_number}{dev.serial_number} · {/if}{dev.path}
            </span>
          </button>
        {/each}
        <button class="mt-2 rounded-lg px-3 py-2 text-sm text-gray-400 hover:text-gray-200" onclick={() => (pickerOpen = false)}>
          {$LL.common.cancel()}
        </button>
      </div>
    </div>
  </div>
{/if}
```
(`common.cancel` existiert vermutlich — falls nicht, Key `controller.pickerCancel` de/en ergänzen.)

i18n-Keys: `de`: `pickerTitle: 'Controller wählen'`, `pickerUnknown: 'Unbekanntes Gerät'`; `en`: `pickerTitle: 'Choose controller'`, `pickerUnknown: 'Unknown device'`.

- [ ] **Step 6: Tests laufen lassen — erwartet PASS** (Vitest + `cargo test --workspace` + `npm run check`)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(#117): device picker with path-based open + DualSense Edge USB PID"
```

---

## Task 8: BT-Input-CRC-Validierung + Transport-Wait + Transport-Statistiken

**Files:**
- Modify: `src/lib/controllers/crc32.ts` (validateBtInputCrc, fillBtInputCrc)
- Modify: `src/lib/controllers/controller-manager.ts` (TransportStats in processControllerInput)
- Modify: `src/lib/components/ControllerPanel.svelte` (80 ms-Sleep → Wait-Loop)
- Test: `src/lib/controllers/crc32.test.ts` (falls nicht vorhanden, neu anlegen mit jsdom-Direktive), `src/lib/controllers/controller-manager.test.ts`

**Interfaces:**
- Consumes: `crc32(data, prefix)` aus crc32.ts; bestehender BT-Input-Pfad in `processControllerInput` (reportId 0x31, seq-Byte wird abgestreift).
- Produces: `validateBtInputCrc(report: Uint8Array): boolean`, `fillBtInputCrc(report: Uint8Array): void`; `ControllerManager.getTransport(): 'usb' | 'bt'`, `resetTransportStats()`, `getTransportStats(): { reports, seqGaps, crcErrors, lastSeq }`. Frame-Konvention: BT-Input-Payload nach Id-Byte = `[seqByte, …body…, CRC32-LE]`, CRC über Payload[0..end−4] mit Seed `[0xA1, 0xB2]` (kernel hid-playstation.c, dualsense_input_report_bt); seq in den oberen 6 Bit von Payload[0] (`seq = raw[0] >> 2`, mod 64).

- [ ] **Step 1: Failing Tests schreiben**

```ts
// crc32.test.ts
import { validateBtInputCrc, fillBtInputCrc } from './crc32';

describe('BT input CRC (#118)', () => {
  it('accepts a frame with a correct CRC trailer', () => {
    const frame = new Uint8Array(77);
    frame[0] = 0x10 << 2; // seq 0x10 in den oberen 6 Bit
    frame[1] = 0xff;
    fillBtInputCrc(frame);
    expect(validateBtInputCrc(frame)).toBe(true);
  });

  it('rejects a corrupted frame and a too-short frame', () => {
    const frame = new Uint8Array(77);
    fillBtInputCrc(frame);
    frame[5] ^= 0xff;
    expect(validateBtInputCrc(frame)).toBe(false);
    expect(validateBtInputCrc(new Uint8Array(10))).toBe(false);
  });
});
```

In `controller-manager.test.ts` (BT-Transport-Tests existieren — deren Frames bekommen jetzt CRC; neue Assertions):

```ts
it('drops BT frames with a bad CRC and counts crcErrors (#118)', () => {
  const mgr = createControllerManager();
  mgr.setControllerInstance(makeFakeDs5()); // bestehender Helper/Pattern dieser Datei
  const frame = new Uint8Array(77);
  frame[0] = 0x04; // seq
  const data = new DataView(frame.buffer);
  mgr.processControllerInput({ data, reportId: 0x31 });
  expect(mgr.getTransportStats().crcErrors).toBe(1);
  // Keine Button-Änderungen durch die korrupte Frame.
});

it('counts seq gaps as packet loss (#118)', () => {
  const mgr = createControllerManager();
  mgr.setControllerInstance(makeFakeDs5());
  for (const seq of [0, 1, 3, 6]) {
    // Lücke 1→3 = 1 verlorener, 3→6 = 2 verlorene
    const f = new Uint8Array(77);
    f[0] = seq << 2;
    fillBtInputCrc(f);
    mgr.processControllerInput({ data: new DataView(f.buffer), reportId: 0x31 });
  }
  expect(mgr.getTransportStats().reports).toBe(4);
  expect(mgr.getTransportStats().seqGaps).toBe(3);
});
```

- [ ] **Step 2: Tests laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren — crc32.ts**

```ts
/** Validate the CRC32 trailer of a BT input report (report id 0x31, id byte
 * already stripped by the Rust layer). Payload = [seq, …data…, CRC32-LE],
 * CRC seeded over [0xA1, 0xB2] (kernel hid-playstation.c:
 * dualsense_input_report_bt). Returns false for too-short frames or mismatch. */
export function validateBtInputCrc(report: Uint8Array): boolean {
  if (report.length < 77) return false;
  const end = report.length - 4;
  const got =
    ((report[end] | (report[end + 1] << 8) | (report[end + 2] << 16) | (report[end + 3] << 24)) >>> 0);
  return crc32(report.subarray(0, end), [0xa1, 0xb2]) === got;
}

/** Fill the CRC32 trailer in place (same framing as validateBtInputCrc) —
 * used by the mock layer and the tests to build valid frames. */
export function fillBtInputCrc(report: Uint8Array): void {
  const end = report.length - 4;
  const c = crc32(report.subarray(0, end), [0xa1, 0xb2]);
  report[end] = c & 0xff;
  report[end + 1] = (c >>> 8) & 0xff;
  report[end + 2] = (c >>> 16) & 0xff;
  report[end + 3] = (c >>> 24) & 0xff;
}
```
(Vorher die Signatur der bestehenden `crc32()`-Funktion prüfen — sie nimmt `(data, prefix, suffix?)` und liefert unsigned; Seed-Form wie `fillOutputReportCrc`.)

- [ ] **Step 4: Implementieren — ControllerManager**

Felder + Methoden in `ControllerManager`:

```ts
/** Per-BT-transport statistics for the BT connection test (#119) and the
 * status row (#124). seq is 6-bit and wraps, so gap math is mod 64. */
private transportStats = { reports: 0, seqGaps: 0, crcErrors: 0, lastSeq: null as number | null };

getTransport(): ControllerTransport {
  return this.currentController?.transport ?? 'usb';
}

resetTransportStats(): void {
  this.transportStats = { reports: 0, seqGaps: 0, crcErrors: 0, lastSeq: null };
}

getTransportStats(): { reports: number; seqGaps: number; crcErrors: number; lastSeq: number | null } {
  return { ...this.transportStats };
}
```

`processControllerInput` BT-Zweig (Zeilen ~416–424) ersetzen:

```ts
if (reportId === DS5_BT_INPUT_REPORT_ID) {
  this.currentController.setTransport('bt');
  const raw = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (!validateBtInputCrc(raw)) {
    this.transportStats.crcErrors++;
    return; // corrupted frame — do not feed buttons/touch/IMU
  }
  const seq = (raw[0] >> 2) & 0x3f;
  const s = this.transportStats;
  if (s.lastSeq !== null) {
    const gap = (seq - s.lastSeq) & 0x3f;
    if (gap > 1) s.seqGaps += gap - 1;
  }
  s.lastSeq = seq;
  s.reports++;
} else if (reportId !== undefined) {
  this.currentController.setTransport('usb');
}
```
Import `validateBtInputCrc` aus `./crc32`.

Bestehende BT-Input-Tests in `controller-manager.test.ts` aktualisieren: deren synthetische Frames brauchen `fillBtInputCrc` (sonst fallen sie unter die neue Validierung).

- [ ] **Step 5: Transport-Wait in ControllerPanel**

`ControllerPanel.svelte` — die fixe `await new Promise((r) => setTimeout(r, 80));`-Zeile ersetzen:

```ts
// Wait (max 1.5 s) for the first input report to set the transport. Feature
// reports over BT need CRC framing; sending earlier would be dropped silently
// by the controller. The poll interval is already running and feeding inputs.
const deadline = Date.now() + 1500;
while (manager && manager.getTransport() === 'usb' && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 16));
}
```

- [ ] **Step 6: Tests laufen lassen — erwartet PASS**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(#118): validate BT input CRC, count transport stats, wait for transport before feature reports"
```

---

## Task 9: BT-Verbindungstest im QuickTest-Modal

**Files:**
- Modify: `src/lib/components/QuickTestModal.svelte` (neuer Test „bluetooth")
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts` (quickTest-Keys)
- Test: `src/lib/components/QuickTestModal.test.ts`

**Interfaces:**
- Consumes: `manager.getTransport()`, `manager.getTransportStats()`, `manager.resetTransportStats()` (Task 8), `LL.quickTest.*`.
- Produces: neuer Testfall `id: 'bt'` im Test-Grid (nur sichtbar, wenn `transport === 'bt'`), Resultat-Verdict `bt-ok`/`bt-loss`/`bt-err`.

**Test-Design** (keine aktiven Reports — reine Empfangsmessung):
1. `resetTransportStats()` aufrufen.
2. 10 s messen (`performance.now()`), Poll der Stats alle 500 ms.
3. Verdict nach Ablauf (oder bei Cancel):
   - `reports === 0` → FAIL (`btNoData`)
   - `crcErrors / reports > 0.05` (> 5 % CRC-Fehler) → FAIL (`btCrc`)
   - `seqGaps / (reports + seqGaps) > 0.02` (> 2 % Paketverlust) → FAIL (`btLoss`)
   - sonst PASS (`btOk`) mit Zusammenfassung „{reports} Berichte · {loss} % Verlust · {crc} CRC-Fehler".

- [ ] **Step 1: Failing Tests schreiben**

In `QuickTestModal.test.ts` (bestehendes Harness: `makeManager` mit vi.fn-Stubs, `initI18n()`; jsdom-Direktive):

```ts
it('BT test passes with clean transport stats (#119)', async () => {
  vi.useFakeTimers();
  const manager = makeManager({ transport: 'bt' });
  // getTransportStats simuliert 200 saubere Frames
  manager.getTransportStats = vi.fn(() => ({ reports: 200, seqGaps: 0, crcErrors: 0, lastSeq: 7 }));
  manager.resetTransportStats = vi.fn();
  render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
  await act(async () => { await userEvent.click(screen.getByTestId('test-bt')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
  expect(screen.getByTestId('status-bt')).toHaveTextContent(/ok/i);
  expect(manager.resetTransportStats).toHaveBeenCalled();
  vi.useRealTimers();
});

it('BT test fails on packet loss (#119)', async () => {
  vi.useFakeTimers();
  const manager = makeManager({ transport: 'bt' });
  manager.getTransportStats = vi.fn(() => ({ reports: 100, seqGaps: 20, crcErrors: 0, lastSeq: 5 }));
  render(QuickTestModal, { props: { open: true, manager, transport: 'bt' } });
  await act(async () => { await userEvent.click(screen.getByTestId('test-bt')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(10_500); });
  expect(screen.getByTestId('status-bt')).toHaveTextContent(/fail/i);
  vi.useRealTimers();
});

it('BT test is not rendered on USB transport (#119)', () => {
  const manager = makeManager({ transport: 'usb' });
  render(QuickTestModal, { props: { open: true, manager, transport: 'usb' } });
  expect(screen.queryByTestId('test-bt')).not.toBeInTheDocument();
});
```
(Falls `makeManager` keine `transport`-Option hat: Option ergänzen — sie setzt nur `manager.currentController.transport`.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (`npx vitest run src/lib/components/QuickTestModal.test.ts`)

- [ ] **Step 3: Implementieren**

`QuickTestModal.svelte`:
- Props erweitern: `transport: 'usb' | 'bt' = 'usb'` (ControllerPanel reicht `manager.getTransport()` durch, reaktiv, aktualisiert bei jedem Poll).
- `TESTS`-Array: `tests = [...bestehend, ...(transport === 'bt' ? [{ id: 'bt', labelKey: 'quickTest.btTitle' }] : [])]` — als `$derived` (transport ist reaktiv).
- Neue Funktion:

```ts
async function runBtTest() {
  const id = 'bt';
  manager.resetTransportStats();
  statuses[id] = 'running';
  const started = performance.now();
  while (performance.now() - started < 10_000 && btAbort === null) {
    await new Promise((r) => setTimeout(r, 500));
  }
  const s = manager.getTransportStats();
  const loss = (s.seqGaps / (s.reports + s.seqGaps)) || 0;
  const crc = s.reports > 0 ? s.crcErrors / (s.reports + s.crcErrors) : 1;
  if (btAborted) { statuses[id] = 'idle'; return; }
  if (s.reports === 0) statuses[id] = 'fail:' + LL.quickTest.btNoData();
  else if (crc > 0.05) statuses[id] = 'fail:' + LL.quickTest.btCrc();
  else if (loss > 0.02) statuses[id] = 'fail:' + LL.quickTest.btLoss();
  else statuses[id] = 'ok:' + LL.quickTest.btOk({ reports: s.reports, loss: Math.round(loss * 100), crc: s.crcErrors });
}
```
  (Abbruch-Mechanismus wie beim Buttons-Test: Modul-lokales `btAborted = false`, in `close()`/`onDestroy` auf true. Bestehende Muster der Komponente folgen — kein neuer globaler Mechanismus erfinden.)
- `runTest`-Switch um `case 'bt': return runBtTest();` erweitern. Der BT-Test läuft NICHT in den `actuatorToken`-Flow (Task 12) — er sendet nichts.

i18n-Keys `quickTest`: `btTitle: 'Bluetooth-Verbindungstest'`, `btOk: 'Stabil: {reports} Berichte · {loss} % Verlust · {crc} CRC-Fehler'`, `btNoData: 'Keine Berichte empfangen'`, `btCrc: 'Zu viele CRC-Fehler (> 5 %)'`, `btLoss: 'Zu hoher Paketverlust (> 2 %)'`; `en`-Spiegel (btTitle: 'Bluetooth connection test', btOk: 'Stable: {reports} reports · {loss}% loss · {crc} CRC errors', btNoData: 'No reports received', btCrc: 'Too many CRC errors (> 5%)', btLoss: 'Too much packet loss (> 2%)').

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (+ `npm run i18n` falls neue Keys)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(#119): Bluetooth connection test (10s receive measurement, loss/CRC verdicts) in QuickTestModal"
```

---

## Task 10: Feature-Flows über BT sperren („nur über USB")

**Files:**
- Modify: `src/lib/components/ControllerPanel.svelte` (Gating-Logik + Hinweis)
- Modify: `src/lib/controllers/ds5-controller.ts` (Guard in BT-inkompatiblen Settern)
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts`
- Test: `src/lib/controllers/ds5-controller.test.ts`

**Hintergrund:** Kalibrierung (0x80/0x82/0x83-Feature-Reports) und NVS-Zugriff sind über BT nicht zuverlässig (Kernel-Filterung + CRC-Feature-Framing unsicher). Diese Buttons werden im BT-Modus disabled + Hinweis angezeigt. **Aktive Tests** (Licht, Vibration, Trigger, Speaker, Mikrofon) bleiben über BT nutzbar (Output-Report 0x31 ist CRC-gesichert und verifiziert).

- [ ] **Step 1: Failing Test schreiben**

In `ds5-controller.test.ts`:

```ts
it('throws a German BT-gating error on calibration over BT (#120)', async () => {
  const { device, ctrl } = makeFakeDs5('bt');
  await expect(ctrl.calibrateSticksBegin()).rejects.toThrow(/Bluetooth/);
});
```
(Falls `makeFakeDs5` keinen Transport-Parameter hat: Transport über `ctrl.setTransport('bt')` setzen — dann vor dem Aufruf.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren**

In `DS5Controller` ein Guard-Helfer (privat):

```ts
/** Feature/flash/calibration flows need a USB connection: BT carries a
 * different feature-report framing the Linux kernel does not reliably route,
 * so these flows are gated here (and disabled in the UI, #120). */
private requireUsb(flow: string): void {
  if (this.transport === 'bt') {
    throw new Error(`${flow} ist nur über USB verfügbar — Controller per USB verbinden.`);
  }
}
```

Aufruf am Anfang von: `queryNvStatus`, `nvsUnlock`, `nvsLock`, `calibrateSticksBegin`, `calibrateRangeBegin`, `flash`, `getInMemoryModuleData`, `writeFinetuneData`, `saveInMemoryModuleData` (jeweils mit Flow-Namen auf Deutsch: `'Kalibrierung'`, `'NVS-Zugriff'`, `'Speichern'` …).

UI: `ControllerPanel.svelte` — Buttons „Speichern"/Kalibrierungs-Öffner/NVS erhalten `disabled={transport === 'bt'}` (+ `title`-Hinweis). Ein dezenten Banner unterhalb der Statuszeile:

```svelte
{#if transport === 'bt'}
  <div class="rounded-lg border border-amber-700/40 bg-amber-900/30 px-3 py-2 text-xs text-amber-200">
    {$LL.controller.btFeatureGate()}
  </div>
{/if}
```
i18n: `btFeatureGate: 'Kalibrieren, NVS und Speichern sind nur über USB verfügbar.'` / en `'Calibration, NVS and save are only available over USB.'`

- [ ] **Step 4: Tests laufen lassen — erwartet PASS**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(#120): gate calibration/NVS/save flows over BT with German errors + UI notice"
```

---

## Task 11: CalibrationModal — Range-Busy-Fix, RangeEnd bei Abbruch, Run-Token

**Files:**
- Modify: `src/lib/components/CalibrationModal.svelte`
- Test: `src/lib/components/CalibrationModal.test.ts`

**Bugs (aus Spec):**
1. `runRangeCalibration`: bei Erfolg bleibt `busy = true` → Fertig-Button (`!busy`-Bedingung) nie erreichbar; nur der catch-Zweig resettet.
2. `close()` beim Range-Step sendet niemals `calibrateRangeEnd` → Stick-Kalibrierung bleibt im Range-Modus hängen (Controller-Side).
3. Kein Run-Token: zwei parallele Starts (`start()` während laufender Range) kollidieren — alte Async-Fortsetzungen schreiben in neue Run.

- [ ] **Step 1: Failing Tests schreiben**

```ts
it('resets busy after successful range calibration (#121)', async () => {
  const manager = makeManager({}); // alle Methoden ok
  const { component } = render(CalibrationModal, { props: { open: true, manager, initialMode: 'range' } });
  await act(async () => { await component.start?.() ?? userEvent.click(screen.getByText(/Start/i)); });
  // Fortlauf des Range-Flows bis fertig — busy-Reset prüfen:
  await act(async () => { /* Range-Flow vollständig durchlaufen lassen (bestehender Harness-Helper) */ });
  expect(screen.getByRole('button', { name: /Fertig/i })).not.toBeDisabled();
});
```
(Für die genaue Fortlauf-Hilfsroutine: bestehende Range-Tests dieser Datei nutzen — deren Schrittfolge kopieren; die Assertion „Fertig nicht disabled" ist das neue Verhalten.)

```ts
it('sends calibrateRangeEnd when closed during range step (#121)', async () => {
  const manager = makeManager({});
  render(CalibrationModal, { props: { open: true, manager, initialMode: 'range' } });
  await act(async () => { /* Range-Flow bis step 1 laufen lassen */ });
  await act(async () => { component.close(); });
  expect(manager.calibrateRangeEnd).toHaveBeenCalled();
});
```
(Auch hier: bestehende Schritt-Hilfsroutine wiederverwenden.)

```ts
it('ignores a stale run when start is re-entered (#121)', async () => {
  const manager = makeManager({ rangeBeginDelayMs: 50 }); // begin antwortet verzögert
  const { component } = render(CalibrationModal, { props: { open: true, manager, initialMode: 'range' } });
  const p1 = component.start();
  const p2 = component.start();
  await act(async () => { await Promise.all([p1, p2]); });
  // Kein Fehler, keine doppelten Sample-Aufrufe:
  expect(manager.calibrateRangeSample).toHaveBeenCalledTimes(2); // je Run einmal, alter Run abgeworfen
});
```

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren**

In `CalibrationModal.svelte`:

```ts
let activeRun = 0; // run token: increments on every start/close, stale continuations bail out

async function runRangeCalibration() {
  const run = ++activeRun;
  busy = true;
  error = null;
  try {
    await manager.calibrateRangeBegin();
    step = 1;
    // Sampling-Loop (bestehender Code) — jede Iteration: if (run !== activeRun) return;
    while (samples < SAMPLE_COUNT && run === activeRun) { … bestehende Loop … }
    if (run !== activeRun) return; // veralteter Run — nichts setzen
    await manager.calibrateRangeEnd();
    if (run !== activeRun) return;
    step = 2;
  } catch (e) { … bestehend … } finally {
    if (run === activeRun) busy = false; // nur der aktuelle Run darf busy freigeben
  }
}

async function close() {
  // Range-Abbruch: dem Controller Bescheid geben, sonst bleibt die
  // Range-Kalibrierung hardwareseitig aktiv.
  if (mode === 'range' && step >= 1 && !rangeFinished) {
    const run = ++activeRun;
    busy = false;
    try { await manager.calibrateRangeEnd(); } catch { /* Best effort */ }
    void run;
  }
  open = false;
  reset();
}
```
(`rangeFinished` = bestehendes Flag/die bestehende Bedingung, dass step 2 erreicht wurde — falls nicht vorhanden: `step !== 2` als Kriterium. Bestehendes `reset()` bleibt.)

Zusätzlich: `busy = false` im Erfolgs-Zweig (das ist der eigentliche Bug-1-Fix, oben durch das `finally` gedeckt, das jetzt bei `run === activeRun` IMMER resettet).

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (`npx vitest run src/lib/components/CalibrationModal.test.ts`)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(#121): CalibrationModal range flow — busy release on success, rangeEnd on close, run token"
```

---

## Task 12: QuickTest-Lifecycle — actuatorToken, Reset bei Unmount, Lights-Verdict-Logging

**Files:**
- Modify: `src/lib/components/QuickTestModal.svelte`
- Test: `src/lib/components/QuickTestModal.test.ts`

**Bugs (aus Spec):**
1. Speaker-Done-Callback-Race: nach Modal-Abbruch feuert der verzögerte `doneCb` noch und überschreibt den Status eines neu gestarteten Tests.
2. `onDestroy` resettet Aktuatoren nicht (nur Buttons-Abbruch + Lights-Interval) → Vibration/Trigger/Lights bleiben physisch an, wenn die Komponente unmounted wird.
3. Lights-Test-Ergebnis wird nie in das `testCompletedLog` geschrieben.

- [ ] **Step 1: Failing Tests schreiben**

```ts
it('stale speaker done callback does not overwrite a newer test status (#122)', async () => {
  vi.useFakeTimers();
  const manager = makeManager({});
  // setSpeakerTone mit duration → doneCb feuert verzögert
  render(QuickTestModal, { props: { open: true, manager } });
  await act(async () => { await userEvent.click(screen.getByTestId('test-speaker')); });
  await act(async () => { await userEvent.click(screen.getByTestId('close')); }); // Modal zu, Test abgebrochen
  // Neuer Test startet:
  const statuses2: Record<string, string> = {};
  await act(async () => { manager.setSpeakerTone.mock.calls[0][2]?.({ success: true }); });
  // Der alte doneCb darf den Status des (nicht laufenden) neuen Runs nicht korrumpieren —
  // konkrete Assertion: kein Status-Update für 'speaker' nach close.
  expect(screen.queryByTestId('status-speaker')).toBeNull();
  vi.useRealTimers();
});
```
(Anpassen an die konkreten testIds der Datei — Muster aus den bestehenden QuickTest-Tests übernehmen.)

```ts
it('resets actuators on destroy (#122)', () => {
  const manager = makeManager({});
  const { unmount } = render(QuickTestModal, { props: { open: true, manager } });
  unmount();
  expect(manager.resetLights).toHaveBeenCalled();
  expect(manager.setVibration).toHaveBeenCalledWith(0, 0);
  expect(manager.setAdaptiveTrigger).toHaveBeenCalledWith(
    expect.objectContaining({ mode: 'off' }), expect.objectContaining({ mode: 'off' })
  );
});
```

```ts
it('logs the lights verdict into testCompletedLog (#122)', async () => {
  vi.useFakeTimers();
  const manager = makeManager({});
  render(QuickTestModal, { props: { open: true, manager } });
  await act(async () => { await userEvent.click(screen.getByTestId('test-lights')); });
  await act(async () => { await vi.advanceTimersByTimeAsync(3_500); }); // Lights-Dauer
  // Log enthält einen lights-Eintrag mit Pass/Fail-Verdict:
  const logged = JSON.stringify((screen.getByTestId('completed-log') as HTMLElement).textContent ?? '');
  expect(logged).toMatch(/lights/i);
  vi.useRealTimers();
});
```
(Falls `completed-log`-testId nicht existiert: das bestehende Log-Sichtbarkeitsmuster der Datei nutzen.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren**

In `QuickTestModal.svelte`:

```ts
let actuatorToken = 0; // bumped on every close/unmount/test start — stale continuations bail out

function resetActuators(): void {
  void manager.setVibration(0, 0);
  void manager.setAdaptiveTrigger({ mode: 'off', start: 0, end: 0, force: 0 },
    { mode: 'off', start: 0, end: 0, force: 0 });
  void manager.resetLights();
  void manager.resetSpeakerSettings();
}
```
- `runTest`-Einstieg: `const token = ++actuatorToken;` — `doneCb` des Speaker-Tests: `(r) => { if (token !== actuatorToken) return; statuses[id] = … }` (Zeilen ~212–214).
- Lights-Test (`startLightsTest`/`stopLightsTest`): nach Verdict `statuses['lights']` setzen, dann `testCompletedLog` um den Eintrag ergänzen (dasselbe Format wie buttons/haptic/speaker-Einträge an :232 — mit `lights` und Verdict). Achtung: `lightsTestFailed`-Flag (245) bleibt Quelle des Verdicts.
- `close()` (305–333): zusätzlich `actuatorToken++` und `resetActuators()` (bestehende Resets der Zeilen ~307–312 dürfen durch resetActuators ersetzt/vereint werden).
- `onDestroy` (337–343): `actuatorToken++` + `resetActuators()`.

- [ ] **Step 4: Tests laufen lassen — erwartet PASS**

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "fix(#122): QuickTest actuator token, actuator resets on close/unmount, lights verdict logged"
```

---

## Task 13: Mock-Parität — Output-Spiegelung, Canned-Feature-Responses, BT-Modus, Error-Injection

**Files:**
- Modify: `src/lib/mock/core.ts` (hid_send_output_report, hid_send_feature_report, hid_connect BT-Simulation)
- Modify: `src/lib/mock/state.ts` (mirrored output, ERROR_INJECTABLE)
- Modify: `src/lib/components/MockPanel.svelte` (Error-Injection-Knöpfe, falls Panel schon Error-UI hat: Feld ergänzen)
- Test: `src/lib/mock/core.test.ts` (falls nicht vorhanden: neu mit jsdom-Direktive)

**Ziel:** Der Mock verhält sich protokollgerecht zum echten DS5 — dann decken dieselben Tests Hardware- und Mock-Pfad ab („Mock-Parität" aus dem Design).

- [ ] **Step 1: Failing Tests schreiben**

```ts
// src/lib/mock/core.test.ts (neu)
// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { mockState, resetMockState } from './state';
import { hidSendOutputReport, hidSendFeatureReport, hidReceiveFeatureReport } from './core';

describe('mock output mirroring (#123)', () => {
  beforeEach(() => resetMockState());

  it('hidSendOutputReport stores the report in mockState.lastOutputReport', async () => {
    const payload = new Uint8Array(48).fill(0);
    payload[0] = 2; // output report id
    payload[44] = 0xff; // lightbar R
    await hidSendOutputReport(Array.from(payload));
    expect(mockState.lastOutputReport).not.toBeNull();
    expect(mockState.lastOutputReport![44]).toBe(0xff);
  });

  it('hidSendOutputReport mirrors lightbar color into the next input report', async () => {
    const payload = new Uint8Array(48).fill(0);
    payload[0] = 2;
    payload[44] = 10; payload[45] = 20; payload[46] = 30;
    await hidSendOutputReport(Array.from(payload));
    const report = await hidPoll();
    expect(report.length).toBeGreaterThan(44);
    // Mock-Input spiegelt das Color-Set an Input-Offsets 44-46 (identische Struct-Offsets).
    expect(mockState.mirroredLightbar).toEqual([10, 20, 30]);
  });
});

describe('canned feature replies (#123)', () => {
  beforeEach(() => resetMockState());

  it('hidSendFeatureReport 0x83 calibration cmd answers with the big-endian ack', async () => {
    const cmd = new Uint8Array([0x02, 0x01, 0x02]); // range begin ([2,1,2])
    await hidSendFeatureReport(0x80, Array.from(cmd));
    const out = await hidReceiveFeatureReport(0x83, 64);
    expect(Array.from(out.slice(0, 4))).toEqual([0x83, 0x01, 0x02, 0x02]);
  });

  it('hidSendFeatureReport 0x80 get-calibration answers a valid module blob', async () => {
    await hidSendFeatureReport(0x80, Array.from([0x01]));
    const out = await hidReceiveFeatureReport(0x80, 64);
    expect(out.length).toBeGreaterThan(10);
    expect(out[0]).toBe(0x80);
  });
});
```
(Exakte Funktionsnamen im Mock prüfen — die Exporte heißen ggf. anders (`hid_send_output_report`-Wrapper); an die realen Namen anpassen, nicht die Mocks umbenennen. `hidPoll` ebenso.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL** (Felder/Verhalten existieren nicht)

- [ ] **Step 3: Implementieren — mock/state.ts**

```ts
/** Last output report sent (mock layer mirrors the real device's behavior so
 * tests can assert what the protocol layer actually sent, #123). */
export let lastOutputReport: number[] | null = null;
export let mirroredLightbar: [number, number, number] = [0, 0, 0];
```
(Falls `mockState` ein Objekt-Literal ist: Felder `lastOutputReport: null as number[] | null`, `mirroredLightbar: [0, 0, 0] as [number, number, number]`; `resetMockState()` resettet beide.)

- [ ] **Step 4: Implementieren — mock/core.ts**

`hid_send_output_report`-Handler:

```ts
// Mirror the DS5 output report (report id 0x02, 47-byte common payload) so
// tests can assert protocol behavior without hardware (#123).
mockState.lastOutputReport = data; // oder Array.from(data) je nach Mock-Konvention
// Lightbar color bytes @44-46 of the common payload (verified layout).
if (data.length >= 47) {
  mockState.mirroredLightbar = [data[44 - 1], data[45 - 1], data[46 - 1]]; // ohne Report-Id-Byte ggf. ohne -1
}
```
  ⚠️ Offset-Prüfung: liegt die Payload mit oder ohne Report-Id-Byte vor (Rust schickt das id-Byte mit)? Im Test mit `payload[0] = 2` liegt es MIT id-Byte vor → RGB bei 44/45/46 exakt (player@43 → 43). Der Code im Mock liest `[44][45][46]` vom vollen Frame und der Test assertet `lastOutputReport[44] === 0xff` — konsistent halten, Kommentar dazu.

Canned Feature-Replies (neuer Switch im `hid_send_feature_report`-Handler):

```ts
const buf = new Uint8Array(data);
// DS5 feature protocol canned replies so calibration/NVS flows run in mock
// mode (#123). Reply rule (verified against all 4 big-endian acks):
// reply = [0x83, 1, cmd[2], cmd[0] === 2 ? 2 : 1].
switch (reportId) {
  case 0x80:
    if (buf[0] === 0x08) { mockDs5StoreCalibrationChunk(buf); return { ok: true }; } // calibration data write
    mockDs5PrepareGetCalibration(); // fill the buffer hidReceiveFeatureReport(0x80) will return
    return { ok: true };
  case 0x82:
  case 0x83: {
    // Calibration command ack — big-endian value in the 0x83 get.
    const reply = [0x83, 1, buf[2], buf[0] === 2 ? 2 : 1];
    mockDs5StageFeatureReply(0x83, reply);
    if (buf[0] === 2) mockDs5StageFeatureReply(0x83, reply); // get + set ack identical (existing mock pattern)
    return { ok: true };
  }
  case 0x90: // NVS unlock/lock family — keep the existing mock reply if one exists.
  default:
    return { ok: true };
}
```
(Die `mockDs5*`-Helfer sind so zu benennen, wie die bestehenden Mock-Interna heißen — falls der Mock bislang gar keine Feature-Buffer hält: ein kleines `mockFeatureReply: Map<number, number[]>` in `mock/state.ts` + `hidReceiveFeatureReport` gibt sie zurück, sonst bestehendes Rampen-Verhalten.)

BT-Simulation: `hid_connect` im Mock merkt `mockState.simulateTransport: 'usb' | 'bt'` (default 'usb'), `MockPanel` bekommt einen Transport-Toggle; `hid_poll` liefert im BT-Modus Report-Id 0x31 + seq-Byte vorangestellt (77-Byte-Frame mit `fillBtInputCrc` aus `crc32.ts`, seq zyklisch ++mod 64).

- [ ] **Step 5: MockPanel — Error-Injection**

`mock/state.ts`:

```ts
/** Set of error conditions the mock layer can inject for resilience tests
 * (#123, #126 hardware-validation rehearsal). */
export const ERROR_INJECTABLE = ['hid-write', 'hid-connect', 'hid-read'] as const;
export type ErrorInjectable = (typeof ERROR_INJECTABLE)[number];
```
`MockPanel`: pro injizierbarem Fehler ein Toggle-Button („Fehler: HID-Write"), Setzen von `mockState.injectErrors: Set<ErrorInjectable>`; `hid_send_output_report` wirft bei aktivem `hid-write` einen Tauri-artigen Error (string reject).

- [ ] **Step 6: Tests laufen lassen — erwartet PASS**

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(#123): mock parity — output mirroring, canned DS5 feature replies, BT transport simulation, error injection"
```

---

## Task 14: Statuszeile + HID-Diagnose-Block + Deadzone-Slider

**Files:**
- Modify: `src/lib/components/ControllerPanel.svelte`
- Modify: `src/lib/controllers/tauri-hid-device.ts` (`hidDiagnostics`-Wrapper)
- Modify: `src/lib/i18n/de/index.ts` + `en/index.ts`
- Test: `src/lib/components/ControllerPanel.test.ts` (falls nicht vorhanden: für die neue Statuszeile neu anlegen — Harness-Muster eines bestehenden Component-Tests kopieren)

**Inhalt:**
1. **Statuszeile** unterhalb des Headers: Transport (USB/BT mit Icon), Akku (bestehende `batteryStatus`-Daten als kompakter Badge statt nur im Info-Block), Modus (Standard/Edge falls bekannt), Mikrofon/Kopfhörer-Badges (`micConnected`/`headphoneConnected` aus ProcessedInput).
2. **HID-Diagnose-Block** (aufklappbar, `<details>`): `write_count`, `write_errors`, `dropped_reports`, `last_write_error`, `open_path` — via `hidDiagnostics()`-Poll (alle 2 s nur wenn `<details>` offen ist).
3. **Deadzone-Slider** im TesterPanel-Bereich der Sticks (0–20 %, default 0): rein frontend-seitige Skalierung der angezeigten Stick-Positionen (Visualizer) — kein Protokoll-Write. Persistenz via bestehendem Settings-Mechanismus (`settings_get/set` → Key `fixplay-stick-deadzone`), try/catch wie überall.

- [ ] **Step 1: Failing Tests schreiben**

```ts
// ControllerPanel.test.ts (neu oder ergänzt)
// @vitest-environment jsdom
import { initI18n } from '$lib/i18n/i18n-svelte'; // an bestehendes Pattern anderer Component-Tests angepasst
// … bestehendes Mock-Layer-Harness (mockState/resetMockState) dieses Repos …

it('status row shows BT transport badge (#124)', async () => {
  initI18n();
  // Connect-Flow via Mock-Layer antreiben, Transport auf 'bt' erzwingen:
  mockState.simulateTransport = 'bt';
  render(ControllerPanel);
  await act(async () => { await userEvent.click(screen.getByRole('button', { name: /Verbinden/i })); });
  expect(await screen.findByTestId('transport-badge')).toHaveTextContent(/BT/);
});

it('diagnostics block lists write counters (#124)', async () => {
  initI18n();
  mockState.hidWriteCount = 5;
  mockState.hidWriteErrors = 1;
  render(ControllerPanel);
  await act(async () => { await userEvent.click(screen.getByRole('button', { name: /Verbinden/i })); });
  const details = await screen.findByTestId('hid-diagnostics');
  details.open = true;
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(details.textContent).toMatch(/5/);
});
```
(Mock-Feldnamen an die in Task 13 angelegten anpassen — `hidDiagnostics` braucht einen Mock-Command-Handler, der `mockState`-Zähler liefert.)

- [ ] **Step 2: Test laufen lassen — erwartet FAIL**

- [ ] **Step 3: Implementieren**

`tauri-hid-device.ts`:

```ts
export interface HidDiagnostics {
  connected: boolean;
  open_path: string | null;
  write_count: number;
  write_errors: number;
  dropped_reports: number;
  last_write_error: string | null;
}

export async function hidDiagnostics(): Promise<HidDiagnostics> {
  return await invoke<HidDiagnostics>('hid_diagnostics');
}
```
(Registration `hid_diagnostics` in `lib.rs` invoke_handler ergänzen — Task 5 legt den Command an, hier kommt die Registration mit.)

`ControllerPanel.svelte` Statuszeile (nach dem Header, vor dem Log):

```svelte
<div class="flex flex-wrap items-center gap-2 rounded-lg bg-gray-900 px-3 py-2" data-testid="status-row">
  <span class="flex items-center gap-1 rounded bg-gray-800 px-2 py-0.5 text-xs" data-testid="transport-badge">
    {#if transport === 'bt'}📶 BT{:else}🔌 USB{/if}
  </span>
  <span class="rounded bg-gray-800 px-2 py-0.5 text-xs">🔋 {batteryText}</span>
  {#if micConnected}<span class="rounded bg-gray-800 px-2 py-0.5 text-xs">🎤</span>{/if}
  {#if headphoneConnected}<span class="rounded bg-gray-800 px-2 py-0.5 text-xs">🎧</span>{/if}
</div>
```
(Reaktive Variablen `transport`/`batteryText`/`micConnected`/`headphoneConnected` aus dem bestehenden Polling-Loop ableiten — die Poll-Results fließen schon in Stores/lokale States; hier nur die Ableitung ergänzen. Icons: lucide-svelte-Icons statt Emoji bevorzugt — `Bluetooth`, `Usb`, `BatteryCharging`, `Mic`, `Headphones`.)

Diagnose-Block:

```svelte
<details class="rounded-lg bg-gray-900 px-3 py-2 text-xs text-gray-400" data-testid="hid-diagnostics">
  <summary class="cursor-pointer select-none">{$LL.controller.diagnosticsTitle()}</summary>
  <div class="mt-2 grid grid-cols-2 gap-1">
    <span>{$LL.controller.diagWrites()}: {diag?.write_count ?? 0}</span>
    <span>{$LL.controller.diagWriteErrors()}: {diag?.write_errors ?? 0}</span>
    <span>{$LL.controller.diagDropped()}: {diag?.dropped_reports ?? 0}</span>
    <span>{$LL.controller.diagPath()}: {diag?.open_path ?? '—'}</span>
    {#if diag?.last_write_error}
      <span class="col-span-2 text-red-300">{diag.last_write_error}</span>
    {/if}
  </div>
</details>
```
i18n-Keys (`controller`): `diagnosticsTitle: 'HID-Diagnose'`, `diagWrites: 'Writes'`, `diagWriteErrors: 'Write-Fehler'`, `diagDropped: 'Verworfene Reports'`, `diagPath: 'Gerätepfad'`; en-Spiegel (`diagnosticsTitle: 'HID diagnostics'`, `diagWrites: 'Writes'`, `diagWriteErrors: 'Write errors'`, `diagDropped: 'Dropped reports'`, `diagPath: 'Device path'`).

Deadzone: in `TesterPanel.svelte` (Sticks-Bereich) ein Slider 0–20 %; Anwendungsstelle: die `scaled()`-Analoga der Sticks — Visualizer erhält `deadzone(x, y)`-gefilterte Werte:

```ts
export function applyDeadzone(x: number, y: number, dz: number): { x: number; y: number } {
  // dz in percent (0-20); radial deadzone on the -1..1 stick value pair.
  if (dz <= 0) return { x, y };
  const r = Math.hypot(x, y);
  if (r < dz / 100) return { x: 0, y: 0 };
  return { x, y };
}
```
  (In `controller-manager.ts` als exportierte Pure-Function + Unit-Test; Persistenz via bestehendem Settings-Store-Pattern der App.)

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (+ `npm run check` wegen neuer i18n-Keys)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(#124): status row (transport/battery/mic), HID diagnostics block, stick deadzone slider"
```

---

## Task 15: Store-Hygiene + Touchpad 1920×1080 + i18n-Leaks

**Files:**
- Modify: `src/lib/stores/controller.ts` (tote Stores entfernen, `controllerTransport` hinzufügen falls Task 7/8 ihn statt eines lokalen States nutzen)
- Modify: `src/lib/controllers/controller-manager.ts` (`getSupportedQuickTests`/`setInputReportHandler`/`getInputHandler`/`hasChangesToWrite`-Leichen prüfen — nur entfernen, wenn grep keine Referenzen zeigt)
- Modify: `src/lib/controllers/touch-gesture.ts` + `TouchpadGestureVisualizer.svelte` + `src/lib/mock/core.ts` (Touchpad 1920×1080)
- Modify: `src/lib/components/MicLevelMeter.svelte` + `MicSpectrumView.svelte` (i18n)
- Test: `src/lib/controllers/touch-gesture.test.ts`, bestehende Visualizer-Tests

**Vor jedem Entfernen:** `grep -rn "<symbol>" src/` — nur entfernen, wenn NUL Referenzen außerhalb der Definition.

- [ ] **Step 1: Touchpad-Auflösung**

Kernel + daidr: DS5-Touchpad ist **1920×1080** (nicht 1920×942). `touch-gesture.ts:33`-Kommentar, `norm()` (Zeile 115: `y / 941`) und `mock/core.ts` `buildDs5InputReport` (y-Clamp 941 → 1079) anpassen:

```ts
/** Touchpad is 1920×1080 (kernel hid-playstation.c dualsense_touch_report). */
const TOUCHPAD_WIDTH = 1920;
const TOUCHPAD_HEIGHT = 1080;
```
`SwipeDirection` bleibt wie ist ('links' | 'rechts' | 'oben' | 'unten' — UI-intern, kein i18n-Leak). Failing-Test zuerst:

```ts
it('normalizes touch y against the 1080-tall pad (#125)', () => {
  expect(norm(540)).toBeCloseTo(0.5);
  expect(norm(1080)).toBe(1); // oder <= 1 je bestehender Clamp-Semantik
});
```

- [ ] **Step 2: i18n-Leaks in Mikrofon-Visualizern**

Je 3 deutsche Literals in `MicLevelMeter.svelte` + `MicSpectrumView.svelte` ('Kein DualSense-Mikrofon gefunden…', 'Mikrofon-Zugriff verweigert…', 'Mikrofon-Fehler: …'). i18n-Keys Gruppe `mic`:

de: `micNoDevice: 'Kein DualSense-Mikrofon gefunden'`, `micDenied: 'Mikrofon-Zugriff verweigert — in den Systemeinstellungen erlauben'`, `micError: 'Mikrofon-Fehler: {error}'`
en: `micNoDevice: 'No DualSense microphone found'`, `micDenied: 'Microphone access denied — allow it in system settings'`, `micError: 'Microphone error: {error}'`

Komponenten: `import LL from '$lib/i18n/i18n-svelte'` + `$LL.mic.*` in Markup, `get(LL)` im Script — bestehende Visualizer-Pattern (TouchpadGestureVisualizer) kopieren. Failing-Test: render-Test pro Komponente, der bei simuliertem `getUserMedia`-Fehler den lokalisierten Text assertet (falls die Komponenten untestbar an den Streams hängen: mindestens Text-Literals raus + `npm run check` grün; Test für die Error-Formatierung als Pure-Function extrahieren, falls sinnvoll).

- [ ] **Step 3: Tote Stores/Methoden entfernen**

`stores/controller.ts`: `controllerConnection`, `controllerNvStatus`, `controllerHasChanges` — grep-geprüft entfernen, `controllerTransport`-Store hinzufügen falls Tasks 7–14 ihn nutzen (wenn die Panels stattdessen lokalen Svelte-State nutzen: Store NICHT anlegen — nur tote Reste weg).

`controller-manager.ts`: `getSupportedQuickTests`, `setInputReportHandler`, `getInputHandler` — grep-geprüft entfernen (BaseController.getSupportedQuickTests auch). `hasChangesToWrite` wird aktiv benutzt (flash-Flow) — bleibt.

- [ ] **Step 4: Tests laufen lassen — erwartet PASS** (+ `npm run check`, `npm run lint`)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore(#125): store hygiene, touchpad 1920x1080, localize mic visualizer errors"
```

---

## Task 16: Deployment auf dev-diagnosetool.fixplay.de + Hardware-Validierung

**Files:**
- Modify: keine (Ausführung)
- Ausführen: Docker-Test-Runs, Mock-E2E, Dev-Deployment, Hardware-Checkliste

**Hinweis:** Rust-Builds für das Dev-Deployment: der Dev-Server läuft das Frontend (Node 22 + MOCK=1) hinter Caddy — für reine UI-Änderungen reicht `bash fixplay-testserver.sh start --skip-backend` (Memory: fixplay-diagnosetool-dev-server / ui-dev-first). Der echte Tauri-Build (Rust) für die Hardware-Validierung läuft auf dem Linux-PC des Users via Release-Tag oder `make dev` dort.

- [ ] **Step 1: Volltest**

```bash
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 npx vitest run
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 npm run check
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app rust:1.86 sh -lc "apt-get update -qq && apt-get install -y -qq libudev-dev pkg-config >/dev/null && cargo test --workspace && cargo clippy --workspace -- -D warnings"
docker run --rm -v /root/fixplay-diagnoseTool:/app -w /app node:22 npm run lint
```

- [ ] **Step 2: Mock-E2E durchklicken (MOCK=1)**

`MOCK=1 npm run dev`-Flow (Node 22 im Docker oder lokal hinter Caddy): Connect → Statuszeile → Lichttest (Farben + Brightness) → QuickTest komplett (incl. BT-Modus-Toggle) → Kalibrierungs-Modal (Range: Start/Abbrechen/Fertig) → HID-Diagnose-Block → Error-Injection (write-Fehler → Diagnose-Block zeigt Zähler + letzten Fehler).

- [ ] **Step 3: Dev-Deployment**

```bash
bash /root/fixplay-testserver/fixplay-testserver.sh start --skip-backend
```
Verifikation: `https://dev-diagnosetool.fixplay.de` lädt die neue Version (Cache-Bypass: Hard-Reload).

- [ ] **Step 4: Hardware-Checkliste (User am Linux-PC, echte Tauri-App via `make dev` oder Release-Build)**

Dem User als Checkliste geben (deutsche Kurzanleitung im Chat):
1. **USB-Connect** → Statuszeile: USB-Badge + Akku.
2. **Lichttest** (Haupt-Repro des Bug): Lightbar-Farbe ändern → **muss sichtbar** reagieren (flag2/lightbar_setup ist jetzt sendbar). Brightness-Slider → Helligkeit reagiert.
3. **Adaptive Trigger**: Resistance/Auto/Single je Modus spürbar (Left/Right getrennt).
4. **Vibration**: heavy/light.
5. **Kalibrierung Stick + Range**: inkl. Abbruch mitten im Range-Flow → Controller danach normal nutzbar.
6. **Bluetooth**: Controller per BT verbinden → Transport-Badge BT → BT-Verbindungstest (10 s) → Verdict plausibel; Licht/Vibration über BT → funktioniert.
7. **Device-Picker**: falls mehrere DS5-Geräte (z. B. Edge) — Picker erscheint.
8. **Unplug-Test**: Kabel ziehen → UI zeigt Disconnect (kein Hängen).
9. **Mikrofon**: Mic-Level/Spektrum mit i18n-Texten.

- [ ] **Step 5: ROADMAP abhaken** — Items #111–#126 auf erledigt setzen (Format der bestehenden erledigten Items folgen).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "docs(#126): ROADMAP items #111-#126 checked off after hardware validation"
```

---

## Plan-Selbstcheck (vor Übergabe an die Ausführung)

- [x] Alle 16 verifizierten Bugs aus der Spec sind in Tasks gemappt (Spec-Kapitel ↔ Task-Nr: flags/pack→1, baseline/battery→2, triggers/vibration→3, playerLED/logs→4, rust→5/6/7, bt→8/9/10, calib→11, quicktest→12, mock→13, ui→14, hygiene→15, deploy→16).
- [x] Keine Platzhalter wie „…", „TODO", „analog" in Implementation-Code-Blöcken; Stellen mit bewusstem Verweis auf bestehenden Code sind als solche markiert („bestehender Körper … unverändert").
- [x] i18n: jeder neue Key hat de+en-Werte im Task verzeichnet.
- [x] Byte-Layout-Konstante (nur Offsets 9/37/38/41/42 neu) in Task 1 + Global Constraints wiederholt.
- [x] Rust-Commands: alle Registrationen (hid_diagnostics) explizit benannt.
- [x] Tests folgen Repo-Regeln (kein vi.mock von @tauri-apps/api, jsdom-Direktive, initI18n).
