// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"strings"
	"unicode/utf8"
)

// isWordByte reports whether b matches JavaScript's \w (ASCII only).
func isWordByte(b byte) bool {
	return (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') || b == '_'
}

// replaceNonWord replaces every run of non-\w characters with a single "_",
// matching JavaScript's s.replace(/[\W]+/g, "_"). Multi-byte UTF-8 sequences
// are treated as one run of non-word characters per code point.
func replaceNonWord(s string) string {
	var b strings.Builder
	b.Grow(len(s))
	inRun := false
	for _, r := range s {
		if r < utf8.RuneSelf && isWordByte(byte(r)) {
			b.WriteByte(byte(r))
			inRun = false
			continue
		}
		if !inRun {
			b.WriteByte('_')
			inRun = true
		}
	}
	return b.String()
}

// SanitizeStreamID applies VDO.Ninja's stream ID rules: trim, replace runs of
// non [A-Za-z0-9_] with "_", truncate to 64 characters. An empty result yields a
// freshly generated random ID.
func SanitizeStreamID(streamID string) string {
	streamID = strings.TrimSpace(streamID)
	if streamID == "" {
		return generateStreamID()
	}
	s := replaceNonWord(streamID)
	if len(s) > 64 {
		s = s[:64]
	}
	return s
}

// SanitizeRoom applies VDO.Ninja's room name rules (same as stream IDs but
// truncated to 30 characters). An empty input stays empty.
func SanitizeRoom(room string) string {
	room = strings.TrimSpace(room)
	if room == "" {
		return ""
	}
	s := replaceNonWord(room)
	if len(s) > 30 {
		s = s[:30]
	}
	return s
}

// SanitizeLabel trims, removes line breaks and truncates a label to 100
// characters, mirroring the SDK's DOM-based sanitizer.
func SanitizeLabel(label string) string {
	label = strings.NewReplacer("\r", "", "\n", "").Replace(label)
	if n := utf8.RuneCountInString(label); n > 100 {
		runes := []rune(label)
		label = string(runes[:100])
	}
	return strings.TrimSpace(label)
}

// EncodeURIComponent reproduces JavaScript's encodeURIComponent: everything
// except A-Z a-z 0-9 - _ . ! ~ * ' ( ) is percent-encoded as UTF-8 bytes.
func EncodeURIComponent(s string) string {
	const hexDigits = "0123456789ABCDEF"
	var b strings.Builder
	b.Grow(len(s) * 3)
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
			c == '-' || c == '_' || c == '.' || c == '!' || c == '~' || c == '*' || c == '\'' || c == '(' || c == ')' {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hexDigits[c>>4])
		b.WriteByte(hexDigits[c&0x0f])
	}
	return b.String()
}

// SanitizePassword trims the password and URL-encodes it once, which is the
// form VDO.Ninja hashes and derives encryption keys from. Pass the original
// password text; do not pre-encode it.
func SanitizePassword(password string) string {
	password = strings.TrimSpace(password)
	if password == "" {
		return ""
	}
	return EncodeURIComponent(password)
}

// sanitizeMeta mirrors the SDK's shape-preserving meta sanitizer: strings are
// label-sanitized, numbers/bools pass through, nested maps are allowed one
// level deep, anything else is dropped. A non-map, non-string input yields nil.
func sanitizeMeta(meta any, depth int) any {
	switch v := meta.(type) {
	case string:
		return SanitizeLabel(v)
	case map[string]any:
		if depth > 1 {
			return nil
		}
		out := make(map[string]any, len(v))
		fields := 0
		for k, val := range v {
			if fields >= 32 {
				break
			}
			fields++
			key := SanitizeLabel(k)
			if key == "" {
				continue
			}
			switch x := val.(type) {
			case string:
				out[key] = SanitizeLabel(x)
			case bool, int, int32, int64, float32, float64, uint, uint32, uint64:
				out[key] = x
			case map[string]any:
				if nested := sanitizeMeta(x, depth+1); nested != nil {
					out[key] = nested
				}
			}
		}
		return out
	default:
		return nil
	}
}
