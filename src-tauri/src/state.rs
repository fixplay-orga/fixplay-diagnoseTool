use crate::commands::hid::{HidCmd, HidReport};
use fixplay_core::types::ErrlogEntry;
use fixplay_i2c::{I2cBridge, XboxErrorDb};
use fixplay_uart::{ErrorDb, UartPort};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicU64};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;

/// A parsed errlog entry buffered for the frontend to drain via uart_poll.
#[derive(Clone)]
pub struct PendingEntry {
    pub entry:       ErrlogEntry,
    pub description: Option<String>,
}

pub struct AppState {
    pub uart:               Mutex<Option<UartPort>>,
    pub uart_stop:          Mutex<Option<Arc<AtomicBool>>>,
    pub uart_thread:        Mutex<Option<JoinHandle<()>>>,
    pub uart_poll_stop:     Mutex<Option<Arc<AtomicBool>>>,
    pub uart_poll_thread:   Mutex<Option<JoinHandle<()>>>,
    pub error_db:           Arc<Mutex<Option<ErrorDb>>>,
    pub auto_reconnect:     Arc<AtomicBool>,
    pub reconnect_port:     Mutex<Option<String>>,
    /// VID/PID of the connected USB-serial cable, so auto-reconnect can survive
    /// a re-plug that changes the OS-assigned port name. Resolved at connect
    /// time from the port name via `serialport::available_ports()`.
    pub reconnect_vid:      Mutex<Option<u16>>,
    pub reconnect_pid:      Mutex<Option<u16>>,
    pub reconnect_stop:     Mutex<Option<Arc<AtomicBool>>>,
    pub reconnect_thread:   Mutex<Option<JoinHandle<()>>>,
    /// Raw lines received by the reader loop — drained by uart_poll.
    pub raw_lines:          Arc<Mutex<VecDeque<String>>>,
    /// Lines dropped at the `raw_lines`/`pending_entries` cap (overflow). Drained
    /// by `uart_poll` so the UI can surface "N Zeilen verworfen" instead of
    /// silently losing output.
    pub dropped_lines:      Arc<AtomicU64>,
    /// Parsed errlog entries — drained by uart_poll.
    pub pending_entries:    Arc<Mutex<VecDeque<PendingEntry>>>,
    /// Set by reader_loop when LOOPBACK:PING is received; cleared by loopback command.
    pub loopback_triggered: Arc<AtomicBool>,
    /// Commands recently written to the port. The PS5 UART mirrors received
    /// characters back; the reader drops lines matching one of these echoes.
    pub recent_sent:        Arc<Mutex<VecDeque<String>>>,
    /// HID connection state (reader thread + channel + write statistics).
    pub hid:                Arc<HidShared>,
    /// I2C-over-USB-CDC bridge (Raspberry Pi Pico running fixplay-pico-i2c).
    /// Sync request/response — no reader thread, no shared buffers.
    pub i2c:                Mutex<Option<I2cBridge>>,
    /// Xbox error-code database (cache → bundled resource → background fetch).
    pub xbox_error_db:      Arc<Mutex<Option<XboxErrorDb>>>,
}

/// Shared HID connection state — reader thread, command channel, counters.
/// Held as one Arc so async commands can clone it into spawn_blocking
/// closures without borrowing `State<'_>`.
pub struct HidShared {
    /// Command channel to the HID reader thread.
    pub cmd_tx:           Arc<Mutex<Option<mpsc::SyncSender<HidCmd>>>>,
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
    /// Serializes hid_connect against hid_disconnect and itself — both
    /// spawn_blocking closures take this as their first lock; the reader
    /// thread and the read-only hid_poll/hid_diagnostics never do.
    pub op_lock:          Mutex<()>,
}

impl Default for HidShared {
    fn default() -> Self {
        Self {
            cmd_tx:           Arc::new(Mutex::new(None)),
            stop:             Mutex::new(None),
            alive:            Mutex::new(None),
            thread:           Mutex::new(None),
            reports:          Mutex::new(VecDeque::with_capacity(512)),
            dropped_reports:  AtomicU64::new(0),
            write_count:      AtomicU64::new(0),
            write_errors:     AtomicU64::new(0),
            last_write_error: Mutex::new(None),
            open_path:        Mutex::new(None),
            op_lock:          Mutex::new(()),
        }
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            uart:               Mutex::new(None),
            uart_stop:          Mutex::new(None),
            uart_thread:        Mutex::new(None),
            uart_poll_stop:     Mutex::new(None),
            uart_poll_thread:   Mutex::new(None),
            error_db:           Arc::new(Mutex::new(None)),
            auto_reconnect:     Arc::new(AtomicBool::new(false)),
            reconnect_port:     Mutex::new(None),
            reconnect_vid:      Mutex::new(None),
            reconnect_pid:      Mutex::new(None),
            reconnect_stop:     Mutex::new(None),
            reconnect_thread:   Mutex::new(None),
            raw_lines:          Arc::new(Mutex::new(VecDeque::with_capacity(500))),
            dropped_lines:      Arc::new(AtomicU64::new(0)),
            pending_entries:    Arc::new(Mutex::new(VecDeque::with_capacity(200))),
            loopback_triggered: Arc::new(AtomicBool::new(false)),
            recent_sent:        Arc::new(Mutex::new(VecDeque::with_capacity(20))),
            hid:                Arc::new(HidShared::default()),
            i2c:                Mutex::new(None),
            xbox_error_db:      Arc::new(Mutex::new(None)),
        }
    }
}
