// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

type vectors struct {
	Hash []struct {
		Input    string `json:"input"`
		Length   int    `json:"length"`
		Expected string `json:"expected"`
	} `json:"hash"`
	StreamHash []struct {
		RawPassword       string `json:"rawPassword"`
		SanitizedPassword string `json:"sanitizedPassword"`
		Salt              string `json:"salt"`
		StreamID          string `json:"streamID"`
		HashSuffix        string `json:"hashSuffix"`
		HashedStreamID    string `json:"hashedStreamID"`
	} `json:"streamHash"`
	RoomHash []struct {
		RawPassword string `json:"rawPassword"`
		Salt        string `json:"salt"`
		Room        string `json:"room"`
		HashedRoom  string `json:"hashedRoom"`
	} `json:"roomHash"`
	Encryption []struct {
		RawPassword   string `json:"rawPassword"`
		Salt          string `json:"salt"`
		Phrase        string `json:"phrase"`
		KeyHex        string `json:"keyHex"`
		IVHex         string `json:"ivHex"`
		Plaintext     string `json:"plaintext"`
		CiphertextHex string `json:"ciphertextHex"`
	} `json:"encryption"`
	SanitizeStreamID []struct{ Input, Expected string } `json:"sanitizeStreamID"`
	SanitizeRoom     []struct{ Input, Expected string } `json:"sanitizeRoom"`
	SanitizePassword []struct{ Input, Expected string } `json:"sanitizePassword"`
	SanitizeLabel    []struct{ Input, Expected string } `json:"sanitizeLabel"`
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	b, err := os.ReadFile(filepath.Join("..", "spec", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var v vectors
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	return v
}

func TestVectorsHash(t *testing.T) {
	for _, c := range loadVectors(t).Hash {
		if got := GenerateHash(c.Input, c.Length); got != c.Expected {
			t.Errorf("GenerateHash(%q,%d)=%q want %q", c.Input, c.Length, got, c.Expected)
		}
	}
}

func TestVectorsStreamAndRoomHash(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.StreamHash {
		p := SanitizePassword(c.RawPassword)
		if p != c.SanitizedPassword {
			t.Errorf("SanitizePassword(%q)=%q want %q", c.RawPassword, p, c.SanitizedPassword)
		}
		if got := StreamHashSuffix(p, c.Salt); got != c.HashSuffix {
			t.Errorf("suffix for %q/%q=%q want %q", c.RawPassword, c.Salt, got, c.HashSuffix)
		}
		if got := HashStreamID(c.StreamID, p, c.Salt); got != c.HashedStreamID {
			t.Errorf("HashStreamID=%q want %q", got, c.HashedStreamID)
		}
	}
	for _, c := range v.RoomHash {
		if got := HashRoom(c.Room, SanitizePassword(c.RawPassword), c.Salt); got != c.HashedRoom {
			t.Errorf("HashRoom(%q)=%q want %q", c.Room, got, c.HashedRoom)
		}
	}
}

func TestVectorsEncryption(t *testing.T) {
	for _, c := range loadVectors(t).Encryption {
		phrase := SanitizePassword(c.RawPassword) + c.Salt
		if phrase != c.Phrase {
			t.Errorf("phrase=%q want %q", phrase, c.Phrase)
		}
		key := sha256.Sum256([]byte(phrase))
		if hex.EncodeToString(key[:]) != c.KeyHex {
			t.Errorf("key mismatch for %q", c.RawPassword)
		}
		iv, _ := hex.DecodeString(c.IVHex)
		ct, err := encryptWithIV([]byte(c.Plaintext), phrase, iv)
		if err != nil {
			t.Fatal(err)
		}
		if hex.EncodeToString(ct) != c.CiphertextHex {
			t.Errorf("ciphertext mismatch for %q: got %s", c.Plaintext, hex.EncodeToString(ct))
		}
		plain, err := DecryptMessage(c.CiphertextHex, c.IVHex, phrase)
		if err != nil || plain != c.Plaintext {
			t.Errorf("decrypt: %v got %q", err, plain)
		}
		// Round trip through the random-IV path.
		enc, iv2, err := EncryptMessage(c.Plaintext, phrase)
		if err != nil {
			t.Fatal(err)
		}
		if back, err := DecryptMessage(enc, iv2, phrase); err != nil || back != c.Plaintext {
			t.Errorf("round trip failed: %v", err)
		}
	}
	if _, err := DecryptMessage("00000000000000000000000000000000", "00000000000000000000000000000000", "wrong"); err == nil {
		t.Error("expected padding error with wrong key")
	}
}

func TestVectorsSanitize(t *testing.T) {
	v := loadVectors(t)
	for _, c := range v.SanitizeStreamID {
		if got := SanitizeStreamID(c.Input); got != c.Expected {
			t.Errorf("SanitizeStreamID(%q)=%q want %q", c.Input, got, c.Expected)
		}
	}
	for _, c := range v.SanitizeRoom {
		if got := SanitizeRoom(c.Input); got != c.Expected {
			t.Errorf("SanitizeRoom(%q)=%q want %q", c.Input, got, c.Expected)
		}
	}
	for _, c := range v.SanitizePassword {
		if got := SanitizePassword(c.Input); got != c.Expected {
			t.Errorf("SanitizePassword(%q)=%q want %q", c.Input, got, c.Expected)
		}
	}
	for _, c := range v.SanitizeLabel {
		if got := SanitizeLabel(c.Input); got != c.Expected {
			t.Errorf("SanitizeLabel(%q)=%q want %q", c.Input, got, c.Expected)
		}
	}
	if id := SanitizeStreamID(""); len(id) != 12 {
		t.Errorf("generated stream id length %d", len(id))
	}
}

func TestTURNSelection(t *testing.T) {
	sel := SelectTURNServers(fallbackTURNServers, 300, false)
	if len(sel) != 3 {
		t.Fatalf("expected 3 servers, got %d", len(sel))
	}
	udp := 0
	for _, s := range sel {
		for _, u := range s.URLs {
			if u[:5] == "turn:" {
				udp++
			}
		}
	}
	if udp != 2 {
		t.Errorf("expected 2 udp servers, got %d", udp)
	}
	if tcpOnly := SelectTURNServers(fallbackTURNServers, 300, true); len(tcpOnly) != 1 {
		t.Errorf("forceTCP should select 1 server, got %d", len(tcpOnly))
	}
}

func TestParseICEServersFromLink(t *testing.T) {
	srv := ParseICEServersFromLink(`<stun:stun.example.com>; rel="ice-server", <turn:turn.example.com:3478?transport=udp>; rel="ice-server"; username="u"; credential="c"`)
	if len(srv) != 2 || srv[1].Username != "u" || srv[1].Credential != "c" {
		t.Errorf("unexpected parse: %+v", srv)
	}
}
