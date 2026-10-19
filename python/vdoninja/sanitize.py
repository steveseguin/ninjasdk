# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
"""Stream ID, room, label and password sanitization matching the JavaScript SDK."""

from __future__ import annotations

import re
from typing import Any, Dict, Optional, Union

from .crypto import generate_stream_id

# JavaScript's \W is ASCII-only: anything other than [A-Za-z0-9_].
_NON_WORD = re.compile(r"[^A-Za-z0-9_]+")
_UNRESERVED = set("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")


def sanitize_stream_id(stream_id: Optional[str]) -> str:
    """Trim, replace runs of non-word chars with "_", truncate to 64; empty -> random ID."""
    if not stream_id or not isinstance(stream_id, str):
        return generate_stream_id()
    stream_id = stream_id.strip()
    if not stream_id:
        return generate_stream_id()
    return _NON_WORD.sub("_", stream_id)[:64]


def sanitize_room(room: Optional[str]) -> str:
    """Same rules as stream IDs but truncated to 30 characters; empty stays empty."""
    if room is None:
        return ""
    room = str(room).strip()
    if not room:
        return ""
    return _NON_WORD.sub("_", room)[:30]


def sanitize_label(label: Optional[str]) -> str:
    """Remove line breaks, truncate to 100 characters and trim."""
    if not label or not isinstance(label, str):
        return ""
    label = label.replace("\r", "").replace("\n", "")
    return label[:100].strip()


def encode_uri_component(value: str) -> str:
    """JavaScript encodeURIComponent: percent-encode everything but A-Z a-z 0-9 - _ . ! ~ * ' ( )."""
    out = []
    for byte in value.encode("utf-8"):
        ch = chr(byte)
        if byte < 128 and ch in _UNRESERVED:
            out.append(ch)
        else:
            out.append("%%%02X" % byte)
    return "".join(out)


def sanitize_password(password: Optional[str]) -> str:
    """Trim and URL-encode once; this is the form VDO.Ninja hashes and derives keys from."""
    if password is None:
        return ""
    password = str(password).strip()
    if not password:
        return ""
    return encode_uri_component(password)


def sanitize_meta(meta: Union[str, Dict[str, Any], None], depth: int = 0) -> Union[str, Dict[str, Any], None]:
    """Shape-preserving sanitizer for publisher ``meta`` (VDO.Ninja expects an object)."""
    if isinstance(meta, str):
        return sanitize_label(meta)
    if not isinstance(meta, dict) or depth > 1:
        return None
    out: Dict[str, Any] = {}
    for index, (key, value) in enumerate(meta.items()):
        if index >= 32:
            break
        safe_key = sanitize_label(str(key))
        if not safe_key:
            continue
        if isinstance(value, str):
            out[safe_key] = sanitize_label(value)
        elif isinstance(value, (bool, int, float)):
            out[safe_key] = value
        elif isinstance(value, dict):
            nested = sanitize_meta(value, depth + 1)
            if isinstance(nested, dict):
                out[safe_key] = nested
    return out
