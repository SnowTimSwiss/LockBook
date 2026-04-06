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
    pub attachments: Vec<String>,
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
