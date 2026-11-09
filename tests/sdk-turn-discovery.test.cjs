'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const SDK = require(process.env.VDON_TEST_SDK || '../vdoninja-sdk.js');

test('a long-lived SDK refreshes TURN credentials and coalesces concurrent lookups', async () => {
    const savedNow = Date.now;
    let now = 100000, requests = 0;
    Date.now = () => now;
    try {
        const sdk = new SDK({ turnCacheTTL: 60 });
        sdk._fetchTURNServers = async () => {
            requests++;
            return [{ urls: ['turn:fixture.invalid:3478'], username: 'owned', credential: String(requests), udp: true, tz: 0 }];
        };
        const first = await sdk._getICEConfiguration();
        assert.equal(requests, 1);
        now += 3599999;
        await sdk._getICEConfiguration();
        assert.equal(requests, 1);
        now++;
        const results = await Promise.all(Array.from({ length: 6 }, () => sdk._getICEConfiguration()));
        assert.equal(requests, 2, 'Expired per-instance cache must not permanently retain its first credentials');
        assert.ok(results.every(c => c.iceServers.some(s => s.credential === '2')));
        assert.ok(first.iceServers.some(s => s.credential === '1'), 'Refreshing must not mutate existing peer configuration');
    } finally { Date.now = savedNow; }
});

test('TURN timeout covers a server that sends headers but stalls its body', async () => {
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.flushHeaders();
        res.write('{"servers":[');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const originalFetch = global.fetch;
    let pending, deadline;
    try {
        global.fetch = (_, options) => originalFetch(`http://127.0.0.1:${server.address().port}`, options);
        pending = new SDK({ debug: false })._fetchTURNServers();
        const result = await Promise.race([
            pending,
            new Promise(resolve => { deadline = setTimeout(() => resolve('timed out'), 2700); })
        ]);
        assert.notEqual(result, 'timed out', 'TURN discovery did not abort the stalled body');
        assert.ok(Array.isArray(result) && result.length, 'Discovery failure must use fallback servers');
    } finally {
        clearTimeout(deadline);
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
        await pending;
        global.fetch = originalFetch;
    }
});
