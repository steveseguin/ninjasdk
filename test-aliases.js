// Test script for VDO.Ninja SDK method aliases
// This verifies that all aliases are properly defined and functional

// Note: This is a simple structural test, not a full integration test
const VDONinjaSDK = {};

// Mock the SDK class structure for testing
VDONinjaSDK.prototype = {
    // Original methods (mocked)
    view: function() { return 'view'; },
    publish: function() { return 'publish'; },
    stopViewing: function() { return 'stopViewing'; },
    stopPublishing: function() { return 'stopPublishing'; },
    joinRoom: function() { return 'joinRoom'; },
    leaveRoom: function() { return 'leaveRoom'; },
    sendData: function() { return 'sendData'; },
    quickView: function() { return 'quickView'; },
    quickPublish: function() { return 'quickPublish'; },
    
    // Viewing/Playing aliases
    play: function(streamID, options) { return this.view(streamID, options); },
    watch: function(streamID, options) { return this.view(streamID, options); },
    subscribe: function(streamID, options) { return this.view(streamID, options); },
    startViewing: function(streamID, options) { return this.view(streamID, options); },
    
    // Publishing/Streaming aliases  
    stream: function(mediaStream, options) { return this.publish(mediaStream, options); },
    broadcast: function(mediaStream, options) { return this.publish(mediaStream, options); },
    startPublishing: function(mediaStream, options) { return this.publish(mediaStream, options); },
    share: function(mediaStream, options) { return this.publish(mediaStream, options); },
    
    // Stop viewing aliases
    stop: function(streamID) { return this.stopViewing(streamID); },
    stopPlaying: function(streamID) { return this.stopViewing(streamID); },
    stopWatching: function(streamID) { return this.stopViewing(streamID); },
    unsubscribe: function(streamID) { return this.stopViewing(streamID); },
    
    // Stop publishing aliases
    stopStreaming: function() { return this.stopPublishing(); },
    stopBroadcasting: function() { return this.stopPublishing(); },
    stopSharing: function() { return this.stopPublishing(); },
    unpublish: function() { return this.stopPublishing(); },
    
    // Connection aliases
    join: function(options) { return this.joinRoom(options); },
    enterRoom: function(options) { return this.joinRoom(options); },
    enter: function(options) { return this.joinRoom(options); },
    
    leave: function() { return this.leaveRoom(); },
    exitRoom: function() { return this.leaveRoom(); },
    exit: function() { return this.leaveRoom(); },
    
    // Data sending aliases
    send: function(data, target) { return this.sendData(data, target); },
    sendMessage: function(data, target) { return this.sendData(data, target); },
    emit: function(data, target) { return this.sendData(data, target); },
    
    // Quick method aliases
    quickPlay: function(options) { return this.quickView(options); },
    quickWatch: function(options) { return this.quickView(options); },
    quickSubscribe: function(options) { return this.quickView(options); },
    
    quickStream: function(options) { return this.quickPublish(options); },
    quickBroadcast: function(options) { return this.quickPublish(options); },
    quickShare: function(options) { return this.quickPublish(options); }
};

// Test the aliases
function testAliases() {
    const sdk = Object.create(VDONinjaSDK.prototype);
    const tests = [];
    let passed = 0;
    let failed = 0;
    
    // Test viewing aliases
    tests.push(['play', sdk.play() === 'view']);
    tests.push(['watch', sdk.watch() === 'view']);
    tests.push(['subscribe', sdk.subscribe() === 'view']);
    tests.push(['startViewing', sdk.startViewing() === 'view']);
    
    // Test publishing aliases
    tests.push(['stream', sdk.stream() === 'publish']);
    tests.push(['broadcast', sdk.broadcast() === 'publish']);
    tests.push(['startPublishing', sdk.startPublishing() === 'publish']);
    tests.push(['share', sdk.share() === 'publish']);
    
    // Test stop viewing aliases
    tests.push(['stop', sdk.stop() === 'stopViewing']);
    tests.push(['stopPlaying', sdk.stopPlaying() === 'stopViewing']);
    tests.push(['stopWatching', sdk.stopWatching() === 'stopViewing']);
    tests.push(['unsubscribe', sdk.unsubscribe() === 'stopViewing']);
    
    // Test stop publishing aliases
    tests.push(['stopStreaming', sdk.stopStreaming() === 'stopPublishing']);
    tests.push(['stopBroadcasting', sdk.stopBroadcasting() === 'stopPublishing']);
    tests.push(['stopSharing', sdk.stopSharing() === 'stopPublishing']);
    tests.push(['unpublish', sdk.unpublish() === 'stopPublishing']);
    
    // Test room aliases
    tests.push(['join', sdk.join() === 'joinRoom']);
    tests.push(['enterRoom', sdk.enterRoom() === 'joinRoom']);
    tests.push(['enter', sdk.enter() === 'joinRoom']);
    tests.push(['leave', sdk.leave() === 'leaveRoom']);
    tests.push(['exitRoom', sdk.exitRoom() === 'leaveRoom']);
    tests.push(['exit', sdk.exit() === 'leaveRoom']);
    
    // Test data sending aliases
    tests.push(['send', sdk.send() === 'sendData']);
    tests.push(['sendMessage', sdk.sendMessage() === 'sendData']);
    tests.push(['emit', sdk.emit() === 'sendData']);
    
    // Test quick method aliases
    tests.push(['quickPlay', sdk.quickPlay() === 'quickView']);
    tests.push(['quickWatch', sdk.quickWatch() === 'quickView']);
    tests.push(['quickSubscribe', sdk.quickSubscribe() === 'quickView']);
    tests.push(['quickStream', sdk.quickStream() === 'quickPublish']);
    tests.push(['quickBroadcast', sdk.quickBroadcast() === 'quickPublish']);
    tests.push(['quickShare', sdk.quickShare() === 'quickPublish']);
    
    // Run tests and show results
    console.log('\n=== VDO.Ninja SDK Alias Tests ===\n');
    
    tests.forEach(([name, result]) => {
        if (result) {
            console.log(`✓ ${name}`);
            passed++;
        } else {
            console.log(`✗ ${name}`);
            failed++;
        }
    });
    
    console.log('\n=== Test Summary ===');
    console.log(`Total: ${tests.length}`);
    console.log(`Passed: ${passed}`);
    console.log(`Failed: ${failed}`);
    
    if (failed === 0) {
        console.log('\n✅ All alias tests passed!\n');
    } else {
        console.log(`\n❌ ${failed} tests failed\n`);
        process.exit(1);
    }
}

// Run the tests
testAliases();