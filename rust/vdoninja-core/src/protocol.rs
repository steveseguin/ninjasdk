// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! JSON shapes used on the signaling socket and the control data channel.

use serde::{Deserialize, Serialize};

/// A session description as it appears (decrypted) in the `description` field.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SessionDescription {
    #[serde(rename = "type")]
    pub kind: String,
    pub sdp: String,
}

/// An ICE candidate as it appears (decrypted) in `candidate`/`candidates`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct IceCandidate {
    pub candidate: String,
    #[serde(rename = "sdpMid", default, skip_serializing_if = "Option::is_none")]
    pub sdp_mid: Option<String>,
    #[serde(
        rename = "sdpMLineIndex",
        default,
        skip_serializing_if = "Option::is_none"
    )]
    pub sdp_mline_index: Option<u16>,
}

/// Direction tag on candidate messages: viewers send `remote`, publishers `local`.
pub fn candidate_type_for(connection_type: &str) -> &'static str {
    if connection_type == "viewer" {
        "remote"
    } else {
        "local"
    }
}

/// An advertised file in a `fileList` message.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct FileEntry {
    pub id: String,
    pub name: String,
    pub size: u64,
}

/// Header frame sent on a file transfer channel before the chunks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileTransferHeader {
    #[serde(rename = "type")]
    pub kind: String,
    pub size: u64,
    pub filename: String,
    pub id: serde_json::Value,
}

/// A room listing entry.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ListingEntry {
    #[serde(rename = "streamID", default, skip_serializing_if = "Option::is_none")]
    pub stream_id: Option<String>,
    #[serde(rename = "UUID", default, skip_serializing_if = "Option::is_none")]
    pub uuid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub director: bool,
}

/// Strips the password hash suffix from a stream ID when present.
pub fn strip_hash<'a>(stream_id: &'a str, suffix: &str) -> &'a str {
    if !suffix.is_empty() && stream_id.len() > suffix.len() && stream_id.ends_with(suffix) {
        &stream_id[..stream_id.len() - suffix.len()]
    } else {
        stream_id
    }
}
