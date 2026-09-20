# DS5-Controller-Panel: Überarbeitung „Reparieren + Aufrüsten"

**Datum:** 2026-09-14
**Scope:** DualSense (DS5) Panel im fixplay-diagnoseTool — Protokoll-Layer, Rust-HID-Kommandos, Bluetooth-Unterstützung, Kalibrierung/QuickTest, Mock-Parität, UI-Aufwertung.
**Nicht im Scope:** Rust-Crates-Umstrukturierung, UI-Neubau von Grund auf, andere Controller-Modelle (DS4, Switch Pro).

---

## 1. Hintergrund und Diagnose

Der Nutzer testet den Controller-Tester **per USB an einem Linux-PC** und meldet: der Lichttest macht
„gar nichts am Controller". Ein Understand-Workflow (5 Reader + Synthese) kartierte das Subsystem; ein
adversarialer Verifizierer prüfte das Byte-Layout gegen vier unabhängige Quellen (Linux-Kernel
`hid-playstation.c`, daidr/dualsense-tester, Ohjurot/DualSense-Windows, nondebug/dualsense-explorer).

**Verifizierte Fakten:**

- Das Byte-Layout der App ist **korrekt**: `pack()` (ds5-controller.ts:159–186) schreibt
  `player_leds`@43, RGB@44–46, Right-Trigger@10–20, Left-Trigger@21–31 — identisch zur Kernel-Struct
  `dualsense_output_report_common` (47 Byte, `static_assert(sizeof == 47)`). Die Tests
  (ds5-controller.test.ts:83–96, 109–112) pinnen dieses Layout korrekt.
- **Der wahrscheinlichste „gar nichts"-Grund:** `pack()` nullt Offsets 32–42 radikal (Zeile 181) —
  die App kann **nie** `valid_flag2`/`lightbar_setup`/`led_brightness` senden. Der Kernel-Treiber
  fährt die Lightbar beim Freigeben in den Aus-Zustand (`DS_OUTPUT_LIGHTBAR_SETUP_LIGHT_OUT = BIT(1)`
  via `valid_flag2` bit1 + `lightbar_setup`). In diesem Zustand ignoriert die Hardware reine
  Farbwrites (`valid_flag1` bit2) visuell. → Lightbar bleibt dunkel, obwohl Writes ankommen.
- `initializeCurrentOutputState` (ds5-controller.ts:264) ist toter Code (nie aufgerufen) → kein
  Connect-Baseline-Write, keine sichtbare Write-Bestätigung.
- `hid.rs:139–145` verwirft das `device.write()`-Ergebnis: eine fehlgeschlagene Write ist von Erfolg
  ununterscheidbar. `hid_send_feature_report` hat keinen 512-Byte-Length-Guard (der Receive-Pfad hat
  ihn, hid.rs:263–268).
- Der Mock validiert nichts: `hid_send_output_report: () => {}` (mock/core.ts:285),
  Feature-Reply ist ein `i % 256`-Byte-Ramp, das keine DS5-Prüfung besteht.

**Weitere verifizierte Bugs (Sequenzielle Liste, alle mit file:line):**

1. **Range-Kalibrierung unvollendbar:** `runRangeCalibration()` setzt `busy=true` (CalibrationModal.svelte:153);
   nur der catch (:177) resettet — Erfolgspfad nicht. „Fertig"-Button (:425) ist an `!busy` gebunden
   → unerreichbar. Abbruch sendet nie `calibrateRangeEnd` → Controller hängt im Range-Modus (0x82 [1,1,2],
   ds5-controller.ts:490–498). CalibrationModal.test.ts deckt nur Center-Mode ab.
2. **Hot-Unplug nie erkannt:** Reader-Thread (hid.rs:118–161) spinnt bei Read-Fehlern ohne Backoff;
   `hid_poll` (hid.rs:268–285) meldet ewig connected=true; 100 % CPU; Panel friert ein.
3. **Adaptive-Trigger-Parametrik falsch:** `setAdaptiveTrigger` (ds5-controller.ts:594–602) packt für
   jeden Modus `param0=start, param1=end, param2=force`. Referenz (daidr TriggerEffect.vue):
   `resistance` → [start, force], `auto` → [frequency, force, start]. Kein Clamping in diesem Pfad
   (setUint8 trunciert still). Der Auto-Modus-Frequenz-Slider (TesterPanel.svelte:806–815) schreibt ein
   Feld, das `setAdaptiveTrigger` nie liest — tot.
