// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! SHA-256 hashing and AES-256-CBC encryption matching VDO.Ninja.

use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use rand::RngCore;
use sha2::{Digest, Sha256};

type Aes256CbcEnc = cbc::Encryptor<aes::Aes256>;
type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// Errors from decryption.
#[derive(Debug, thiserror::Error)]
pub enum CryptoError {
    #[error("invalid hex: {0}")]
    Hex(#[from] hex::FromHexError),
    #[error("ciphertext or iv has an invalid length")]
    Length,
    #[error("bad padding (wrong password or salt?)")]
    Padding,
    #[error("plaintext is not UTF-8")]
    Utf8,
}

/// Hex SHA-256 of `input`, truncated to `length` hex characters (`length / 2`
/// bytes, so odd lengths round down). `0` returns the full digest.
pub fn generate_hash(input: &str, length: usize) -> String {
    let digest = Sha256::digest(input.as_bytes());
    let full = hex::encode(digest);
    if length == 0 {
        return full;
    }
    let n = ((length / 2) * 2).min(full.len());
    full[..n].to_string()
}

/// The 6-character suffix appended to stream IDs when a password is in use.
pub fn stream_hash_suffix(sanitized_password: &str, salt: &str) -> String {
    generate_hash(&format!("{sanitized_password}{salt}"), 6)
}

/// `stream_id` + [`stream_hash_suffix`].
pub fn hash_stream_id(stream_id: &str, sanitized_password: &str, salt: &str) -> String {
    format!(
        "{stream_id}{}",
        stream_hash_suffix(sanitized_password, salt)
    )
}

/// 16-character room hash: `sha256(room + password + salt)[..16]`.
pub fn hash_room(room: &str, sanitized_password: &str, salt: &str) -> String {
    generate_hash(&format!("{room}{sanitized_password}{salt}"), 16)
}

fn key_for(phrase: &str) -> [u8; 32] {
    Sha256::digest(phrase.as_bytes()).into()
}

/// AES-256-CBC with PKCS#7 padding and a caller-supplied IV (tests / vectors).
pub fn encrypt_with_iv(plaintext: &[u8], phrase: &str, iv: &[u8; 16]) -> Vec<u8> {
    let key = key_for(phrase);
    Aes256CbcEnc::new(&key.into(), iv.into()).encrypt_padded_vec_mut::<Pkcs7>(plaintext)
}

/// Encrypts `plaintext` with key = SHA-256(phrase) and a random IV. Returns
/// `(ciphertext_hex, iv_hex)` exactly as VDO.Ninja places them in the
/// `description`/`candidates` and `vector` fields.
pub fn encrypt_message(plaintext: &str, phrase: &str) -> (String, String) {
    let mut iv = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut iv);
    let ct = encrypt_with_iv(plaintext.as_bytes(), phrase, &iv);
    (hex::encode(ct), hex::encode(iv))
}

/// Reverses [`encrypt_message`].
pub fn decrypt_message(
    ciphertext_hex: &str,
    iv_hex: &str,
    phrase: &str,
) -> Result<String, CryptoError> {
    let ct = hex::decode(ciphertext_hex)?;
    let iv = hex::decode(iv_hex)?;
    if iv.len() != 16 || ct.is_empty() || ct.len() % 16 != 0 {
        return Err(CryptoError::Length);
    }
    let key = key_for(phrase);
    let iv: [u8; 16] = iv.try_into().map_err(|_| CryptoError::Length)?;
    let plain = Aes256CbcDec::new(&key.into(), &iv.into())
        .decrypt_padded_vec_mut::<Pkcs7>(&ct)
        .map_err(|_| CryptoError::Padding)?;
    String::from_utf8(plain).map_err(|_| CryptoError::Utf8)
}

const ALNUM: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
const SESSION: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

fn random_string(alphabet: &[u8], len: usize) -> String {
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| alphabet[(rng.next_u32() as usize) % alphabet.len()] as char)
        .collect()
}

/// Random 12-character lowercase alphanumeric stream ID (never punctuation).
pub fn generate_stream_id() -> String {
    random_string(ALNUM, 12)
}

/// Random 8-character WebRTC session ID.
pub fn generate_session() -> String {
    random_string(SESSION, 8)
}

/// Random RFC 4122 v4 UUID string.
pub fn generate_uuid() -> String {
    let mut b = [0u8; 16];
    rand::thread_rng().fill_bytes(&mut b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let h = hex::encode(b);
    format!(
        "{}-{}-{}-{}-{}",
        &h[0..8],
        &h[8..12],
        &h[12..16],
        &h[16..20],
        &h[20..32]
    )
}
