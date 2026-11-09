import json
from urllib.parse import parse_qs, urlsplit

from vdoninja.turn import fetch_turn_servers


def test_browser_timezone_winter_and_summer(monkeypatch):
    from datetime import datetime
    from zoneinfo import ZoneInfo
    from vdoninja import turn

    # Values evaluated from the official lib.js getTimezone() function.
    for name, expected in [("America/Toronto", 300), ("Europe/Berlin", -60),
                           ("Australia/Sydney", -600), ("Asia/Kolkata", -270)]:
        zone = ZoneInfo(name)
        for month in (1, 7):
            class Clock(datetime):
                @classmethod
                def now(cls):
                    return cls(2026, month, 15, 12)

                def astimezone(self):
                    return self.replace(tzinfo=zone)

            monkeypatch.setattr(turn, "datetime", Clock)
            assert turn.local_timezone_offset_minutes() == expected


def test_discovery_preserves_existing_query(monkeypatch):
    seen = []

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self):
            return json.dumps({"servers": [{"urls": ["turn:fixture.invalid:3478"]}]}).encode()

    def fetch(request, **kwargs):
        seen.append(parse_qs(urlsplit(request.full_url).query, keep_blank_values=True))
        return Response()

    monkeypatch.setattr("vdoninja.turn.urllib.request.urlopen", fetch)
    fetch_turn_servers("https://fixture.invalid/list?region=ca&key=a%2Bb&empty=")
    assert seen[0]["region"] == ["ca"]
    assert seen[0]["key"] == ["a+b"]
    assert seen[0]["empty"] == [""]
    assert seen[0]["ts"][0].isdigit()
