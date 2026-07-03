//! Lockbook v2 container format (`LBOOK2`).
//!
//! # Why a custom container
//!
//! v1.3.0 journals are a single JSON document (attachments base64-embedded)
//! encrypted as one TimENC file. That works, but every open must decrypt *and*
//! hold every image in memory just to read the text, and re-encrypting the whole
//! blob on each save scales poorly with attachment count.
//!
//! The v2 container splits the journal into independently-encrypted sections that
//! all share **one** Argon2 key derivation:
//!
//! * a small, zstd-compressed **index** (all entry HTML/metadata plus a table of
//!   where each attachment blob lives), and
//! * one **blob** per attachment (the raw file bytes — *not* base64, *not*
//!   re-compressed, since images are already compressed).
//!
//! This is what makes **lazy image decryption** possible: [`open_session`]
//! derives the master key once (the expensive step) and decrypts only the small
//! index; individual blobs are then decrypted cheaply and on demand through
//! [`ContainerSession::decrypt_blob`], without re-running Argon2 and without ever
//! reading the whole file into memory.
//!
//! # Cryptography
//!
//! Built directly on TimENC's public primitives (`timenc::crypto`), the exact
//! same ChaCha20-Poly1305 + Argon2id used by TimENC's own file format:
//!
//! * One random 16-byte salt → one Argon2id master key (params stored in the
//!   header so future tuning stays self-describing).
//! * Every section (index and each blob) gets its own random 96-bit nonce.
//! * Each section is bound with AAD to the file header prefix (salt + KDF params
//!   + index nonce) and, for blobs, to their ordinal position. The blob table is
//!   itself inside the authenticated index, so offsets/nonces cannot be tampered
//!   with, and a blob cannot be swapped between files or reordered without failing
//!   authentication.
//!
//! No plaintext is ever written to disk on save (the whole container is assembled
//! in memory and only the ciphertext is written), and load never spills plaintext
//! to a temp file — an improvement over the legacy TimENC path.
//!
//! # On-disk layout
//!
//! ```text
//! ┌─ header (fixed, 55 bytes) ─────────────────────────────────────────────┐
//! │ magic "LBOOK2" (6) | version u8 (1) | salt (16)                         │
//! │ time_cost u32 | memory_kib u32 | parallelism u32   (KDF params, LE)     │
//! │ index_nonce (12) | index_len u64 (LE)                                   │
//! ├─ index ciphertext (index_len bytes) ───────────────────────────────────┤
//! │ ChaCha20-Poly1305( zstd( index_json ) )                                 │
//! ├─ blob region (rest of file) ───────────────────────────────────────────┤
//! │ concatenated blob ciphertexts; offsets/lengths recorded in the index    │
//! └────────────────────────────────────────────────────────────────────────┘
//! ```

use std::collections::HashMap;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::{Deserialize, Serialize};
use timenc::crypto::{
    decrypt_chunk, derive_key, encrypt_chunk, generate_nonce, generate_salt, KEY_LEN, NONCE_SIZE,
    SALT_SIZE,
};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{JournalError, Result};
use crate::journal::JournalData;

/// Magic bytes that mark a Lockbook v2 container. Chosen so the very first byte
/// differs from a TimENC file (`TIMENC`), letting the loader branch on format.
const MAGIC: &[u8; 6] = b"LBOOK2";

/// Current container format version. Bumped only on a real on-disk layout change.
const FORMAT_VERSION: u8 = 1;

/// Argon2id parameters, matching TimENC's v4 defaults for consistency. Stored in
/// the header, so decryption uses the file's own values rather than these.
const ARGON2_TIME_COST: u32 = 3;
const ARGON2_MEMORY_KIB: u32 = 262_144; // 256 MiB
const ARGON2_PARALLELISM: u32 = 4;

/// Length of the fixed header up to (but excluding) `index_len`. This prefix is
/// what every section is authenticated against.
const HEADER_PREFIX_LEN: usize = 6 + 1 + SALT_SIZE + 4 + 4 + 4 + NONCE_SIZE; // 47
/// Total fixed header length, including the 8-byte `index_len`.
const HEADER_LEN: usize = HEADER_PREFIX_LEN + 8; // 55

