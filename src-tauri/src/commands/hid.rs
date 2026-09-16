use crate::state::{AppState, HidShared};
use hidapi::HidApi;
use serde::Serialize;
use std::collections::VecDeque;
use std::ffi::CString;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use tauri::State;
use tracing::info;

#[derive(Serialize, Clone)]
pub struct HidDeviceInfo {
    pub vendor_id:     u16,
    pub product_id:    u16,
    pub manufacturer:  Option<String>,
    pub product:       Option<String>,
    pub serial_number: Option<String>,
    pub usage_page:    u16,
    pub usage:         u16,
    /// OS-level device path (e.g. `/dev/hidraw4`) from the hidapi device list —
    /// lets the frontend open a *specific* device when several match a VID/PID.
    pub path:          String,
}

#[derive(Serialize, Clone)]
pub struct HidReport {
    pub report_id: u8,
    pub data:      Vec<u8>,
}

#[derive(Serialize)]
pub struct HidPollResult {
    pub connected:        bool,
    pub reports:          Vec<HidReport>,
    pub dropped_reports:  u64,
}

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
/// (unit-testable, German user-facing message). A write is only rejected when
/// fewer bytes than expected were reported. hidapi's Windows backend PADS any
/// write shorter than the device's `OutputReportByteLength` up to that length
/// and returns the padded count (`windows/hid.c`, `hid_write`), so a
/// DualSense output write of 48 bytes returns 63 on Windows while Linux
/// hidraw returns the exact 48 — `written >= expected` accepts both.
fn check_write_result(written: usize, expected: usize) -> Result<usize, String> {
    if written >= expected {
        Ok(written)
    } else {
        Err(format!("HID-Write unvollständig: nur {written} von {expected} Bytes geschrieben"))
    }
}

/// Maximum input reports buffered for `hid_poll` before the oldest are dropped
/// (counted in `dropped_reports`). Bounded so a flood can't grow the queue
/// without limit.
const MAX_REPORT_QUEUE: usize = 512;

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

/// Build a feature-report *send* packet: the report-id byte prepended to the
/// payload (hidapi expects the id in byte 0). Extracted from `run_hid_thread`
/// so the framing is unit-testable without a real device.
fn feature_report_packet(report_id: u8, data: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(data.len() + 1);
    packet.push(report_id);
    packet.extend_from_slice(data);
    packet
}

/// Allocate a feature-report *read* buffer of `(len + 1).max(128)` bytes with
/// the report-id byte set at offset 0 (hidapi writes the id there and returns
/// the full buffer). Extracted for unit testing.
fn make_get_feature_buf(report_id: u8, len: usize) -> Vec<u8> {
    let cap = (len + 1).max(128);
    let mut buf = vec![0u8; cap];
    buf[0] = report_id;
    buf
}

/// Parse a `read_timeout` result into an input report, stripping the leading
/// report-id byte (mirrors WebHID, where the id is reported separately). Returns
/// `None` for empty / single-byte reads (no payload).
fn parse_input_report(buf: &[u8], n: usize) -> Option<HidReport> {
    if n <= 1 {
        return None;
    }
    Some(HidReport {
        report_id: buf[0],
        data:      buf[1..n].to_vec(),
    })
}

/// Push a report onto the bounded queue, or bump the drop counter when the
/// queue is full. Extracted so the bound + drop invariant is unit-testable.
fn push_report(q: &mut VecDeque<HidReport>, dropped: &AtomicU64, report: HidReport) {
    if q.len() < MAX_REPORT_QUEUE {
        q.push_back(report);
    } else {
        dropped.fetch_add(1, Ordering::Relaxed);
    }
}

/// RAII guard that flips the `hid_alive` flag to false when the reader thread
/// exits — on *any* path (Stop command, channel disconnect, panic unwind, or
/// loop end). This is what lets `hid_poll` report a dead connection instead of
/// stalling silently on a `Some` cmd channel whose thread is gone.
struct AliveGuard {
    alive: Arc<AtomicBool>,
}

