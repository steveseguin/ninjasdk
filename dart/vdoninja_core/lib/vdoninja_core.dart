// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// VDO.Ninja protocol core: everything the SDK needs that is not WebRTC.
///
/// Hashing, AES-CBC signaling encryption, ID sanitization, the signaling
/// socket with reconnect, TURN selection, options and events. The Flutter
/// package `vdoninja` adds the WebRTC engine on top.
library;

export 'src/crypto.dart';
export 'src/events.dart';
export 'src/options.dart';
export 'src/protocol.dart';
export 'src/sanitize.dart';
export 'src/signaling.dart';
export 'src/turn.dart';