4. **PID-Verwirrung:** `0x0df2` ist der DualSense-**BT**-PID, nicht der Edge (Kommentar
   ControllerPanel.svelte:135–137 falsch; controller-manager.ts:467 falsch). Edge-USB-PID **0x0e5f**
   fehlt → Edge am Kabel verbindet nicht. `hidapi api.open` wählt beliebiges Match, kein Pfad-Targeting.
5. **BT-Transport-Race:** Transport wird nur aus eingehenden Reports gesetzt (controller-manager.ts:416–424);
   ControllerPanel schläft fix 80 ms (ControllerPanel.svelte:157–173) und ruft dann `getInfo` — zu kurz
   → Feature-Reports über BT ohne CRC-Frame (Seed 0x53) → Hardware verwirft sie stumm („error"-Serials).
6. **BT-Feature-Verkehr generell:** hid.rs:123–130 ist transport-agnostisch; ~20 Feature-Flows (Info 0x20,
   NVS 0x80/0x81, Kalibrierung 0x82/0x83, Speaker-Tone) scheitern über BT mit generischem `ok:false`.
   BT-Input-CRC wird nie validiert (0x31).
7. **Kalibrierungs-Rennen:** CalibrationModal `reset()` (:96–105) setzt busy=false während laufender
   awaits; Close→Reopen startet zweite Kette auf gleichem Gerät — Feature-Sends paaren sich mit fremden
   Replies (kein Serializer; controller-manager.ts:143–156). Zwei CalibrationModal-Instanzen teilen sich
   das Gerät (ControllerPanel.svelte:571–573).
8. **QuickTest:** „Lights" loggt Completion beim Start (QuickTestModal.svelte:208–210); nach Close/Disconnect
   feuert `doneCb({success:true})` nachträglich und überschreibt resetete Status (:263–280, :325–332).
   Unmount (:337–343) abortiert nur Buttons-Test → Vibration/Trigger/Lights bleiben am Gerät aktiv.
9. **Battery 0xF:** wird als „charging 0 % ⚡" gezeigt statt Fehlerzustand (ds5-controller.ts:783–786,
   ControllerVisualizer.svelte:403–415). Connect prüft `controllerInfo.ok` nicht (ControllerPanel.svelte:157–173).
10. **Dead Code / Dead Stores:** `controllerConnection/controllerNvStatus/controllerHasChanges`
    (stores/controller.ts:14–18), `getSupportedQuickTests`, `setInputReportHandler`/`getInputHandler`,
    `hidListDevices` (implementiert + registriert, nie importiert), `stickDeadzone` ohne Slider
    (Kommentar behauptet Gegenteil, controller.ts:55–59). Disconnect resettet nicht alle Stores
    (stickCircularity bleibt, controller.ts:67–70). `dropped_reports` (hid.rs:289) berechnet, nie angezeigt.
11. **Touchpad-Y-Range:** 941 (DS4) statt 1920×1080 (DualSense) in touch-gesture.ts:3/33/115 und
    TouchpadGestureVisualizer.svelte:20–23.
12. **i18n-Leaks:** harte deutsche Strings in ImuVisualizer/MicLevelMeter/MicSpectrumView/DriftSparkline/
    ControllerVisualizer; deutsches Swipe-Enum in EN-Locale interpoliert (touch-gesture.ts:16,
    en/index.ts:131); englische Log-Strings (ds5-controller.ts:395 „Changes saved successfully", literal „error").
13. **Rust-Robustheit:** alle HID-Commands sind sync `#[tauri::command]` (hid.rs:185,203,250,255,263) —
    verletzt Projektregel „sync hardware, async commands" (uart/i2c/flash sind async + spawn_blocking).
    `send_cmd!` (hid.rs:167–175) hält State-Mutex beim Blockieren auf SyncSender(32) → Deadlock mit
    60 Hz `hid_poll`. Reconnect joinalt den alten Reader-Thread nicht (hid.rs:204–229), Teardown
    **vor** dem Open — fehlgeschlagener Open zerstört funktionierende Verbindung. Reader-Thread:
    keine Read-Fehler-Schwelle, kein Backoff.
