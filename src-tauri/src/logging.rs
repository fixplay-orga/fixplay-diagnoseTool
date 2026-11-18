//! Strukturiertes Logging für die Desktop-App.
//!
//! Die Konsole bleibt für Entwickler lesbar (Text), die Logdatei im
//! Release-Build ist **eine JSON-Zeile pro Ereignis** mit demselben
//! Feld-Schema wie Backend/BFF/Admin:
//!
//! ```json
//! {"ts":"2026-11-18T10:12:33.412Z","level":"error","msg":"uart connect failed",
//!  "service":"diagnose-tool","env":"release","session_id":"…",
//!  "target":"fixplay_tauri","err":"…"}
//! ```
//!
//! Rotation: `tracing-appender::rolling::daily` legt eine Datei pro Tag an.
//! Zusätzlich löscht [`prune_old_logs`] beim Start Dateien, die älter als
//! [`RETENTION_DAYS`] sind — `tracing-appender` selbst räumt nichts auf, sonst
//! wüchse das Benutzerprofil unbegrenzt.

use std::fmt;
use std::io;
use std::path::{Path, PathBuf};
#[cfg(test)]
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use tracing::{Event, Subscriber};
use tracing_subscriber::field::Visit;
use tracing_subscriber::fmt as tfmt;
use tracing_subscriber::fmt::format::Writer;
use tracing_subscriber::fmt::{FmtContext, FormatEvent, FormatFields};
use tracing_subscriber::prelude::*;
use tracing_subscriber::registry::LookupSpan;
use tracing_subscriber::EnvFilter;

/// Fester `service`-Wert im gemeinsamen Log-Schema.
pub const SERVICE: &str = "diagnose-tool";

/// Logdateien älter als diese Zahl an Tagen werden beim Start gelöscht.
pub const RETENTION_DAYS: u64 = 14;

/// Präfix der täglichen Dateien (`fixplay.log.YYYY-MM-DD`).
pub const LOG_FILE_PREFIX: &str = "fixplay.log";

/// Initialisiert den Prozess-Logger: Konsole immer, Datei nur im Release-Build.
pub fn init() {
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into());

    #[cfg(debug_assertions)]
    {
        // Dev: nur Konsole — keine Logdateien im Arbeitsverzeichnis.
        tfmt().with_env_filter(filter).init();
    }

    #[cfg(not(debug_assertions))]
    {
        init_release(filter);
    }
}

// Auch im Debug-Build kompiliert (nur nicht aufgerufen), damit `cargo check`
// und clippy den Release-Pfad in jeder Konfiguration prüfen.
#[allow(dead_code)]
fn init_release(filter: EnvFilter) {
    let console_layer = tfmt::layer();

    let Some(log_dir) = dirs::data_local_dir().map(|d| d.join("fixplay-diagnoseTool").join("logs"))
    else {
        tracing_subscriber::registry()
            .with(filter)
            .with(console_layer)
            .init();
        return;
    };
    if std::fs::create_dir_all(&log_dir).is_err() {
        tracing_subscriber::registry()
            .with(filter)
            .with(console_layer)
            .init();
        return;
    }

    // Aufbewahrungsregel VOR dem Öffnen der neuen Datei: alte Tagesdateien
    // verschwinden, bevor die neue angelegt wird.
    match prune_old_logs(&log_dir, retention(), SystemTime::now()) {
        Ok(removed) if !removed.is_empty() => {
            // Erst nach dem Subscriber-Aufbau loggen; siehe unten.
            let count = removed.len();
            let appender = tracing_appender::rolling::daily(&log_dir, LOG_FILE_PREFIX);
            let file_layer = json_file_layer(appender);
            tracing_subscriber::registry()
                .with(filter)
                .with(console_layer)
                .with(file_layer)
                .init();
            tracing::info!(
                removed = count,
                retention_days = RETENTION_DAYS,
                "old log files pruned"
            );
            tracing::info!(path = %log_dir.display(), "file logging enabled");
            return;
        }
        Ok(_) => {}
        Err(e) => {
            // Retention-Fehler dürfen den Start nie verhindern.
            eprintln!("log retention failed: {e}");
        }
    }

    let appender = tracing_appender::rolling::daily(&log_dir, LOG_FILE_PREFIX);
    let file_layer = json_file_layer(appender);
    tracing_subscriber::registry()
        .with(filter)
        .with(console_layer)
        .with(file_layer)
        .init();

    tracing::info!(path = %log_dir.display(), "file logging enabled");
}

