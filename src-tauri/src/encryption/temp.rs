use std::path::Path;
use tempfile::TempDir;
use zeroize::Zeroize;

use crate::error::Result;

/// Manages a temporary directory that is cleaned up on drop.
///
/// Since TimENC encryption now runs in-process (no host `timenc` subprocess),
/// the temp dir can live in the normal system temp location — there is no need
/// to expose it on the host filesystem anymore.
pub struct SecureTempDir {
    inner: TempDir,
}

impl SecureTempDir {
    pub fn new() -> Result<Self> {
        Ok(SecureTempDir {
            inner: TempDir::new()?,
        })
    }

    pub fn path(&self) -> &Path {
        self.inner.path()
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
