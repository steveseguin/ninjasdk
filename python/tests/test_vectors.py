import hashlib
import json
import os

from vdoninja import crypto, sanitize

VECTORS = os.path.join(os.path.dirname(__file__), "..", "..", "spec", "vectors.json")


def load():
    with open(VECTORS, encoding="utf-8") as fh:
        return json.load(fh)


def test_hash_vectors():
    for case in load()["hash"]:
        assert crypto.generate_hash(case["input"], case["length"]) == case["expected"]


def test_stream_and_room_hash_vectors():
    v = load()
    for case in v["streamHash"]:
        pw = sanitize.sanitize_password(case["rawPassword"])
        assert pw == case["sanitizedPassword"]
        assert crypto.stream_hash_suffix(pw, case["salt"]) == case["hashSuffix"]
        assert crypto.hash_stream_id(case["streamID"], pw, case["salt"]) == case["hashedStreamID"]
    for case in v["roomHash"]:
        assert crypto.hash_room(case["room"], sanitize.sanitize_password(case["rawPassword"]), case["salt"]) == case["hashedRoom"]


def test_encryption_vectors():
    for case in load()["encryption"]:
        phrase = sanitize.sanitize_password(case["rawPassword"]) + case["salt"]
        assert phrase == case["phrase"]
        assert hashlib.sha256(phrase.encode()).hexdigest() == case["keyHex"]
        ct = crypto.encrypt_with_iv(case["plaintext"], phrase, bytes.fromhex(case["ivHex"]))
        assert ct.hex() == case["ciphertextHex"]
        assert crypto.decrypt_message(case["ciphertextHex"], case["ivHex"], phrase) == case["plaintext"]
        enc, iv = crypto.encrypt_message(case["plaintext"], phrase)
        assert crypto.decrypt_message(enc, iv, phrase) == case["plaintext"]


def test_sanitize_vectors():
    v = load()
    for case in v["sanitizeStreamID"]:
        assert sanitize.sanitize_stream_id(case["input"]) == case["expected"]
    for case in v["sanitizeRoom"]:
        assert sanitize.sanitize_room(case["input"]) == case["expected"]
    for case in v["sanitizePassword"]:
        assert sanitize.sanitize_password(case["input"]) == case["expected"]
    for case in v["sanitizeLabel"]:
        assert sanitize.sanitize_label(case["input"]) == case["expected"]
    assert len(sanitize.sanitize_stream_id("")) == 12


def test_turn_selection():
    from vdoninja.turn import FALLBACK_TURN_SERVERS, select_turn_servers

    picked = select_turn_servers(FALLBACK_TURN_SERVERS, 300)
    assert len(picked) == 3
    assert sum(1 for s in picked if s.urls[0].startswith("turn:")) == 2
    assert len(select_turn_servers(FALLBACK_TURN_SERVERS, 300, force_tcp=True)) == 1


def test_link_header_parsing():
    from vdoninja.whip import parse_ice_servers_from_link

    servers = parse_ice_servers_from_link('<stun:stun.example.com>; rel="ice-server", <turn:turn.example.com:3478?transport=udp>; rel="ice-server"; username="u"; credential="c"')
    assert len(servers) == 2 and servers[1].username == "u" and servers[1].credential == "c"