fn json_file_layer<S>(
    appender: tracing_appender::rolling::RollingFileAppender,
) -> impl tracing_subscriber::Layer<S>
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    tfmt::layer()
        .with_ansi(false)
        .with_writer(appender)
        .event_format(JsonFormat::new(SERVICE, env_name(), session_id()))
}

/// Aufbewahrungsdauer als [`Duration`].
pub fn retention() -> Duration {
    Duration::from_secs(RETENTION_DAYS * 24 * 60 * 60)
}

/// Löscht `fixplay.log*`-Dateien, die älter als `retention` sind.
///
/// Gibt die gelöschten Pfade zurück. Fehler beim Lesen einzelner Einträge
/// werden übersprungen — Aufräumen ist Best-Effort und darf nie den Start
/// verhindern.
pub fn prune_old_logs(
    dir: &Path,
    retention: Duration,
    now: SystemTime,
) -> io::Result<Vec<PathBuf>> {
    let mut removed = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(removed),
        Err(e) => return Err(e),
    };

    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.starts_with(LOG_FILE_PREFIX) {
            continue;
        }
        let Ok(metadata) = entry.metadata() else {
            continue;
        };
        if !metadata.is_file() {
            continue;
        }
        let Ok(modified) = metadata.modified() else {
            continue;
        };
        let is_old = now
            .duration_since(modified)
            .map(|age| age > retention)
            .unwrap_or(false);
        if is_old && std::fs::remove_file(&path).is_ok() {
            removed.push(path);
        }
    }
    Ok(removed)
}

/// Kurze, pro App-Start stabile Kennung (kein Request-Konzept auf dem Desktop).
#[allow(dead_code)] // nur im Release- und Test-Build aufgerufen
pub fn session_id() -> String {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    format!("{:x}-{:x}", millis, std::process::id())
}

#[allow(dead_code)] // nur im Release-Build aufgerufen
pub fn env_name() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}

/// Schreibt ein [`tracing`]-Event als eine JSON-Zeile im gemeinsamen Schema.
#[derive(Clone)]
pub struct JsonFormat {
    service: &'static str,
    env: &'static str,
    session_id: String,
}

impl JsonFormat {
    pub fn new(service: &'static str, env: &'static str, session_id: String) -> Self {
        Self {
            service,
            env,
            session_id,
        }
    }
}

impl<S, N> FormatEvent<S, N> for JsonFormat
where
    S: Subscriber + for<'a> LookupSpan<'a>,
    N: for<'a> FormatFields<'a> + 'static,
{
    fn format_event(
        &self,
        _ctx: &FmtContext<'_, S, N>,
        mut writer: Writer<'_>,
        event: &Event<'_>,
    ) -> fmt::Result {
        let meta = event.metadata();
        let mut map = Map::new();
        map.insert("ts".into(), json!(timestamp()));
        map.insert("level".into(), json!(level_name(*meta.level())));
        map.insert("service".into(), json!(self.service));
        map.insert("env".into(), json!(self.env));
        map.insert("session_id".into(), json!(self.session_id));
        map.insert("target".into(), json!(meta.target()));

        let mut visitor = JsonVisitor { map: &mut map };
        event.record(&mut visitor);

        // tracing legt die Nachricht unter `message` ab; das Schema nennt sie `msg`.
        if let Some(msg) = map.remove("message") {
            map.insert("msg".into(), msg);
        }

        writeln!(writer, "{}", Value::Object(map))
    }
}

struct JsonVisitor<'a> {
    map: &'a mut Map<String, Value>,
}

impl JsonVisitor<'_> {
    fn insert(&mut self, field: &tracing::field::Field, value: Value) {
        let key = match field.name() {
            "message" => "message",
            other => other,
        };
        self.map.insert(key.to_string(), value);
    }
}

