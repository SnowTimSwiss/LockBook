use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum Mood {
    Happy,
    Neutral,
    Sad,
    Angry,
    Anxious,
}

impl Default for Mood {
    fn default() -> Self {
        Mood::Neutral
    }
}

/// Where an attachment lives in the UI. `Inline` images are referenced from the
/// entry's HTML content via `<img data-att-id="…">`; `Panel` attachments (any
/// file, including images the user chose not to inline) show in the attachments
/// panel. v1.3.0 journals have no placement — migration derives it (images →
/// inline, other files → panel).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentPlacement {
    Inline,
    Panel,
}

impl Default for AttachmentPlacement {
    fn default() -> Self {
        AttachmentPlacement::Inline
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub size: u64,
    /// Base64-encoded file bytes, embedded directly so attachments travel
    /// inside the same encrypted `.lbook` blob as everything else.
    pub data: String,
    #[serde(default)]
    pub width: Option<u32>,
    #[serde(default)]
    pub height: Option<u32>,
    #[serde(default)]
    pub placement: AttachmentPlacement,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JournalEntry {
    pub id: String,
    pub timestamp: DateTime<Utc>,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub mood: Mood,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

impl JournalEntry {
    /// Create a new blank entry with a generated UUID and current timestamp.
    pub fn new(title: impl Into<String>) -> Self {
        JournalEntry {
            id: Uuid::new_v4().to_string(),
            timestamp: Utc::now(),
            title: title.into(),
            content: String::new(),
            tags: Vec::new(),
            mood: Mood::default(),
            attachments: Vec::new(),
        }
    }

    /// Returns true if the entry content or title contains the query string (case-insensitive).
    pub fn matches_query(&self, query: &str) -> bool {
        let q = query.to_lowercase();
        self.title.to_lowercase().contains(&q)
            || self.content.to_lowercase().contains(&q)
            || self.tags.iter().any(|t| t.to_lowercase().contains(&q))
    }
}