/// Where one attachment's raw bytes live inside the blob region, plus the nonce
/// used to seal them. Stored inside the (authenticated) index.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct BlobRef {
    /// The owning attachment's id — verified on eager load, and the lookup key
    /// for on-demand decryption.
    id: String,
    /// Byte offset of the blob's ciphertext, relative to the blob region start.
    offset: u64,
    /// Length of the blob's ciphertext, including the 16-byte auth tag.
    enc_len: u64,
    /// Per-blob random nonce.
    nonce: [u8; NONCE_SIZE],
}

/// The plaintext index: the journal with attachment bytes stripped out, plus the
/// table describing where each stripped blob now lives.
#[derive(Debug, Serialize, Deserialize)]
struct ContainerIndex {
    /// Full journal data, but every `Attachment.data` emptied (blobs live in the
    /// blob region instead). Attachment order defines blob order.
    journal: JournalData,
    /// Blob table, aligned 1:1 with the flattened attachment iteration order
    /// (entries in order, each entry's attachments in order).
    blobs: Vec<BlobRef>,
}

/// Location of one blob's ciphertext within the file (kept in a decrypted
/// session for fast on-demand access).
#[derive(Debug, Clone)]
struct BlobLoc {
    offset: u64,
    enc_len: u64,
    nonce: [u8; NONCE_SIZE],
}

/// A decrypted, in-memory handle to an open container: the master key plus the
/// blob table, so individual attachment blobs can be decrypted on demand without
/// re-deriving the key or reading the whole file. Dropping it zeroizes the key.
pub struct ContainerSession {
    path: PathBuf,
    key: Zeroizing<[u8; KEY_LEN]>,
    header_prefix: Vec<u8>,
    blob_region_start: u64,
    blobs: Vec<BlobLoc>,
    by_id: HashMap<String, usize>,
}

