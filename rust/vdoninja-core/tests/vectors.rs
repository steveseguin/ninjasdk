use serde_json::Value;
use vdoninja_core::crypto::{
    decrypt_message, encrypt_message, encrypt_with_iv, generate_hash, hash_room, hash_stream_id,
    stream_hash_suffix,
};
use vdoninja_core::sanitize::{
    sanitize_label, sanitize_password, sanitize_room, sanitize_stream_id,
};
use vdoninja_core::turn::{fallback_turn_servers, select_turn_servers};

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("spec/vectors.json")).unwrap()
}

fn s(v: &Value, k: &str) -> String {
    v[k].as_str().unwrap().to_string()
}

#[test]
fn hash_vectors() {
    for c in vectors()["hash"].as_array().unwrap() {
        assert_eq!(
            generate_hash(&s(c, "input"), c["length"].as_u64().unwrap() as usize),
            s(c, "expected")
        );
    }
}

#[test]
fn stream_and_room_hash_vectors() {
    let v = vectors();
    for c in v["streamHash"].as_array().unwrap() {
        let pw = sanitize_password(&s(c, "rawPassword"));
        assert_eq!(pw, s(c, "sanitizedPassword"));
        assert_eq!(stream_hash_suffix(&pw, &s(c, "salt")), s(c, "hashSuffix"));
        assert_eq!(
            hash_stream_id(&s(c, "streamID"), &pw, &s(c, "salt")),
            s(c, "hashedStreamID")
        );
    }
    for c in v["roomHash"].as_array().unwrap() {
        assert_eq!(
            hash_room(
                &s(c, "room"),
                &sanitize_password(&s(c, "rawPassword")),
                &s(c, "salt")
            ),
            s(c, "hashedRoom")
        );
    }
}

#[test]
fn encryption_vectors() {
    for c in vectors()["encryption"].as_array().unwrap() {
        let phrase = format!(
            "{}{}",
            sanitize_password(&s(c, "rawPassword")),
            s(c, "salt")
        );
        assert_eq!(phrase, s(c, "phrase"));
        let iv: [u8; 16] = hex::decode(s(c, "ivHex")).unwrap().try_into().unwrap();
        let ct = encrypt_with_iv(s(c, "plaintext").as_bytes(), &phrase, &iv);
        assert_eq!(hex::encode(ct), s(c, "ciphertextHex"));
        assert_eq!(
            decrypt_message(&s(c, "ciphertextHex"), &s(c, "ivHex"), &phrase).unwrap(),
            s(c, "plaintext")
        );
        let (enc, iv2) = encrypt_message(&s(c, "plaintext"), &phrase);
        assert_eq!(
            decrypt_message(&enc, &iv2, &phrase).unwrap(),
            s(c, "plaintext")
        );
    }
    assert!(decrypt_message(&"00".repeat(16), &"00".repeat(16), "wrong").is_err());
}

#[test]
fn sanitize_vectors() {
    let v = vectors();
    for c in v["sanitizeStreamID"].as_array().unwrap() {
        assert_eq!(sanitize_stream_id(&s(c, "input")), s(c, "expected"));
    }
    for c in v["sanitizeRoom"].as_array().unwrap() {
        assert_eq!(sanitize_room(&s(c, "input")), s(c, "expected"));
    }
    for c in v["sanitizePassword"].as_array().unwrap() {
        assert_eq!(sanitize_password(&s(c, "input")), s(c, "expected"));
    }
    for c in v["sanitizeLabel"].as_array().unwrap() {
        assert_eq!(sanitize_label(&s(c, "input")), s(c, "expected"));
    }
    assert_eq!(sanitize_stream_id("").len(), 12);
}

#[test]
fn turn_selection() {
    let picked = select_turn_servers(&fallback_turn_servers(), 300, false);
    assert_eq!(picked.len(), 3);
    assert_eq!(
        picked
            .iter()
            .filter(|s| s.urls[0].starts_with("turn:"))
            .count(),
        2
    );
    assert_eq!(
        select_turn_servers(&fallback_turn_servers(), 300, true).len(),
        1
    );
}