impl Drop for AliveGuard {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Relaxed);
        info!("HID reader thread alive=false (exit)");
    }
}

fn run_hid_thread(
    device:  hidapi::HidDevice,
    cmd_rx:  mpsc::Receiver<HidCmd>,
    shared:  Arc<HidShared>,
    stop:    Arc<AtomicBool>,
    alive:   Arc<AtomicBool>,
) {
    // Drops on return / unwind / channel close → marks the thread dead.
    let _guard = AliveGuard { alive: Arc::clone(&alive) };
    alive.store(true, Ordering::Relaxed);
    let mut buf = [0u8; 128];
    info!("HID reader thread started");

    // Consecutive read errors — reset on every successful read, drives unplug
    // detection (threshold) + backoff between retries.
    let mut read_errors = 0u32;

    while !stop.load(Ordering::Relaxed) {
        // Drain all pending commands before doing a read
        loop {
            match cmd_rx.try_recv() {
                Ok(HidCmd::Stop) => return,
                Ok(HidCmd::SendFeatureReport(report_id, data, reply)) => {
                    let packet = feature_report_packet(report_id, &data);
                    let r = device
                        .send_feature_report(&packet)
                        .map(|_| ())
                        .map_err(|e| e.to_string());
                    reply.send(r).ok();
                }
                Ok(HidCmd::GetFeatureReport(report_id, len, reply)) => {
                    let mut rbuf = make_get_feature_buf(report_id, len);
                    let r = device
                        .get_feature_report(&mut rbuf)
                        .map(|n| rbuf[..n].to_vec())
                        .map_err(|e| e.to_string());
                    reply.send(r).ok();
                }
                Ok(HidCmd::WriteOutput(data, reply)) => {
                    let expected = data.len();
                    let r = match device.write(&data) {
                        Ok(n) => check_write_result(n, expected),
                        Err(e) => Err(e.to_string()),
                    };
                    match &r {
                        Ok(_) => {
                            shared.write_count.fetch_add(1, Ordering::Relaxed);
                        }
                        Err(e) => {
                            shared.write_errors.fetch_add(1, Ordering::Relaxed);
                            *shared.last_write_error.lock().unwrap() = Some(e.clone());
                        }
                    }
                    reply.send(r).ok();
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => return,
            }
        }

        // Read one input report — 5 ms timeout keeps the command loop responsive.
        // Consecutive read errors are tolerated with a short backoff until the
        // threshold declares the device gone (unplug detection).
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

    info!("HID reader thread stopped");
}

// ── helper: send a command and wait for the reply ───────────────────────────

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

// ── Tauri commands ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn hid_list_devices() -> Result<Vec<HidDeviceInfo>, String> {
    let api  = HidApi::new().map_err(|e| e.to_string())?;
    let list = api
        .device_list()
        .map(|d| HidDeviceInfo {
            vendor_id:     d.vendor_id(),
            product_id:    d.product_id(),
            manufacturer:  d.manufacturer_string().map(str::to_string),
            product:       d.product_string().map(str::to_string),
            serial_number: d.serial_number().map(str::to_string),
            usage_page:    d.usage_page(),
            usage:         d.usage(),
            // `path()` is `&CStr` in hidapi 2.x — lossy conversion is safe here
            // (paths are ASCII device nodes; a non-UTF8 byte just becomes U+FFFD).
            path:          d.path().to_string_lossy().into_owned(),
        })
        .collect();
    Ok(list)
}

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

#[tauri::command]
pub async fn hid_connect(
    vendor_id: u16,
    product_id: u16,
    path: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let hid = Arc::clone(&state.hid);
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    // HidApi::new() + open() blockieren — nicht auf dem Async-Runner laufen lassen.
    tokio::task::spawn_blocking(move || {
        // 1. Open FIRST — a failed open must not destroy a working connection.
        let api = HidApi::new().map_err(|e| e.to_string())?;
        // Path-based open (path from hid_list_devices) with VID/PID fallback —
        // the path can vanish between listing and open (device replugged, other
        // panel claimed it). hidapi 2.x's open_path takes a `&CStr`.
        let device = match &path {
            Some(p) => {
                let cpath = CString::new(p.as_str())
                    .map_err(|_| "Ungültiger HID-Gerätepfad".to_string())?;
                api.open_path(&cpath)
                    .or_else(|_| api.open(vendor_id, product_id))
                    .map_err(|e| e.to_string())?
            }
            None => api.open(vendor_id, product_id).map_err(|e| e.to_string())?,
        };
        // Only after a successful open: record which path is now held
        // (HidDiagnostics reports it; a failed open keeps the previous value).
        *hid.open_path.lock().unwrap() = path.clone();
        // 2. Only now tear down the previous reader thread (and join it).
        teardown_hid(&hid);
        let (cmd_tx, cmd_rx) = mpsc::sync_channel::<HidCmd>(32);
        let stop       = Arc::new(AtomicBool::new(false));
        let stop_clone = Arc::clone(&stop);
        let alive      = Arc::new(AtomicBool::new(true));
        let alive_clone = Arc::clone(&alive);
        hid.reports.lock().unwrap().clear();
        hid.dropped_reports.store(0, Ordering::Relaxed);
        *hid.last_write_error.lock().unwrap() = None;
        hid.write_count.store(0, Ordering::Relaxed);
        hid.write_errors.store(0, Ordering::Relaxed);
        *hid.cmd_tx.lock().unwrap() = Some(cmd_tx);
        *hid.stop.lock().unwrap()   = Some(stop);
        *hid.alive.lock().unwrap()  = Some(alive);
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

#[tauri::command]
pub async fn hid_disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let hid = Arc::clone(&state.hid);
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    tokio::task::spawn_blocking(move || {
        teardown_hid(&hid);
        hid.reports.lock().unwrap().clear();
        // Nothing is open anymore — HidDiagnostics must not report a stale path.
        *hid.open_path.lock().unwrap() = None;
        info!("HID disconnected");
        Ok(())
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}

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
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    tokio::task::spawn_blocking(move || {
        send_cmd!(hid.cmd_tx, |reply| HidCmd::SendFeatureReport(report_id, data, reply))
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}

#[tauri::command]
pub async fn hid_receive_feature_report(
    report_id: u8,
    length: usize,
    state: State<'_, AppState>,
) -> Result<Vec<u8>, String> {
    if length > 512 {
        return Err(format!("Feature-Report-Länge {} überschreitet Maximum 512", length));
    }
    let hid = Arc::clone(&state.hid);
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    tokio::task::spawn_blocking(move || {
        send_cmd!(hid.cmd_tx, |reply| HidCmd::GetFeatureReport(report_id, length, reply))
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}

#[tauri::command]
pub async fn hid_send_output_report(
    data: Vec<u8>,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let hid = Arc::clone(&state.hid);
    // Arc-Clone statt State-Borrow: spawn_blocking braucht 'static.
    tokio::task::spawn_blocking(move || {
        send_cmd!(hid.cmd_tx, |reply| HidCmd::WriteOutput(data, reply))
    })
    .await
    .map_err(|e| format!("HID-Aufgabe fehlgeschlagen: {e}"))?
}

#[tauri::command]
pub fn hid_poll(state: State<'_, AppState>) -> HidPollResult {
    // A connection is only "connected" if the reader thread is still alive AND
    // the command channel is still installed. If the thread died (device
    // unplugged / panicked) the alive flag flips false via the AliveGuard —
    // tear down the stale cmd channel so the frontend's next poll sees
    // connected=false and disconnects instead of stalling on a dead handle.
    let alive = state
        .hid
        .alive
        .lock()
        .unwrap()
        .as_ref()
        .map(|a| a.load(Ordering::Relaxed))
        .unwrap_or(false);
    let mut cmd = state.hid.cmd_tx.lock().unwrap();
    if !alive && cmd.is_some() {
        let _ = cmd.take();
    }
    let connected = alive && cmd.is_some();
    drop(cmd);

    let reports: Vec<HidReport> = state.hid.reports.lock().unwrap().drain(..).collect();
    let dropped_reports = state.hid.dropped_reports.swap(0, Ordering::Relaxed);
    HidPollResult { connected, reports, dropped_reports }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn feature_report_packet_prepends_report_id() {
        let pkt = feature_report_packet(0x05, &[0xaa, 0xbb, 0xcc]);
        assert_eq!(pkt, vec![0x05, 0xaa, 0xbb, 0xcc]);
    }

    #[test]
    fn feature_report_packet_empty_payload_is_just_the_id() {
        assert_eq!(feature_report_packet(0x80, &[]), vec![0x80]);
    }

    #[test]
    fn make_get_feature_buf_floors_to_128_and_sets_id_byte() {
        let buf = make_get_feature_buf(0x20, 10);
        assert_eq!(buf.len(), 128); // (10 + 1).max(128) = 128
        assert_eq!(buf[0], 0x20);
        // zeros after the id byte
        assert!(buf[1..].iter().all(|&b| b == 0));
    }

    #[test]
    fn make_get_feature_buf_grows_past_128_for_large_len() {
        let buf = make_get_feature_buf(0x83, 200);
        assert_eq!(buf.len(), 201); // 200 + 1
        assert_eq!(buf[0], 0x83);
    }

    #[test]
    fn parse_input_report_strips_leading_report_id_byte() {
        let buf = [0x01u8, 0xde, 0xad, 0xbe, 0xef];
        let r = parse_input_report(&buf, 5).unwrap();
        assert_eq!(r.report_id, 0x01);
        assert_eq!(r.data, vec![0xde, 0xad, 0xbe, 0xef]);
    }

    #[test]
    fn parse_input_report_returns_none_for_empty_or_id_only_read() {
        let buf = [0x01u8, 0x02, 0x03];
        assert!(parse_input_report(&buf, 0).is_none());
        assert!(parse_input_report(&buf, 1).is_none()); // only the report-id byte
    }

    #[test]
    fn push_report_appends_under_cap() {
        let mut q = VecDeque::new();
        let dropped = AtomicU64::new(0);
        push_report(&mut q, &dropped, HidReport { report_id: 1, data: vec![1] });
        push_report(&mut q, &dropped, HidReport { report_id: 2, data: vec![2] });
        assert_eq!(q.len(), 2);
        assert_eq!(dropped.load(Ordering::Relaxed), 0);
    }

    #[test]
    fn push_report_drops_and_counts_when_queue_is_full() {
        let mut q = VecDeque::new();
        for _ in 0..MAX_REPORT_QUEUE {
            q.push_back(HidReport { report_id: 0, data: vec![] });
        }
        let dropped = AtomicU64::new(0);
        // Queue is full: each further report is dropped + counted.
        push_report(&mut q, &dropped, HidReport { report_id: 9, data: vec![9] });
        push_report(&mut q, &dropped, HidReport { report_id: 9, data: vec![9] });
        assert_eq!(q.len(), MAX_REPORT_QUEUE); // cap held
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
    }

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

    #[test]
    fn write_output_check_windows_padded_write_is_ok() {
        // hidapi's Windows hid_write pads the 48-byte DualSense output report
        // up to OutputReportByteLength (63) and returns the padded count —
        // an over-long result must not reject the write (final-review C2).
        assert_eq!(check_write_result(63, 48), Ok(63));
    }

    #[test]
    fn alive_guard_flips_alive_false_on_drop() {
        let alive = Arc::new(AtomicBool::new(true));
        {
            let _guard = AliveGuard { alive: Arc::clone(&alive) };
            assert!(alive.load(Ordering::Relaxed)); // still alive while held
        }
        assert!(!alive.load(Ordering::Relaxed)); // false after drop
    }

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
}
