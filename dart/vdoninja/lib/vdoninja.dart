// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

/// VDO.Ninja SDK for Flutter.
///
/// ```dart
/// final vdo = VdoNinja(const VdoNinjaOptions(password: 'secret'));
/// await vdo.connect();
/// final stream = await navigator.mediaDevices.getUserMedia({'audio': true, 'video': true});
/// await vdo.publish(stream, streamId: 'my-phone');
/// ```
library;

export 'package:vdoninja_core/vdoninja_core.dart';

export 'src/vdoninja.dart';
