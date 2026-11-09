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

/// Built-in list used when the hosted endpoint is unreachable (mirrors vdo.ninja/webrtc.js).
#[rustfmt::skip] // Generated verbatim by scripts/sync-turn-fallback.cjs.
pub fn fallback_turn_servers() -> Vec<TurnServer> {
    vec![
        ts("use5", "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", "turn:turn-use5.vdo.ninja:3478", 300, true, "use5"),
        ts("use5", "c-5eSrFCaAaMFG11-Ax1r1k61y3RDpFhi3jP5oDXsdc", "turns:turn-use5.vdo.ninja:443", 300, false, "use5"),
        ts("de3", "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", "turn:turn-de3.vdo.ninja:3478", -60, true, "de3"),
        ts("de3", "NR5d6huNQQsVyLx5sYE4V_uxW9xjL9qO-mI0tU5lkXc", "turns:turn-de3.vdo.ninja:443", -60, false, "de3"),
        ts("pl2", "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", "turn:turn-pl2.vdo.ninja:3478", -60, true, "pl2"),
        ts("pl2", "vmYXvwN9C+FeHV7raGixEUctlSRrYAXxjDunAxd8PJg=", "turns:turn-pl2.vdo.ninja:443", -60, false, "pl2"),
        ts("vdoninja", "EastSideRepresentZ", "turn:turn-use3.vdo.ninja:3478", 300, true, "use3"),
        ts("vdoninja", "EastSideRepresentZ", "turns:turn-use3.vdo.ninja:443", 300, false, "use3"),
        ts("vdoninja", "ViennaSchnitzel", "turn:turn-eu5.vdo.ninja:3478", -60, true, "eu5"),
        ts("vdoninja", "ViennaSchnitzel", "turns:turn-eu5.vdo.ninja:443", -60, false, "eu5"),
        ts("vdoninja", "donotuseplease", "turn:turn-usw3.vdo.ninja:3478", 480, true, "usw3"),
        ts("vdoninja", "donotuseplease", "turns:turn-usw3.vdo.ninja:443", 480, false, "usw3"),
        ts("vdoninja", "donotuseplease", "turn:turn-usw4.vdo.ninja:3478", 480, true, "usw4"),
        ts("vdoninja", "donotuseplease", "turns:turn-usw4.vdo.ninja:443", 480, false, "usw4"),
        ts("vdoninja", "donotuseplease", "turn:turn-usw5.vdo.ninja:3478", 480, true, "usw5"),
        ts("vdoninja", "donotuseplease", "turns:turn-usw5.vdo.ninja:443", 480, false, "usw5"),
        ts("vdoninja", "donotuseplease", "turn:turn-fr1.vdo.ninja:3478", -60, true, "fr1"),
        ts("vdoninja", "donotuseplease", "turns:turn-fr1.vdo.ninja:443", -60, false, "fr1"),
        ts("vdoninja", "donotuseplease", "turn:turn-fr2.vdo.ninja:3478", -60, true, "fr2"),
        ts("vdoninja", "donotuseplease", "turns:turn-fr2.vdo.ninja:443", -60, false, "fr2"),
        ts("vdoninja", "IchBinSteveDerNinja", "turn:www.turn.vdo.ninja:3478", -60, true, "de2"),
        ts("vdoninja", "IchBinSteveDerNinja", "turns:www.turn.vdo.ninja:443", -60, false, "de2"),
        ts("vdoninja", "EastSideRepresentZ", "turn:turn-use1.vdo.ninja:3478", 300, true, "use1"),
        ts("vdoninja", "EastSideRepresentZ", "turns:turn-use1.vdo.ninja:443", 300, false, "use1"),
        ts("vdoninja", "pleaseUseYourOwn", "turn:turn-use2.vdo.ninja:3478", 300, true, "use2"),
        ts("vdoninja", "pleaseUseYourOwn", "turns:turn-use2.vdo.ninja:443", 300, false, "use2"),
    ]
}

/// Picks the closest servers by timezone offset (minutes, west of UTC): up to two UDP servers and one TCP/TLS server.
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
