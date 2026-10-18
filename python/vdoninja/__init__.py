# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.
"""VDO.Ninja SDK for Python.

Publish, view and exchange data with VDO.Ninja peers over WebRTC (aiortc) using
VDO.Ninja's hosted or a self-hosted signaling server.

Hosted-service notice: use of signaling, TURN and related services operated by
Steve Seguin is subject to the applicable Terms of Service and operational
policies. This SDK is the supported way to use them; only WebRTC handshake data
may pass through the signaling server.
"""

from .crypto import (
    decrypt_message,
    encrypt_message,
    generate_hash,
    hash_room,
    hash_stream_id,
    stream_hash_suffix,
)
from .sanitize import (
    encode_uri_component,
    sanitize_label,
    sanitize_password,
    sanitize_room,
    sanitize_stream_id,
)
from .sdk import (
    DEFAULT_HOST,
    DEFAULT_PASSWORD,
    DEFAULT_SALT,
    Connection,
    Event,
    FileEntry,
    FileResult,
    PeerQuality,
    StreamNotYetAvailable,
    VDONinja,
    VDONinjaError,
)
from .turn import fetch_turn_servers, select_turn_servers
from .whip import WHEPClient, WHIPClient

__version__ = "0.1.0"

__all__ = [
    "VDONinja",
    "VDONinjaError",
    "StreamNotYetAvailable",
    "Connection",
    "Event",
    "FileEntry",
    "FileResult",
    "PeerQuality",
    "WHIPClient",
    "WHEPClient",
    "DEFAULT_HOST",
    "DEFAULT_PASSWORD",
    "DEFAULT_SALT",
    "generate_hash",
    "stream_hash_suffix",
    "hash_stream_id",
    "hash_room",
    "encrypt_message",
    "decrypt_message",
    "sanitize_stream_id",
    "sanitize_room",
    "sanitize_label",
    "sanitize_password",
    "encode_uri_component",
    "fetch_turn_servers",
    "select_turn_servers",
]