14. **`hidapi write()` Ergebnis verworfen** (hid.rs:139–145) — Partial-Write unsichtbar. Linux-hidraw
    Backend padet **nicht** (app-Kommentar „hidapi pads to 64" ist falsch für hidraw); Windows padet
    auf `OutputReportByteLength`. Write-Ergebnis (Byte-Anzahl) muss sichtbar sein.
15. **`setVibration`-Flag0-Semantik:** Kernel/Explorer setzen bit0 (`COMPATIBLE_VIBRATION`) und bit1
    (`HAPTICS_SELECT`) **gemeinsam** für Rumble; die App nennt die Bits „RIGHT/LEFT_VIBRATION" und setzt
    einzeln (ds5-controller.ts:69–70, setVibration-Pfad).
16. **Mock:** kein BT-Transport simulierbar (mock hid_poll sendet immer report_id 1, core.ts:286–295),
    keine Error-Injection für Output-Writes, NVS/Info/Kalibrierung im MOCK=1 alle kaputt.

---

## 2. Architektur (Ist, kompakt)

```
ControllerPanel.svelte ──invoke──► hid.rs (Rust, hidapi, Reader-Thread + mpsc-Queue)
      │                                    ▲
      ▼                                    │ send/receive feature, output, poll
DS5Controller (ds5-controller.ts) ── TauriHIDDevice (tauri-hid-device.ts)
      │  parse 0x01/0x31, encode 0x02/0x31+CRC32
ControllerManager (controller-manager.ts) → stores/controller.ts → Visualizer/Tester/QuickTest/Calibration
Mock-Layer (src/lib/mock) fängt alle 7 invoke-Commands im Browser (MOCK=1)
```

PIDs: USB `0x054c:0x0ce6` (Standard), `0x054c:0x0e5f` (Edge, neu), BT `0x054c:0x0df2`.

---

## 3. Design

### 3.1 Protokoll-Layer (ds5-controller.ts)

- `pack()` schreibt die verworfenen Felder: `powerSaveMuteControl`@9, `audioControl2`@37,
  `validFlag2`@38, `lightbarSetup`@41, `ledBrightness`@42.
- Neue `DS5_VALID_FLAG2`-Konstanten: `LIGHTBAR_SETUP_CONTROL_ENABLE = 0x02`,
  `COMPATIBLE_VIBRATION2 = 0x04`. `DS5_VALID_FLAG1` bereinigt: `RELEASE_LEDS = 0x08` und
  `AUDIO_CONTROL2 = 0x80` ersetzen die erfundenen `LED_BRIGHTNESS(0x20)/LIGHTBAR_SETUP(0x40)`-Bits;
  `flag1`-Bit3-Verwendung (RELEASE_LEDS) dort, wo Player-LEDs zurückgesetzt werden.
- **`setLightbarSetup(mode: 'light-on' | 'light-out')`**: setzt `validFlag2` bit1 + `lightbar_setup`
  (LIGHT_OUT = 0x02, light-on = 0x00). Wird vom „Reset"-Pfad und beim Connect aufgerufen → kann den
  Kernel-„aus"-Zustand zuverlässig aufheben. Das ist der Kern-Fix für den Lichttest.
- **Connect-Baseline:** beim Verbinden ein `initializeCurrentOutputState`-Write senden:
  flag2-Enable + light-on + Baseline-Lightbarfarbe (blau) → sichtbarer blauer
  Blitz bestätigt, dass Writes ankommen. Fehlschläge landen im Panel-Log.
  (`RELEASE_LEDS`/flag1-Bit3 wird bewusst NICHT gesendet: es gibt die Player-LEDs an die
  Firmware des Pads zurück — der Kernel hid-playstation.c setzt das Bit nie, RPCS3 nur auf
  seinem Disconnect-Pfad; ein Senden beim Connect würde die LED-Baseline ausheben. M6-Ruling.)
- `setLedBrightness(value)`: Brightness lebt in der `valid_flag2`-Region (led_brightness@42) und
  wird zusammen mit `flag2` bit1 (`LIGHTBAR_SETUP_CONTROL_ENABLE`) gesendet; es gibt kein
  flag1-Bit dafür (die alten `LED_BRIGHTNESS/LIGHTBAR_SETUP`-Flag1-Konstanten entfallen). UI:
  echter Helligkeits-Regler statt client-seitiger RGB-Skalierung (TesterPanel „brightness").
- **Player-LED-Fallback:** zusätzlich zum 47-Byte-Common einen Legacy-Output-Report `0x20`
  senden (alte Boards BDM-010/020 mit eigener LED-Logik); Implementierung: `setPlayerIndicator`
  schreibt beide, Fehler des Legacy-Reports nicht als Gesamtfehler werten.
- `setVibration` setzt flag0 bits 0+1 gemeinsam (Kernel-Semantik `COMPATIBLE_VIBRATION|HAPTICS_SELECT`).
- `setAdaptiveTrigger`: mode-abhängige Parametrik (resistance → [start, force], auto →
  [frequency, force, start], feedback/waveform/weapons-Modi analog daidr-Referenzmap), Clamping
  0–255 an allen Parametern; Frequenz-Slider wird verdrahtet.
- Touchpad-Koordinaten auf 1920×1080 normieren (touch-gesture.ts + Visualizer).
- BT-Feature-Reports: `sendFeatureReport`/`receiveFeatureReport` auf Transport prüfen; über BT
  Frame mit CRC32 (Seed 0x53) wrappen (analog zum Output-Frame, der bereits existiert).

### 3.2 Rust hid.rs

- Alle 7 Commands werden `async fn` + `spawn_blocking` (Projektregel).
- `hid_connect`/`hid_disconnect`: Teardown (Stop-Flag, Queue-Clear) **erst nach** erfolgreichem
  Open; alter Reader-Thread wird gejoined; `hid_poll`-Zustand konsistent.
- Reader-Thread: Read-Fehler-Schwelle (z. B. 3 konsekutive Fehler) + Backoff setzt
  `connected=false` → Unplug wird erkannt; `hid_poll` meldet es; kein 100 %-CPU-Spin.
- `hid_send_output_report`/`hid_send_feature_report`: Byte-Anzahl geprüft (`write()`-Ergebnis
  != erwartete Länge → Fehler) und dem Frontend als Feld (`bytes_written`) zurückgegeben;
  512-Byte-Guard beim Feature-Send.
- Command-Queue: `try_send` statt blockierendem `send` → „queue full" Fehler statt Deadlock;
  Commands laufen nicht mehr unter Mutex.
- `hid_connect` öffnet nach **Pfad** (aus `hid_list_devices`), mit Fallback auf VID/PID;
  PIDs 0x0ce6 / 0x0e5f (USB) und 0x0df2 (BT) bekannt.

### 3.3 Bluetooth

- Transport-Erkennung: nach Connect auf ersten Input-Report mit Timeout warten (statt fixer
  80 ms); Transport-Badge in der UI („USB" / „Bluetooth").
- Input-Reports über BT (0x31): CRC32-Validierung (Seed 0xA2) — ungültige Frames werden gezählt
  und nicht an Visualizer weitergereicht.
- **BT-Verbindungstest** (neuer Test im QuickTest-Modal): misst über Input-Reports Paketverlust
  (Sequenzlücken im seq-Nibble), Berichtsrate, Latenz/Jitter; Ergebnis im Test-Log/Export.
- Feature-Flows (Info/NVS/Kalibrierung/Speaker-Konfig) über BT → klarer Hinweis „nur über USB
  verfügbar" (deaktivierte Buttons + Tooltip), statt stummem `ok:false`.

### 3.4 Kalibrierung & QuickTest

- Range-Kalibrierung: busy wird auf dem Erfolgspfad resetet; „Fertig" erreichbar; Close/Cancel
  sendet `calibrateRangeEnd` (auch nach Center-Mode-Cancel sicherstellen, dass 0x82-Modus
  verlassen wird); Run-Token (Monoton steigende ID) bricht abgelaufene Chains ab.
- Feature-Report-Verkehr wird im `BaseController`/Manager serialisiert (Mutex/Queue), damit
  sich 0x80/0x81- und 0x82/0x83-Sequenzen nicht paaren.
- QuickTest: „Lights" loggt Completion nach Ende mit Verdict; Close mid-run erzeugt Verdict
  „abgebrochen", kein nachträgliches Überschreiben; Unmount/Close resettet alle Aktuatoren
  (Vibration, Trigger, Lights, Speaker).

### 3.5 Mock-Parität (src/lib/mock)

- `hid_send_output_report` parset den Report (Report-IDs, Flags, RGB, Player-LEDs, Trigger-Modi)
  und spiegelt ihn in den Mock-Zustand → Lightbar-Änderungen im Browser sichtbar (Mock-Controller-
  Visualizer), ungültige Writes sichtbar ablehnbar.
- `hid_send/receive_feature_report`: protokollgerechte Canned-Responses (0x20 Info-Layout,
  0x81/0x83 NVS/Kalibrier-Payloads) abhängig vom letzten 0x80/0x82-Command; Save/Discard-Flow
  funktionsfähig.
- BT-Simulation: Transport-Schalter (USB/BT) im Mock-Panel; BT-Modus sendet Report 0x31 mit
  gültiger CRC (Input) und erwartet CRC-Frame (Output/Feature) — Validierung wird getestet.
- Error-Injection für `hid_send_output_report` (konfigurierbar), damit Write-Fehlerpfade im
  Browser testbar sind.

### 3.6 UI-Aufwertung

- **Device-Picker** vor dem Connect: listet DualSense-Geräte (VID/PID-Filter 0x0ce6/0x0e5f/0x0df2)
  mit Pfad/Serial; Connect zielt auf den gewählten Pfad (Rust öffnet nach Pfad).
- **Verbindungs-Zeile:** Transport-Badge, Write-Fehlerzähler, `dropped_reports`-Anzeige, CRC-Fehlerzähler.
- **HID-Diagnose-Block** (zugeklappt, in Settings/Diagnose): offener Gerätepfad, Write-Statistik
  (gesendet/Bytes/Fehler), letzte Fehlermeldung — für Hardware-Fehlersuche im Reparatur-Kontext.
- Akku-Status 0xF → expliziter Fehlerzustand; `controllerInfo.ok` beim Connect geprüft.
- Store-Hygiene: tote Stores/API-Funktionen entfernen (controllerConnection, controllerNvStatus,
  controllerHasChanges, getSupportedQuickTests, setInputReportHandler/getInputHandler — nach
  Prüfung, ob wirklich unbenutzt); `stickDeadzone`-Slider ergänzen oder Store+Kommentar entfernen;
  Disconnect resettet **alle** Controller-Stores.
- i18n: harte deutsche Strings in den 5 Visualizer-Komponenten übersetzen, Swipe-Enum an der
  Grenze übersetzen, Log-Strings lokalisieren („Changes saved successfully", „error").

### 3.7 Tests

- Protokoll: flag2/lightbarSetup/ledBrightness-Packing, mode-spezifische Trigger-Params
  (alle Modi, Clamping), BT-CRC-Frames (Output + Feature), 0x20-Fallback, Touchpad-Range,
  setVibration-Flag-Kombination.
- Lifecycle: ControllerPanel connect/disconnect/poll/store-reset; CalibrationModal Range-Mode
  (busy-Fix, calibrateRangeEnd bei Cancel, Run-Token); QuickTestModal Lights-Verdict + Unmount-Reset.
- Mock: Output-Parsing-Spiegelung, Canned-Feature-Responses, BT-Transport-Modus, Error-Injection.
- Rust: Reader-Thread-Unplug-Verhalten (Unit-Test mit gefaktem Read-Fehler), Reconnect-Join.
  (`cargo test --workspace && npm run test` im Docker; Host hat kein Cargo/Node 18.)
- Lint: `make lint` (clippy `-D warnings`, eslint).

---

## 4. Reihenfolge der Implementierung

1. Protokoll-Layer + Tests (Kern-Fix Lichttest, kein UI-Abhängiger Code)
2. Rust hid.rs (async, Unplug, Write-Ergebnis, PIDs, Pfad-Open) + `hid_list_devices`-Picker
3. BT-Unterstützung + BT-Verbindungstest
4. Kalibrierung/QuickTest-Lifecycle-Fixes
5. Mock-Parität
6. UI-Aufwertung (Diagnose-Block, Statuszeile, Store-Hygiene, i18n)
7. Dev-Server-Deployment (testserver `start`, dev-diagnosetool.fixplay.de) für UI-Review;
   echte USB/BT-Validierung durch den Nutzer an seinem Linux-Rechner (`tauri dev`).

---

## 5. Risiken / Randbedingungen

- Ein echter DualSense steht nur beim Nutzer (Linux, USB) — Protokoll-Code wird gegen die vier
  verifizierten Quellen getestet (Unit-Tests pinnen Offsets/Flags/CRC); Hardware-Fehlersuche
  läuft über den Diagnose-Block.
- Kein `cargo fmt` (hand-aligned style, siehe Projektgedächtnis), aber `clippy -D warnings` ist CI-Pflicht.
- Der 0x20-Legacy-Fallback kann an der Hardware nicht verifiziert werden, wenn der Nutzer-Pad ein
  neues Board hat — Verhalten: Fehler des Legacy-Writes wird ignoriert (nicht fatal).
- `valid_flag2`-Lightbar-Setup: Verhalten „light-on = 0" ist aus dem Kernel abgeleitet
  (`LIGHT_OUT = BIT(1)`); Unit-Tests pinnen die Bytes, Hardware-Bestätigung durch den
  Connect-Baseline-Blitz beim Nutzer.