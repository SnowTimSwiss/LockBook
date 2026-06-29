use std::path::{Path, PathBuf};
use tempfile::TempDir;
use zeroize::Zeroize;

use crate::error::Result;

/// When running inside a Flatpak sandbox, return a host-visible base directory
/// for temporary files (so the host `timenc` can read/write them); otherwise
/// `None` to use the system temp dir.
fn flatpak_shared_tmp() -> Option<PathBuf> {
    if super::timenc_cli::in_flatpak() {
        std::env::var_os("XDG_CACHE_HOME").map(PathBuf::from)
    } else {
        None
    }
}

/// Manages a temporary directory that is securely cleaned up on drop.
pub struct SecureTempDir {
    inner: TempDir,
}

impl SecureTempDir {
    pub fn new() -> Result<Self> {
        let inner = match flatpak_shared_tmp() {
            // Inside Flatpak, plaintext temp files must live where the host-side
            // `timenc` (invoked via `flatpak-spawn --host`) can see them at the
            // same path. XDG_CACHE_HOME is mapped onto the real host filesystem.
            Some(base) => {
                std::fs::create_dir_all(&base)?;
                TempDir::new_in(&base)?
            }
            None => TempDir::new()?,
        };
        Ok(SecureTempDir { inner })
    }

    pub fn path(&self) -> &Path {
        self.inner.path()
    }

    /// Write data to a named file inside the temp dir, then return its path.
    pub fn write_file(&self, name: &str, data: &[u8]) -> Result<PathBuf> {
        let path = self.inner.path().join(name);
        std::fs::write(&path, data)?;
        Ok(path)
    }

    /// Securely overwrite and remove a file inside the temp dir.
    pub fn secure_delete(&self, name: &str) -> Result<()> {
        let path = self.inner.path().join(name);
        if path.exists() {
            let len = std::fs::metadata(&path)?.len() as usize;
            // Overwrite with zeros before deletion to hinder forensic recovery.
            let zeros = vec![0u8; len.min(64 * 1024)];
            let mut file = std::fs::OpenOptions::new().write(true).open(&path)?;
            use std::io::Write;
            let mut written = 0usize;
            while written < len {
                let chunk = zeros.len().min(len - written);
                file.write_all(&zeros[..chunk])?;
                written += chunk;
            }
            file.flush()?;
            drop(file);
            std::fs::remove_file(&path)?;
        }
        Ok(())
    }
}

/// A password wrapper that zeros memory on drop.
pub struct SecurePassword(String);

impl SecurePassword {
    pub fn new(password: String) -> Self {
        SecurePassword(password)
    }
}

impl Drop for SecurePassword {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
