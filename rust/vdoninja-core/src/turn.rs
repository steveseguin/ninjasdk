// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

//! TURN list format and selection (closest by timezone: up to 2 UDP + 1 TCP).

use serde::{Deserialize, Serialize};

/// One entry of the hosted TURN list.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct TurnServer {
    pub username: String,
    pub credential: String,
    #[serde(deserialize_with = "deserialize_urls")]
    pub urls: Vec<String>,
    #[serde(default)]
    pub tz: i64,
    #[serde(default)]
    pub udp: bool,
    #[serde(default)]
    pub locale: String,
}

fn deserialize_urls<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Vec<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum Urls {
        Single(String),
        Multiple(Vec<String>),
    }
    Ok(match Urls::deserialize(deserializer)? {
        Urls::Single(url) => vec![url],
        Urls::Multiple(urls) => urls,
    })
}

/// Response body of the hosted TURN endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnList {
    pub servers: Vec<TurnServer>,
}

/// A selected ICE server (engine-agnostic).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IceServer {
    pub urls: Vec<String>,
    pub username: String,
    pub credential: String,
}

fn ts(username: &str, credential: &str, url: &str, tz: i64, udp: bool, locale: &str) -> TurnServer {
    TurnServer {
        username: username.into(),
        credential: credential.into(),
        urls: vec![url.into()],
        tz,
        udp,
        locale: locale.into(),
    }
}

/// Built-in list used when the hosted endpoint is unreachable (mirrors the JavaScript SDK).
pub fn fallback_turn_servers() -> Vec<TurnServer> {
    vec![
        ts(
            "steve",
            "setupYourOwnPlease",
            "turns:www.turn.obs.ninja:443",
            300,
            false,
            "cae1",
        ),
        ts(
            "steve",
            "setupYourOwnPlease",
            "turn:turn-cae1.vdo.ninja:3478",
            300,
            true,
            "cae1",
        ),
        ts(
            "vdoninja",
            "theyBeSharksHere",
            "turn:turn-usw2.vdo.ninja:3478",
            480,
            true,
            "usw2",
        ),
        ts(
            "vdoninja",
            "PolandPirat",
            "turn:turn-eu4.vdo.ninja:3478",
            -70,
            true,
            "pol1",
        ),
        ts(
            "steve",
            "setupYourOwnPlease",
            "turns:turn.obs.ninja:443",
            -60,
            false,
            "de1",
        ),
        ts(
            "steve",
            "setupYourOwnPlease",
            "turn:turn-eu1.vdo.ninja:3478",
            -60,
            true,
            "de1",
        ),
        ts(
            "vdoninja",
            "EastSideRepresentZ",
            "turn:turn-use1.vdo.ninja:3478",
            300,
            true,
            "use1",
        ),
    ]
}

/// Picks the closest servers by timezone offset (minutes, JavaScript's
/// `-getTimezoneOffset()`): up to two UDP servers and one TCP/TLS server.
pub fn select_turn_servers(
    list: &[TurnServer],
    tz_offset_minutes: i64,
    force_tcp: bool,
) -> Vec<IceServer> {
    let mut scored: Vec<(i64, &TurnServer)> = list
        .iter()
        .map(|s| {
            let mut delta = (s.tz - tz_offset_minutes).abs();
            let wrapped = (delta - 60 * 24).abs();
            if wrapped < delta {
                delta = wrapped;
            }
            (delta, s)
        })
        .collect();
    scored.sort_by_key(|(d, _)| *d);
    let (mut udp, mut tcp) = (0, 0);
    let mut out = Vec::new();
    for (_, s) in scored {
        if force_tcp && s.udp {
            continue;
        }
        if s.udp && udp < 2 {
            udp += 1;
        } else if !s.udp && tcp < 1 {
            tcp += 1;
        } else {
            continue;
        }
        out.push(IceServer {
            urls: s.urls.clone(),
            username: s.username.clone(),
            credential: s.credential.clone(),
        });
    }
    out
}
