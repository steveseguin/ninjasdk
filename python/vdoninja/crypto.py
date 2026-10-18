# Copyright (c) 2025-2026 Steve Seguin
# SPDX-License-Identifier: MPL-2.0
"""Hashing and AES-CBC helpers matching VDO.Ninja's signaling encryption."""

from __future__ import annotations

import hashlib
import os
from typing import Tuple

from cryptography.hazmat.primitives import padding
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


def generate_hash(value: str, length: int = 0) -> str:
    """Hex SHA-256 of ``value`` truncated to ``length`` hex chars (length//2 bytes)."""
    digest = hashlib.sha256(value.encode("utf-8")).digest()
    if length and length > 0:
        digest = digest[: length // 2]
    return digest.hex()


def stream_hash_suffix(sanitized_password: str, salt: str) -> str:
    """The 6-char suffix appended to stream IDs when a password is in use."""
    return generate_hash(sanitized_password + salt, 6)


def hash_stream_id(stream_id: str, sanitized_password: str, salt: str) -> str:
    return stream_id + stream_hash_suffix(sanitized_password, salt)


def hash_room(room: str, sanitized_password: str, salt: str) -> str:
    """16-char room hash: sha256(room + password + salt)[:16]."""
    return generate_hash(room + sanitized_password + salt, 16)


def _key(phrase: str) -> bytes:
    return hashlib.sha256(phrase.encode("utf-8")).digest()


def encrypt_with_iv(plaintext: str, phrase: str, iv: bytes) -> bytes:
    padder = padding.PKCS7(128).padder()
    padded = padder.update(plaintext.encode("utf-8")) + padder.finalize()
    encryptor = Cipher(algorithms.AES(_key(phrase)), modes.CBC(iv)).encryptor()
    return encryptor.update(padded) + encryptor.finalize()


def encrypt_message(plaintext: str, phrase: str) -> Tuple[str, str]:
    """AES-256-CBC encrypt; returns (ciphertext_hex, iv_hex) like the JS SDK."""
    iv = os.urandom(16)
    return encrypt_with_iv(plaintext, phrase, iv).hex(), iv.hex()


def decrypt_message(ciphertext_hex: str, iv_hex: str, phrase: str) -> str:
    ct = bytes.fromhex(ciphertext_hex)
    iv = bytes.fromhex(iv_hex)
    if len(iv) != 16 or not ct or len(ct) % 16:
        raise ValueError("invalid ciphertext or iv length")
    decryptor = Cipher(algorithms.AES(_key(phrase)), modes.CBC(iv)).decryptor()
    padded = decryptor.update(ct) + decryptor.finalize()
    unpadder = padding.PKCS7(128).unpadder()
    try:
        plain = unpadder.update(padded) + unpadder.finalize()
    except ValueError as exc:  # wrong password or salt
        raise ValueError("bad padding (wrong password or salt?)") from exc
    return plain.decode("utf-8")


_ALNUM = "0123456789abcdefghijklmnopqrstuvwxyz"
_SESSION = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"


def generate_stream_id() -> str:
    """Random 12-char lowercase alphanumeric ID (never contains punctuation)."""
    return "".join(_ALNUM[b % len(_ALNUM)] for b in os.urandom(12))


def generate_session() -> str:
    return "".join(_SESSION[b % len(_SESSION)] for b in os.urandom(8))
