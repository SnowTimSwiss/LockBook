use std::path::PathBuf;
use std::process::Command;
use std::sync::OnceLock;

use crate::error::{JournalError, Result};

// ─── Binary discovery ─────────────────────────────────────────────────────────

/// Cached path to the timenc binary (resolved once at first use).
static TIMENC_PATH: OnceLock<Option<PathBuf>> = OnceLock::new();

/// Find the timenc binary.
///
/// Search order:
/// 1. `timenc` / `timenc.exe` on the current `PATH`
/// 2. `TIMENC_PATH` environment variable (user can override)
/// 3. Common Windows installation directories
/// 4. Common Unix installation directories
fn find_timenc() -> Option<PathBuf> {
    // 1. Try plain PATH lookup first
    if probe_binary("timenc") {
        return Some(PathBuf::from("timenc"));
    }

    // 2. Explicit env-var override
    if let Ok(p) = std::env::var("TIMENC_PATH") {
        let pb = PathBuf::from(&p);
        if pb.is_file() {
            return Some(pb);
        }
    }

    // 3. Manually scan all directories that are on the *system* PATH
    //    (Tauri on Windows may inherit a stripped PATH; re-read it from the registry)
    #[cfg(target_os = "windows")]
    if let Some(p) = search_windows_path() {
        return Some(p);
    }

    // 4. Well-known install locations
    for candidate in well_known_paths() {
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

/// Run `timenc --version` (and also `-V` / bare) to verify the binary actually works.
fn probe_binary(name: &str) -> bool {
    // Try both --version and -V; accept any output as long as the process spawns
    for flag in &["--version", "-V", "version"] {
        if let Ok(out) = no_window_cmd(name).arg(flag).output() {
            // Consider it found if the process exited (exit code 0 or even non-zero
            // is fine — what matters is that the binary exists and runs).
            let _ = out;
            return true;
        }
    }
    false
}

#[cfg(target_os = "windows")]
fn search_windows_path() -> Option<PathBuf> {
    // Read the combined (User + System) PATH from the registry
    let paths = read_registry_path();
    let extra: Vec<PathBuf> = paths
        .split(';')
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .collect();

    for dir in extra {
        let candidate = dir.join("timenc.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        let candidate = dir.join("timenc");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn read_registry_path() -> String {
    // Try to read PATH from both HKCU and HKLM via `reg query`
    let mut result = String::new();
    for (hive, key) in [
        ("HKCU", r"Environment"),
        ("HKLM", r"SYSTEM\CurrentControlSet\Control\Session Manager\Environment"),
    ] {
        if let Ok(out) = Command::new("reg")
            .args(["query", &format!("{}\\{}", hive, key), "/v", "Path"])
            .output()
        {
            let text = String::from_utf8_lossy(&out.stdout).to_string();
            for line in text.lines() {
                if line.trim_start().to_uppercase().starts_with("PATH") {
                    // line looks like: "    Path    REG_EXPAND_SZ    C:\foo;..."
                    if let Some(val) = line.splitn(4, "    ").last() {
                        result.push(';');
                        result.push_str(val.trim());
                    }
                }
            }
        }
    }
    result
}

fn well_known_paths() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "windows")]
    {
        let ext = "timenc.exe";
        // WinGet packages (per-user)
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            let base = PathBuf::from(&local);
            // WinGet: Microsoft\WinGet\Packages\*\timenc.exe
            let winget = base.join("Microsoft").join("WinGet").join("Packages");
            if let Ok(entries) = std::fs::read_dir(&winget) {
                for entry in entries.flatten() {
                    candidates.push(entry.path().join(ext));
                }
            }
            candidates.push(base.join("Programs").join("timenc").join(ext));
            candidates.push(base.join("timenc").join(ext));
        }
        // Scoop
        if let Ok(home) = std::env::var("USERPROFILE") {
            let scoop = PathBuf::from(&home).join("scoop").join("shims").join(ext);
            candidates.push(scoop);
        }
        // System-wide
        for root in ["C:\\Program Files", "C:\\Program Files (x86)"] {
            candidates.push(PathBuf::from(root).join("timenc").join(ext));
            candidates.push(PathBuf::from(root).join("TimENC").join(ext));
        }
        // Cargo bin (Rust install via `cargo install`)
        if let Ok(home) = std::env::var("USERPROFILE") {
            candidates.push(PathBuf::from(&home).join(".cargo").join("bin").join(ext));
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        let ext = "timenc";
        for dir in ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin", "/home/linuxbrew/.linuxbrew/bin"] {
            candidates.push(PathBuf::from(dir).join(ext));
        }
        if let Ok(home) = std::env::var("HOME") {
            candidates.push(PathBuf::from(&home).join(".cargo").join("bin").join(ext));
            candidates.push(PathBuf::from(&home).join(".local").join("bin").join(ext));
        }
    }

    candidates
}

/// Get (or lazily resolve) the timenc binary path.
pub fn timenc_path() -> Option<&'static PathBuf> {
    TIMENC_PATH.get_or_init(find_timenc).as_ref()
}

// ─── Public API ───────────────────────────────────────────────────────────────

