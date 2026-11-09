import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:test/test.dart';
import 'package:vdoninja_core/src/turn.dart';

void main() {
  test('TURN discovery preserves query values, repeats and empty values', () async {
    Uri? requested;
    final client = MockClient((request) async {
      requested = request.url;
      return http.Response('{"servers":[]}', 200);
    });
    await fetchTurnServers(url: 'https://owned.invalid/list?key=a%2Bb&region=one&region=two&empty=&ts=old#part', client: client);
    expect(requested!.queryParametersAll['region'], ['one', 'two']);
    expect(requested!.queryParameters['key'], 'a+b');
    expect(requested!.queryParameters['empty'], '');
    expect(requested!.queryParametersAll['ts']!.length, 1);
    expect(int.tryParse(requested!.queryParameters['ts']!), isNotNull);
    client.close();
  });
}
