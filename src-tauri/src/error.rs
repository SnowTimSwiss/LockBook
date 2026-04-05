use thiserror::Error;

#[derive(Debug, Error)]
pub enum JournalError {
    #[error("TimENC CLI is not installed. Download from: https://github.com/SnowTimSwiss/TimENC/releases/latest")]
    TimencNotInstalled,

    #[error("TimENC encryption failed: {0}")]
    EncryptionFailed(String),

    #[error("TimENC decryption failed. Wrong password or keyfile?")]
    DecryptionFailed(String),

    #[error("Journal file not found: {0}")]
    FileNotFound(String),

    #[error("Invalid journal format: {0}")]
    InvalidFormat(String),

    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("No journal is currently open")]
    NoJournalOpen,

    #[error("Entry not found: {0}")]
    EntryNotFound(String),

}

pub type Result<T> = std::result::Result<T, JournalError>;

// Tauri commands must return serializable errors
impl serde::Serialize for JournalError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
