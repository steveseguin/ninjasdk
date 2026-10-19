// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! Sanitization rules shared with the JavaScript SDK.

use serde_json::{Map, Value};

use crate::crypto::generate_stream_id;

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `s.replace(/[\W]+/g, "_")` with JavaScript's ASCII-only `\w`.
fn replace_non_word(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_run = false;
    for c in s.chars() {
        if is_word(c) {
            out.push(c);
            in_run = false;
        } else if !in_run {
            out.push('_');
            in_run = true;
        }
    }
    out
}

/// Trim, replace runs of non `[A-Za-z0-9_]` with `_`, truncate to 64. Empty
/// input yields a random ID.
pub fn sanitize_stream_id(stream_id: &str) -> String {
    let trimmed = stream_id.trim();
    if trimmed.is_empty() {
        return generate_stream_id();
    }
    let mut s = replace_non_word(trimmed);
    s.truncate(64);
    s
}

/// Same rules as stream IDs but truncated to 30 characters; empty stays empty.
pub fn sanitize_room(room: &str) -> String {
    let trimmed = room.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let mut s = replace_non_word(trimmed);
    s.truncate(30);
    s
}

/// Remove line breaks, truncate to 100 characters, trim.
pub fn sanitize_label(label: &str) -> String {
    let no_breaks: String = label.chars().filter(|c| *c != '\r' && *c != '\n').collect();
    no_breaks
        .chars()
        .take(100)
        .collect::<String>()
        .trim()
        .to_string()
}

/// JavaScript's `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    const HEX: &[u8] = b"0123456789ABCDEF";
    let mut out = String::with_capacity(s.len() * 3);
    for &b in s.as_bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(b as char);
        } else {
            out.push('%');
            out.push(HEX[(b >> 4) as usize] as char);
            out.push(HEX[(b & 0x0f) as usize] as char);
        }
    }
    out
}

/// Trim and URL-encode once: the form VDO.Ninja hashes and derives keys from.
pub fn sanitize_password(password: &str) -> String {
    let trimmed = password.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    encode_uri_component(trimmed)
}

/// Shape-preserving sanitizer for publisher `meta` (VDO.Ninja expects an object).
/// Returns `None` for values that cannot be represented.
pub fn sanitize_meta(meta: &Value, depth: usize) -> Option<Value> {
    match meta {
        Value::String(s) => Some(Value::String(sanitize_label(s))),
        Value::Object(map) if depth <= 1 => {
            let mut out = Map::new();
            for (i, (k, v)) in map.iter().enumerate() {
                if i >= 32 {
                    break;
                }
                let key = sanitize_label(k);
                if key.is_empty() {
                    continue;
                }
                match v {
                    Value::String(s) => {
                        out.insert(key, Value::String(sanitize_label(s)));
                    }
                    Value::Bool(_) | Value::Number(_) => {
                        out.insert(key, v.clone());
                    }
                    Value::Object(_) => {
                        if let Some(Value::Object(nested)) = sanitize_meta(v, depth + 1) {
                            out.insert(key, Value::Object(nested));
                        }
                    }
                    _ => {}
                }
            }
            Some(Value::Object(out))
        }
        _ => None,
    }
}
