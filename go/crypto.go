// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0
//
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at https://mozilla.org/MPL/2.0/.

package vdoninja

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
)

// GenerateHash returns the hex SHA-256 of str, truncated to length hex
// characters (length/2 bytes, so odd lengths round down). A length of 0
// returns the full 64-character digest. This matches VDO.Ninja's generateHash.
func GenerateHash(str string, length int) string {
	sum := sha256.Sum256([]byte(str))
	full := hex.EncodeToString(sum[:])
	if length <= 0 {
		return full
	}
	n := (length / 2) * 2
	if n > len(full) {
		n = len(full)
	}
	return full[:n]
}

// StreamHashSuffix returns the 6-character suffix appended to stream IDs when a
// password is in use: sha256(sanitizedPassword + salt)[:6].
func StreamHashSuffix(sanitizedPassword, salt string) string {
	return GenerateHash(sanitizedPassword+salt, 6)
}

// HashStreamID appends the password/salt suffix to a (sanitized) stream ID.
func HashStreamID(streamID, sanitizedPassword, salt string) string {
	return streamID + StreamHashSuffix(sanitizedPassword, salt)
}

// HashRoom returns the 16-character room hash: sha256(room + password + salt)[:16].
func HashRoom(room, sanitizedPassword, salt string) string {
	return GenerateHash(room+sanitizedPassword+salt, 16)
}

// EncryptMessage encrypts plaintext with AES-256-CBC (PKCS#7 padding) using
// key = SHA-256(phrase). It returns the ciphertext and the random IV, both as
// lowercase hex strings, exactly as VDO.Ninja places them in the "description"
// / "candidates" and "vector" fields.
func EncryptMessage(plaintext, phrase string) (ciphertextHex, ivHex string, err error) {
	iv := make([]byte, aes.BlockSize)
	if _, err = rand.Read(iv); err != nil {
		return "", "", err
	}
	ct, err := encryptWithIV([]byte(plaintext), phrase, iv)
	if err != nil {
		return "", "", err
	}
	return hex.EncodeToString(ct), hex.EncodeToString(iv), nil
}

func encryptWithIV(plaintext []byte, phrase string, iv []byte) ([]byte, error) {
	key := sha256.Sum256([]byte(phrase))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	padLen := aes.BlockSize - len(plaintext)%aes.BlockSize
	padded := make([]byte, len(plaintext)+padLen)
	copy(padded, plaintext)
	for i := len(plaintext); i < len(padded); i++ {
		padded[i] = byte(padLen)
	}
	out := make([]byte, len(padded))
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(out, padded)
	return out, nil
}

// DecryptMessage reverses EncryptMessage.
func DecryptMessage(ciphertextHex, ivHex, phrase string) (string, error) {
	ct, err := hex.DecodeString(ciphertextHex)
	if err != nil {
		return "", fmt.Errorf("vdoninja: bad ciphertext hex: %w", err)
	}
	iv, err := hex.DecodeString(ivHex)
	if err != nil {
		return "", fmt.Errorf("vdoninja: bad iv hex: %w", err)
	}
	if len(iv) != aes.BlockSize || len(ct) == 0 || len(ct)%aes.BlockSize != 0 {
		return "", errors.New("vdoninja: ciphertext/iv length invalid")
	}
	key := sha256.Sum256([]byte(phrase))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return "", err
	}
	out := make([]byte, len(ct))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, ct)
	padLen := int(out[len(out)-1])
	if padLen == 0 || padLen > aes.BlockSize || padLen > len(out) {
		return "", errors.New("vdoninja: bad padding (wrong password or salt?)")
	}
	for _, b := range out[len(out)-padLen:] {
		if int(b) != padLen {
			return "", errors.New("vdoninja: bad padding (wrong password or salt?)")
		}
	}
	return string(out[:len(out)-padLen]), nil
}

// generateStreamID returns a random 12-character lowercase alphanumeric ID,
// matching the character set used by VDO.Ninja (no punctuation, so it can never
// collide with the reserved "x-" channel namespace).
func generateStreamID() string {
	const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz"
	b := make([]byte, 12)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// generateSession returns an 8-character alphanumeric WebRTC session ID.
func generateSession() string {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, 8)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = alphabet[int(b[i])%len(alphabet)]
	}
	return string(b)
}

// generateUUID returns a random RFC 4122 version 4 UUID string.
func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
