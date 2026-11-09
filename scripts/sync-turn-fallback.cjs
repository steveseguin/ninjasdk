#!/usr/bin/env node
'use strict';
// Import the browser's public backup relay list; never hand-maintain a second list.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const reference = process.env.VDON_REFERENCE_SOURCE || path.resolve(root, '../vdo.ninja');
const source = fs.readFileSync(path.join(reference, 'webrtc.js'), 'utf8');
const comment = source.indexOf('This is a backup list');
if (comment < 0) throw new Error('Browser backup list not found');
const start = source.lastIndexOf('turnlist = [', comment) + 'turnlist = '.length;
const list = JSON.parse(JSON.stringify(vm.runInNewContext('(' + source.slice(start, source.indexOf('];', start) + 1) + ')')));
if (!list.length || list.some(s => !s.username || !s.credential || s.urls.length !== 1)) throw new Error('Unexpected browser relay format');
const check = process.argv.includes('--check');
const q = JSON.stringify;
let drift = false;
function replace(file, pattern, value) {
    const full = path.resolve(root, file);
    const before = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    if (!pattern.test(before)) throw new Error('Backup list marker missing: ' + file);
    const after = before.replace(pattern, value);
    if (before !== after) {
        if (check) { console.error('Browser backup list differs: ' + file); drift = true; }
        else fs.writeFileSync(full, after);
    }
}
for (const file of ['vdoninja-sdk.js', ...(fs.existsSync(path.resolve(root, '../Ninja-VST3-Plugin/js_sdk/vdoninja-sdk.js')) ? ['../Ninja-VST3-Plugin/js_sdk/vdoninja-sdk.js'] : [])]) {
    replace(file, /\/\/ Fallback TURN servers\n\s*return \[[\s\S]*?\n\s*\];/,
        '// Fallback TURN servers\n                return [\n' + list.map(s => '                    ' + q(s)).join(',\n') + '\n                ];');
}
replace('python/vdoninja/turn.py', /FALLBACK_TURN_SERVERS: List\[Dict\[str, Any\]\] = \[[\s\S]*?\n\]/,
    'FALLBACK_TURN_SERVERS: List[Dict[str, Any]] = [\n' + list.map(s => '    ' + q(s).replace(/"udp":(true|false)/, (_, b) => '"udp":' + (b === 'true' ? 'True' : 'False'))).join(',\n') + '\n]');
replace('go/turn.go', /var fallbackTURNServers = \[\]TURNServer\{[\s\S]*?\n\}/,
    'var fallbackTURNServers = []TURNServer{\n' + list.map(s => `\t{Username: ${q(s.username)}, Credential: ${q(s.credential)}, URLs: []string{${q(s.urls[0])}}, TZ: ${s.tz}, UDP: ${s.udp}, Locale: ${q(s.locale)}},`).join('\n') + '\n}');
replace('c/src/vdon_sdk.c', /static const turn_entry FALLBACK_TURNS\[\] = \{[\s\S]*?\n\};/,
    'static const turn_entry FALLBACK_TURNS[] = {\n' + list.map(s => `    {${q(s.username)}, ${q(s.credential)}, ${q(s.urls[0])}, ${s.tz}, ${+s.udp}},`).join('\n') + '\n};');
replace('rust/vdoninja-core/src/turn.rs', /pub fn fallback_turn_servers\(\) -> Vec<TurnServer> \{[\s\S]*?\n\}/,
    'pub fn fallback_turn_servers() -> Vec<TurnServer> {\n    vec![\n' + list.map(s => `        ts(${q(s.username)}, ${q(s.credential)}, ${q(s.urls[0])}, ${s.tz}, ${s.udp}, ${q(s.locale)}),`).join('\n') + '\n    ]\n}');
replace('dart/vdoninja_core/lib/src/turn.dart', /const List<TurnServer> fallbackTurnServers = \[[\s\S]*?\n\];/,
    'const List<TurnServer> fallbackTurnServers = [\n' + list.map(s => `  TurnServer(username: ${q(s.username)}, credential: ${q(s.credential)}, urls: [${q(s.urls[0])}], tz: ${s.tz}, udp: ${s.udp}, locale: ${q(s.locale)}),`).join('\n') + '\n];');
replace('kotlin/vdoninja-core/src/main/kotlin/ninja/vdo/sdk/core/Turn.kt', /val FALLBACK = listOf\([\s\S]*?\n    \)/,
    'val FALLBACK = listOf(\n' + list.map(s => `        TurnServer(${q(s.username)}, ${q(s.credential)}, listOf(${q(s.urls[0])}), ${s.tz}, ${s.udp}, ${q(s.locale)}),`).join('\n') + '\n    )');
replace('swift/Sources/VDONinjaCore/Turn.swift', /public static let fallback: \[TurnServer\] = \[[\s\S]*?\n    \]/,
    'public static let fallback: [TurnServer] = [\n' + list.map(s => `        TurnServer(username: ${q(s.username)}, credential: ${q(s.credential)}, urls: [${q(s.urls[0])}], tz: ${s.tz}, udp: ${s.udp}, locale: ${q(s.locale)}),`).join('\n') + '\n    ]');
const pluginHeader = path.resolve(root, '../Ninja-VST3-Plugin/webrtc_vst/src/BrowserTurnFallback.h');
if (fs.existsSync(path.dirname(pluginHeader))) {
    const generated = '#pragma once\n// Generated from vdo.ninja/webrtc.js by ninjasdk/scripts/sync-turn-fallback.cjs.\nnamespace webrtc_vst {\ninline constexpr char kBrowserTurnFallback[] = R"turnjson(' + q({ servers: list }) + ')turnjson";\n}\n';
    if (check) {
        if (!fs.existsSync(pluginHeader) || fs.readFileSync(pluginHeader, 'utf8') !== generated) {
            console.error('Plugin backup list differs from browser'); drift = true;
        }
    } else fs.writeFileSync(pluginHeader, generated);
}
if (drift) process.exitCode = 1;
else console.log(`${check ? 'Verified' : 'Updated'} ${list.length} browser backup TURN entries in all SDKs.`);