impl Visit for JsonVisitor<'_> {
    fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
        self.insert(field, json!(sanitize(value)));
    }

    fn record_i64(&mut self, field: &tracing::field::Field, value: i64) {
        self.insert(field, json!(value));
    }

    fn record_u64(&mut self, field: &tracing::field::Field, value: u64) {
        self.insert(field, json!(value));
    }

    fn record_bool(&mut self, field: &tracing::field::Field, value: bool) {
        self.insert(field, json!(value));
    }

    fn record_f64(&mut self, field: &tracing::field::Field, value: f64) {
        self.insert(field, json!(value));
    }

    fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn fmt::Debug) {
        self.insert(field, json!(sanitize(&format!("{value:?}"))));
    }
}

fn level_name(level: tracing::Level) -> &'static str {
    match level {
        tracing::Level::ERROR => "error",
        tracing::Level::WARN => "warn",
        tracing::Level::INFO => "info",
        tracing::Level::DEBUG => "debug",
        tracing::Level::TRACE => "trace",
    }
}

/// Eine JSON-Zeile bleibt eine Zeile: Zeilenumbrüche ersetzen, Länge deckeln.
fn sanitize(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '\r' | '\n' | '\t' => out.push(' '),
            c => out.push(c),
        }
    }
    let out = out.trim();
    if out.chars().count() > 500 {
        let mut truncated: String = out.chars().take(500).collect();
        truncated.push('…');
        truncated
    } else {
        out.to_string()
    }
}

/// RFC3339 in UTC mit Millisekunden (Fallback: Unix-Sekunden).
fn timestamp() -> String {
    use time::format_description::well_known::Rfc3339;
    match time::OffsetDateTime::now_utc().format(&Rfc3339) {
        Ok(ts) => ts,
        Err(_) => SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs().to_string())
            .unwrap_or_else(|_| "0".into()),
    }
}

/// Nur für Tests: sammelt geschriebene Bytes in einem Puffer.
#[cfg(test)]
#[derive(Clone)]
struct TestBuffer(Arc<Mutex<Vec<u8>>>);

#[cfg(test)]
impl io::Write for TestBuffer {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writes_one_json_line_with_the_shared_schema() {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let writer = buffer.clone();
        let subscriber = tfmt::Subscriber::builder()
            .with_env_filter("info")
            .with_writer(move || TestBuffer(writer.clone()))
            .event_format(JsonFormat::new(SERVICE, "test", "sess-1".into()))
            .finish();

        tracing::subscriber::with_default(subscriber, || {
            tracing::error!(err = "verbindung verloren", "uart connect failed");
        });

        let raw = String::from_utf8(buffer.lock().unwrap().clone()).unwrap();
        let line = raw.lines().next().expect("eine Zeile");
        let value: Value = serde_json::from_str(line).expect("JSON-Zeile");

        assert_eq!(value["level"], "error");
        assert_eq!(value["msg"], "uart connect failed");
        assert_eq!(value["service"], SERVICE);
        assert_eq!(value["env"], "test");
        assert_eq!(value["session_id"], "sess-1");
        assert_eq!(value["err"], "verbindung verloren");
        assert!(value["ts"].as_str().unwrap().contains('T'));
    }

    #[test]
    fn prunes_log_files_older_than_the_retention() {
        let dir = std::env::temp_dir().join(format!(
            "fixplay-log-retention-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        std::fs::create_dir_all(&dir).unwrap();

        let old = dir.join("fixplay.log.2026-01-01");
        let fresh = dir.join("fixplay.log.2026-11-18");
        let other = dir.join("unrelated.txt");
        std::fs::write(&old, "old").unwrap();
        std::fs::write(&fresh, "fresh").unwrap();
        std::fs::write(&other, "keep").unwrap();

        let now = SystemTime::now();
        let handle = std::fs::File::options().write(true).open(&old).unwrap();
        handle
            .set_times(
                std::fs::FileTimes::new()
                    .set_modified(now - Duration::from_secs(15 * 24 * 60 * 60)),
            )
            .unwrap();

        let removed = prune_old_logs(&dir, retention(), now).unwrap();

        assert_eq!(removed, vec![old.clone()]);
        assert!(!old.exists(), "alte Datei muss gelöscht sein");
        assert!(fresh.exists(), "junge Datei bleibt");
        assert!(other.exists(), "fremde Dateien werden nicht angefasst");

        std::fs::remove_dir_all(&dir).ok();
    }
}
