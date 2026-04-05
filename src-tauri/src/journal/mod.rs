pub mod entry;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

pub use entry::JournalEntry;

use crate::error::{JournalError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalMetadata {
    pub created: DateTime<Utc>,
    pub modified: DateTime<Utc>,
    pub app: String,
    pub version: String,
}

impl Default for JournalMetadata {
    fn default() -> Self {
        let now = Utc::now();
        JournalMetadata {
            created: now,
            modified: now,
            app: "TimENC-Journal".to_string(),
            version: env!("CARGO_PKG_VERSION").to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalData {
    pub version: String,
    pub entries: Vec<JournalEntry>,
    pub metadata: JournalMetadata,
}

impl Default for JournalData {
    fn default() -> Self {
        JournalData {
            version: "1.0".to_string(),
            entries: Vec::new(),
            metadata: JournalMetadata::default(),
        }
    }
}

impl JournalData {
    /// Deserialize from JSON bytes.
    pub fn from_json(data: &[u8]) -> Result<Self> {
        serde_json::from_slice(data).map_err(JournalError::Json)
    }

    /// Serialize to pretty-printed JSON bytes.
    pub fn to_json(&self) -> Result<Vec<u8>> {
        serde_json::to_vec_pretty(self).map_err(JournalError::Json)
    }

    /// Add or replace an entry (matched by id).
    pub fn upsert_entry(&mut self, entry: JournalEntry) {
        if let Some(pos) = self.entries.iter().position(|e| e.id == entry.id) {
            self.entries[pos] = entry;
        } else {
            self.entries.push(entry);
        }
        self.metadata.modified = Utc::now();
    }

    /// Remove an entry by id. Returns an error if not found.
    pub fn remove_entry(&mut self, entry_id: &str) -> Result<()> {
        let pos = self
            .entries
            .iter()
            .position(|e| e.id == entry_id)
            .ok_or_else(|| JournalError::EntryNotFound(entry_id.to_string()))?;
        self.entries.remove(pos);
        self.metadata.modified = Utc::now();
        Ok(())
    }

    /// Case-insensitive full-text search across title, content and tags.
    pub fn search(&self, query: &str) -> Vec<JournalEntry> {
        self.entries
            .iter()
            .filter(|e| e.matches_query(query))
            .cloned()
            .collect()
    }

    /// Return entries sorted newest first.
    pub fn sorted_entries(&self) -> Vec<JournalEntry> {
        let mut entries = self.entries.clone();
        entries.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
        entries
    }
}

/// Holds the runtime state of an open journal (path + credentials + data).
pub struct OpenJournal {
    pub path: String,
    pub data: JournalData,
}