impl ContainerSession {
    /// True if a blob for `id` exists in this container.
    pub fn has_blob(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    /// Decrypt and return the raw bytes of the attachment blob for `id`, reading
    /// only that blob's slice from the file. No Argon2 is involved.
    pub fn decrypt_blob(&self, id: &str) -> Result<Vec<u8>> {
        let ord = *self
            .by_id
            .get(id)
            .ok_or_else(|| JournalError::InvalidFormat(format!("unknown attachment id: {id}")))?;
        let loc = &self.blobs[ord];

        let mut f = File::open(&self.path)?;
        f.seek(SeekFrom::Start(self.blob_region_start + loc.offset))?;
        let mut ct = vec![0u8; loc.enc_len as usize];
        f.read_exact(&mut ct)?;

        let aad = blob_aad(&self.header_prefix, ord as u64);
        decrypt_chunk(&self.key, &loc.nonce, &ct, &aad)
            .map_err(|_| JournalError::DecryptionFailed("blob authentication failed".to_string()))
    }

    /// Point the session at a different file (used after a save renames the
    /// finished staging container over the target — the bytes are identical, so
    /// only the path changes).
    pub fn set_path(&mut self, path: PathBuf) {
        self.path = path;
    }
}

/// True if `bytes` begins with the container magic.
pub fn is_container(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

/// AAD binding the index to the header prefix (salt + KDF params + index nonce).
fn index_aad(header_prefix: &[u8]) -> Vec<u8> {
    let mut aad = Vec::with_capacity(b"LBOOK2-index".len() + header_prefix.len());
    aad.extend_from_slice(b"LBOOK2-index");
    aad.extend_from_slice(header_prefix);
    aad
}

/// AAD binding a blob to the header prefix and its ordinal position, so blobs
/// can be neither transplanted to another file nor reordered within this one.
fn blob_aad(header_prefix: &[u8], ordinal: u64) -> Vec<u8> {
    let mut aad = Vec::with_capacity(b"LBOOK2-blob".len() + header_prefix.len() + 8);
    aad.extend_from_slice(b"LBOOK2-blob");
    aad.extend_from_slice(header_prefix);
    aad.extend_from_slice(&ordinal.to_le_bytes());
    aad
}

/// Read optional keyfile bytes.
fn read_keyfile(keyfile: Option<&str>) -> Result<Option<Vec<u8>>> {
    match keyfile {
        Some(path) => Ok(Some(std::fs::read(PathBuf::from(path))?)),
        None => Ok(None),
    }
}

/// Serialize, compress, encrypt, and write `data` to `path` as an `LBOOK2`
/// container, returning a [`ContainerSession`] for the just-written file. No
/// plaintext touches the disk.
pub fn write_container(
    path: &Path,
    password: &str,
    keyfile: Option<&str>,
    data: &JournalData,
) -> Result<ContainerSession> {
    let keyfile_bytes = read_keyfile(keyfile)?;

    let salt = generate_salt();
    let index_nonce = generate_nonce();
    let time_cost = ARGON2_TIME_COST;
    let memory_kib = ARGON2_MEMORY_KIB;
    let parallelism = ARGON2_PARALLELISM;

    let key = derive_key(
        password.as_bytes(),
        &salt,
        time_cost,
        memory_kib,
        parallelism,
        keyfile_bytes.as_deref(),
    );
    let key_ref: &[u8; KEY_LEN] = &key;

    // Header prefix: everything the sections are authenticated against.
    let mut header_prefix = Vec::with_capacity(HEADER_PREFIX_LEN);
    header_prefix.extend_from_slice(MAGIC);
    header_prefix.push(FORMAT_VERSION);
    header_prefix.extend_from_slice(&salt);
    header_prefix.extend_from_slice(&time_cost.to_le_bytes());
    header_prefix.extend_from_slice(&memory_kib.to_le_bytes());
    header_prefix.extend_from_slice(&parallelism.to_le_bytes());
    header_prefix.extend_from_slice(&index_nonce);
    debug_assert_eq!(header_prefix.len(), HEADER_PREFIX_LEN);

    // Build a stripped copy of the journal and pull every attachment's raw bytes
    // out into the blob region.
    let mut index_journal = data.clone();
    let mut blob_region: Vec<u8> = Vec::new();
    let mut blob_refs: Vec<BlobRef> = Vec::new();
    let mut blob_locs: Vec<BlobLoc> = Vec::new();
    let mut by_id: HashMap<String, usize> = HashMap::new();
    let mut ordinal: u64 = 0;

    for entry in &mut index_journal.entries {
        for att in &mut entry.attachments {
            let mut raw = BASE64
                .decode(att.data.as_bytes())
                .map_err(|e| JournalError::InvalidFormat(format!("bad attachment base64: {e}")))?;
            let nonce = generate_nonce();
            let aad = blob_aad(&header_prefix, ordinal);
            let ct = encrypt_chunk(key_ref, &nonce, &raw, &aad)
                .map_err(|_| JournalError::EncryptionFailed("blob encryption failed".to_string()))?;
            raw.zeroize();

            let offset = blob_region.len() as u64;
            let enc_len = ct.len() as u64;
            blob_refs.push(BlobRef {
                id: att.id.clone(),
                offset,
                enc_len,
                nonce,
            });
            blob_locs.push(BlobLoc { offset, enc_len, nonce });
            by_id.insert(att.id.clone(), ordinal as usize);
            blob_region.extend_from_slice(&ct);

            // Strip the blob from the index copy; readers re-inflate from the blob
            // region (eagerly for verification, lazily at runtime).
            att.data = String::new();
            ordinal += 1;
        }
    }

    // Serialize + compress + encrypt the index.
    let index = ContainerIndex {
        journal: index_journal,
        blobs: blob_refs,
    };
    let mut index_json = serde_json::to_vec(&index).map_err(JournalError::Json)?;
    let index_compressed = zstd::encode_all(&index_json[..], 0)
        .map_err(|e| JournalError::EncryptionFailed(format!("index compression failed: {e}")))?;
    index_json.zeroize();

    let index_ct = encrypt_chunk(key_ref, &index_nonce, &index_compressed, &index_aad(&header_prefix))
        .map_err(|_| JournalError::EncryptionFailed("index encryption failed".to_string()))?;

    let blob_region_start = (HEADER_LEN + index_ct.len()) as u64;

    // Assemble the whole file in memory, then write ciphertext-only to disk.
    let mut out = Vec::with_capacity(HEADER_LEN + index_ct.len() + blob_region.len());
    out.extend_from_slice(&header_prefix);
    out.extend_from_slice(&(index_ct.len() as u64).to_le_bytes());
    out.extend_from_slice(&index_ct);
    out.extend_from_slice(&blob_region);

    std::fs::write(path, &out)?;

    Ok(ContainerSession {
        path: path.to_path_buf(),
        key,
        header_prefix,
        blob_region_start,
        blobs: blob_locs,
        by_id,
    })
}

/// Open a container: derive the key once, decrypt only the (small) index, and
/// return the journal **with attachment bytes stripped** (every `data` empty)
/// plus a [`ContainerSession`] for decrypting blobs on demand. The blob region
/// is never read here.
pub fn open_session(
    path: &Path,
    password: &str,
    keyfile: Option<&str>,
) -> Result<(JournalData, ContainerSession)> {
    let mut f = File::open(path)?;

    let mut header = [0u8; HEADER_LEN];
    f.read_exact(&mut header)
        .map_err(|_| JournalError::InvalidFormat("file smaller than container header".to_string()))?;
    if !is_container(&header) {
        return Err(JournalError::InvalidFormat("not a Lockbook container".to_string()));
    }
    let version = header[6];
    if version != FORMAT_VERSION {
        return Err(JournalError::InvalidFormat(format!(
            "unsupported container version {version}"
        )));
    }

    let salt: [u8; SALT_SIZE] = header[7..7 + SALT_SIZE].try_into().unwrap();
    let mut p = 7 + SALT_SIZE;
    let time_cost = u32::from_le_bytes(header[p..p + 4].try_into().unwrap());
    p += 4;
    let memory_kib = u32::from_le_bytes(header[p..p + 4].try_into().unwrap());
    p += 4;
    let parallelism = u32::from_le_bytes(header[p..p + 4].try_into().unwrap());
    p += 4;
    let index_nonce: [u8; NONCE_SIZE] = header[p..p + NONCE_SIZE].try_into().unwrap();
    p += NONCE_SIZE;
    debug_assert_eq!(p, HEADER_PREFIX_LEN);
    let index_len = u64::from_le_bytes(header[p..p + 8].try_into().unwrap()) as usize;

    let header_prefix = header[..HEADER_PREFIX_LEN].to_vec();

    let mut index_ct = vec![0u8; index_len];
    f.read_exact(&mut index_ct)
        .map_err(|_| JournalError::InvalidFormat("index extends past end of file".to_string()))?;

    let keyfile_bytes = read_keyfile(keyfile)?;
    let key = derive_key(
        password.as_bytes(),
        &salt,
        time_cost,
        memory_kib,
        parallelism,
        keyfile_bytes.as_deref(),
    );

    let index_compressed = decrypt_chunk(&key, &index_nonce, &index_ct, &index_aad(&header_prefix))
        .map_err(|_| JournalError::DecryptionFailed("wrong password or keyfile".to_string()))?;
    let mut index_json = zstd::decode_all(&index_compressed[..])
        .map_err(|e| JournalError::InvalidFormat(format!("index decompression failed: {e}")))?;
    let index: ContainerIndex =
        serde_json::from_slice(&index_json).map_err(JournalError::Json)?;
    index_json.zeroize();

    let blob_region_start = (HEADER_LEN + index_len) as u64;
    let mut blobs: Vec<BlobLoc> = Vec::with_capacity(index.blobs.len());
    let mut by_id: HashMap<String, usize> = HashMap::with_capacity(index.blobs.len());
    for (i, b) in index.blobs.iter().enumerate() {
        blobs.push(BlobLoc {
            offset: b.offset,
            enc_len: b.enc_len,
            nonce: b.nonce,
        });
        by_id.insert(b.id.clone(), i);
    }

    let session = ContainerSession {
        path: path.to_path_buf(),
        key,
        header_prefix,
        blob_region_start,
        blobs,
        by_id,
    };

    // `index.journal` already has every attachment `data` empty.
    Ok((index.journal, session))
}

/// Read an `LBOOK2` container and return a **fully-populated** [`JournalData`]
/// (attachment bytes re-inflated to base64). Used by the save path's round-trip
/// verification; the runtime open path uses [`open_session`] instead.
pub fn read_container(
    path: &Path,
    password: &str,
    keyfile: Option<&str>,
) -> Result<JournalData> {
    let (mut journal, session) = open_session(path, password, keyfile)?;

    // Re-inflate every blob, verifying the table lines up with the attachments.
    let mut ordinal: usize = 0;
    for entry in &mut journal.entries {
        for att in &mut entry.attachments {
            if !session.has_blob(&att.id) {
                return Err(JournalError::InvalidFormat(
                    "attachment has no blob in the container".to_string(),
                ));
            }
            let mut raw = session.decrypt_blob(&att.id)?;
            att.data = BASE64.encode(&raw);
            raw.zeroize();
            ordinal += 1;
        }
    }
    if ordinal != session.blobs.len() {
        return Err(JournalError::InvalidFormat(
            "blob table does not match attachment count".to_string(),
        ));
    }

    Ok(journal)
}