/// Returns true if the timenc binary can be found and executed.
pub fn is_installed() -> bool {
    timenc_path().is_some()
}

/// Returns the version string reported by timenc, e.g. "timenc 1.2.0".
pub fn version() -> Option<String> {
    let path = timenc_path()?;

    for flag in &["--version", "-V"] {
        if let Ok(out) = no_window_cmd(path).arg(flag).output() {
            // Accept output from stdout or stderr
            let s = {
                let so = String::from_utf8_lossy(&out.stdout).trim().to_string();
                let se = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !so.is_empty() { so } else { se }
            };
            if !s.is_empty() {
                return Some(s);
            }
        }
    }
    Some("installed".to_string())
}

/// Encrypt `input_path` → `output_path`.
///
/// We verify success by checking that the output file was written with content,
/// because timenc (Python) may crash on its own print("✅ …") call after a
/// successful encryption — causing a non-zero exit code despite the file being
/// written correctly.
pub fn encrypt(
    input_path: &str,
    output_path: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<()> {
    let mut cmd = build_cmd("encrypt")?;
    cmd.arg(input_path)
        .arg("-o").arg(output_path)
        .arg("-p").arg(password);
    if let Some(kf) = keyfile { cmd.arg("-k").arg(kf); }

    run_cmd(cmd, SuccessCheck::FileExists(output_path.to_string()))
}

/// Decrypt `input_path` → files inside `output_dir`.
///
/// Same rationale: success is verified by checking that at least one file
/// appeared in the output directory.
pub fn decrypt(
    input_path: &str,
    output_dir: &str,
    password: &str,
    keyfile: Option<&str>,
) -> Result<()> {
    let mut cmd = build_cmd("decrypt")?;
    cmd.arg(input_path)
        .arg("-o").arg(output_dir)
        .arg("-p").arg(password);
    if let Some(kf) = keyfile { cmd.arg("-k").arg(kf); }

    run_cmd(cmd, SuccessCheck::DirHasFiles(output_dir.to_string()))
}

/// Generate a 32-byte random keyfile at `output_path`.
pub fn generate_keyfile(output_path: &str) -> Result<()> {
    let mut cmd = build_cmd("generate-keyfile")?;
    cmd.arg(output_path);
    run_cmd(cmd, SuccessCheck::FileExists(output_path.to_string()))
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

fn build_cmd(subcommand: &str) -> Result<Command> {
    let path = timenc_path().ok_or(JournalError::TimencNotInstalled)?;
    let mut cmd = no_window_cmd(path);
    cmd.arg(subcommand);
    Ok(cmd)
}

/// Create a `Command` with CREATE_NO_WINDOW on Windows.
fn no_window_cmd<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    cmd
}

/// How to determine whether the command succeeded independently of exit code.
enum SuccessCheck {
    /// The operation succeeded if this file exists and is non-empty.
    FileExists(String),
    /// The operation succeeded if this directory contains at least one file.
    DirHasFiles(String),
}

impl SuccessCheck {
    /// Returns true if the output artifact is present and non-empty.
    fn satisfied(&self) -> bool {
        match self {
            SuccessCheck::FileExists(p) => {
                std::path::Path::new(p)
                    .metadata()
                    .map(|m| m.len() > 0)
                    .unwrap_or(false)
            }
            SuccessCheck::DirHasFiles(dir) => std::fs::read_dir(dir)
                .map(|mut d| d.next().is_some())
                .unwrap_or(false),
        }
    }

    fn error(self, msg: String) -> JournalError {
        match self {
            SuccessCheck::FileExists(_) => JournalError::EncryptionFailed(msg),
            SuccessCheck::DirHasFiles(_) => JournalError::DecryptionFailed(msg),
        }
    }
}

/// Run a timenc subcommand.
///
/// TimENC (Python/PyInstaller) prints emoji (✅ ❌) to stdout/stderr. On
/// Windows the default codepage is cp1252 which cannot encode those characters,
/// so Python throws a UnicodeEncodeError *after* the actual work is done and
/// exits with code 1 — even though the output file was written correctly.
///
/// Strategy:
/// 1. Discard stdout/stderr entirely (no encoding issues).
/// 2. After the process exits, check whether the expected output artifact
///    exists and is non-empty. If yes → success regardless of exit code.
/// 3. Only report failure when the artifact is absent AND exit code != 0.
fn run_cmd(mut cmd: Command, check: SuccessCheck) -> Result<()> {
    use std::process::Stdio;

    let status = cmd
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                JournalError::TimencNotInstalled
            } else {
                JournalError::Io(e)
            }
        })?;

    // Primary success path: exit code 0.
    if status.success() {
        return Ok(());
    }

    // Secondary success path: the output artifact exists despite non-zero exit.
    // This handles the case where timenc encrypts/decrypts successfully but
    // then crashes trying to print its emoji success message.
    if check.satisfied() {
        return Ok(());
    }

    let code = status.code().unwrap_or(-1);
    Err(check.error(format!(
        "timenc exited with code {code} and produced no output. \
         Check that the password is correct and the path is writable."
    )))
}
