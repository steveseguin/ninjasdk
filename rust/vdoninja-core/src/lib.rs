// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

//! Engine-agnostic protocol core for the VDO.Ninja SDK.
//!
//! This crate contains everything about the VDO.Ninja wire protocol that does
//! not depend on a WebRTC implementation or an async runtime: SHA-256 based
//! room/stream hashing, AES-256-CBC signaling encryption, ID sanitization,
//! TURN server selection and the JSON message shapes. The [`vdoninja`] crate
//! builds the full SDK on top of it using `webrtc-rs`; other engines (GStreamer
//! `webrtcbin`, `str0m`, libdatachannel bindings) can reuse this crate directly.
//!
//! [`vdoninja`]: https://crates.io/crates/vdoninja

pub mod crypto;
pub mod protocol;
pub mod sanitize;
pub mod turn;

pub use crypto::{
    decrypt_message, encrypt_message, generate_hash, generate_session, generate_stream_id,
    generate_uuid, hash_room, hash_stream_id, stream_hash_suffix,
};
pub use sanitize::{
    encode_uri_component, sanitize_label, sanitize_meta, sanitize_password, sanitize_room,
    sanitize_stream_id,
};

/// Default hosted signaling server.
pub const DEFAULT_HOST: &str = "wss://wss.vdo.ninja";
/// Default shared password (not private; choose your own for private rooms).
pub const DEFAULT_PASSWORD: &str = "someEncryptionKey123";
/// Default salt. Use `vdo.ninja` to interoperate with https://vdo.ninja peers.
pub const DEFAULT_SALT: &str = "vdo.ninja";
/// Hosted TURN list endpoint.
pub const DEFAULT_TURN_URL: &str = "https://turnservers.vdo.ninja/";
/// Default STUN servers.
pub const DEFAULT_STUN_SERVERS: [&str; 2] = [
    "stun:stun.l.google.com:19302",
    "stun:stun.cloudflare.com:3478",
];

/// The only data channel that carries the JSON control protocol.
pub const CONTROL_CHANNEL_LABEL: &str = "sendChannel";
/// VDO.Ninja chunked media side channel (not implemented by the SDKs).
pub const CHUNKED_CHANNEL_LABEL: &str = "chunked";
/// VDO.Ninja resources side channel.
pub const RESOURCES_CHANNEL_LABEL: &str = "resources";
/// Labels with this prefix are reserved for SDK channels and ignored by VDO.Ninja.
pub const RESERVED_CHANNEL_PREFIX: &str = "x-";
/// Default lane for raw binary payloads.
pub const BINARY_CHANNEL_LABEL: &str = "x-bin";
/// Chunk size of VDO.Ninja's native file transfer.
pub const FILE_CHUNK_SIZE: usize = 16384;
/// File transfer terminators.
pub const FILE_EOF_COMPLETE: &str = "EOF1";
pub const FILE_EOF_CANCELLED: &str = "EOF2";
