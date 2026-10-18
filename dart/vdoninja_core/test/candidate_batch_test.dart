// Copyright (c) 2025-2026 Steve Seguin. SPDX-License-Identifier: MPL-2.0
import 'package:test/test.dart';
import 'package:vdoninja_core/vdoninja_core.dart';

void main() {
  test('queued and immediate candidates respect sessions', () {
    const old = CandidateBatch('old', [IceCandidate('stale')]);
    const fresh = CandidateBatch('new', [IceCandidate('current')]);
    const legacy = CandidateBatch(null, [IceCandidate('legacy')]);
    expect(old.matching('new'), isEmpty);
    expect([old, fresh, legacy].expand((batch) => batch.matching('new')).map((c) => c.candidate),
        ['current', 'legacy']);
    expect(old.matching(''), old.candidates);
    expect(CandidateBatch('', fresh.candidates).matching('new'), fresh.candidates);
  });
}
