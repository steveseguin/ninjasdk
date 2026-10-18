# VDO.Ninja SDK licensing and ownership

Copyright (c) 2025-2026 Steve Seguin. All rights reserved except as expressly licensed below.

## SDK core: MPL-2.0

The following SDK core files are licensed by Steve Seguin under the Mozilla Public License 2.0 (`MPL-2.0`):

- `vdoninja-sdk.js`
- `vdoninja-sdk.min.js`
- `vdoninja-sdk.d.ts`
- the native SDK sources under `go/` (package `vdoninja` including its WHIP/WHEP clients, except `go/examples/`), `rust/` (crates `vdoninja-core` and `vdoninja`, except `rust/vdoninja/src/whip.rs` and `rust/vdoninja/examples/`), `c/` (`c/include/`, `c/src/`), `python/` (package `vdoninja`, except `python/vdoninja/whip.py` and `python/examples/`), `dart/` (packages `vdoninja_core` and `vdoninja`, except `dart/vdoninja/example/`), `kotlin/` (modules `vdoninja-core` and `vdoninja-android`) and `swift/` (targets `VDONinjaCore` and `VDONinja`)
- `spec/` (protocol conformance vectors and their generator)

The full MPL-2.0 terms are in [LICENSE](LICENSE). Distribution must preserve the applicable notices and make the MPL-covered source available as required by MPL-2.0. Distributed modifications to these files remain subject to the MPL-2.0 source-code and notice requirements. The SDK is not designated "Incompatible With Secondary Licenses," preserving MPL-2.0 compatibility with VDO.Ninja's AGPL-3.0 code.

## MIT components

The following wrappers and companion clients are licensed under the [MIT License](LICENSE-MIT):

- `vdoninja-sdk-node.js`
- `vdoninja-sdk-node.d.ts`
- `webrtc-adapter.js`
- `whip-client.js`
- `whep-client.js`
- the Rust and Python WHIP/WHEP clients (`rust/vdoninja/src/whip.rs`, `python/vdoninja/whip.py`) and their examples (`go/examples/`, `rust/vdoninja/examples/`, `c/examples/`, `python/examples/`, `dart/vdoninja/example/`, `spec/interop/`)

The Node wrapper loads and extends the MPL-2.0 SDK core. Its MIT license applies only to the wrapper; it does not relicense the SDK core.

Files under [`demos/`](demos/) are separately licensed under [LICENSE-DEMOS](LICENSE-DEMOS). The root SDK landing-page demo (`index.html` and `style.css`) is also MIT licensed. The separately published [`@vdoninja/mcp`](https://github.com/steveseguin/ninjamcp) wrapper is MIT licensed under its own license and is not part of this SDK repository or npm package. An MIT-licensed wrapper or example does not relicense SDK core or third-party code that it loads, imports, embeds, or references.

The native SDKs are built on third-party WebRTC engines that are dependencies, not part of this repository: pion/webrtc (MIT), webrtc-rs (MIT/Apache-2.0), libdatachannel (MPL-2.0, downloaded at build time), aiortc (BSD-3-Clause), flutter_webrtc (MIT), Google's libwebrtc as packaged by Stream for Android and by stasel/WebRTC for Apple platforms (BSD-3-Clause), OkHttp (Apache-2.0) and the Dart `crypto`/`pointycastle`/`web_socket_channel`/`http` packages (BSD-3-Clause / MIT). The C SDK vendors cJSON (MIT) under `c/third_party/cJSON/` with its license file. VDO.Ninja itself is AGPL-3.0; the SDKs are independent implementations of its client protocol and contain no VDO.Ninja code.

Third-party components retain their own copyright and license notices. An express file- or directory-specific notice controls for that component.

## Steve Seguin's retained rights

Contributions are accepted under the [Contributor License Agreement](CLA.md), which assigns contribution rights to Steve Seguin and preserves his ability to enforce, relicense, and commercially license the project. No additional permission or alternative license is granted unless Steve Seguin expressly grants it in writing.

No trademark rights are granted. These software licenses do not grant rights to the VDO.Ninja name, logos, domains, trade dress, or other branding, and do not authorize claims of affiliation, sponsorship, endorsement, or official status.

These software licenses also do not grant a contractual right to access or use infrastructure or services operated by Steve Seguin, including signaling, STUN/TURN, relay, or hosted API endpoints. Hosted-service access is separate from the software licenses, is governed by applicable Terms of Service and operational policies, and may be limited, suspended, or withdrawn by the service operator.

Alternative proprietary or commercial licensing for first-party code owned or controlled by Steve Seguin may be available only by written agreement with Steve Seguin.
