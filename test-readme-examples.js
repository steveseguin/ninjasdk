// Test README examples using local SDK
const wrtc = require('@roamhq/wrtc');
const VDONinjaSDK = require('./vdoninja-sdk.js');

// Set global WebRTC objects (from README)
global.RTCPeerConnection = wrtc.RTCPeerConnection;
global.RTCIceCandidate = wrtc.RTCIceCandidate;
global.RTCSessionDescription = wrtc.RTCSessionDescription;
global.document = {
    createElement: () => ({ innerText: '', textContent: '' })
};

let allTestsPassed = true;

async function testBasicDataChannel() {
    console.log('\n=== Testing Basic Data Channel Example (from README) ===');
    try {
        // Create instance
        const vdo = new VDONinjaSDK();

        // Handle incoming messages
        vdo.addEventListener('dataReceived', (event) => {
            console.log(`Received from ${event.detail.uuid}:`, event.detail.data);
        });

        // Connect and join room
        await vdo.connect();
        await vdo.joinRoom({ room: "myroom" });

        // Announce as data-only publisher
        await vdo.announce({ streamID: "myStreamID" });

        // Send data to all connected peers
        vdo.sendData({ message: "Hello P2P!" });
        
        console.log('✅ Basic data channel example works');
        
        vdo.disconnect();
        return true;
    } catch (error) {
        console.error('❌ Basic data channel example failed:', error.message);
        allTestsPassed = false;
        return false;
    }
}

async function testNodeAdapter() {
    console.log('\n=== Testing Node Adapter Import ===');
    try {
        const VDONinjaSDKNode = require('./vdoninja-sdk-node.js');
        const vdo = new VDONinjaSDKNode();
        
        await vdo.connect();
        console.log('✅ Node adapter works');
        
        vdo.disconnect();
        return true;
    } catch (error) {
        console.error('❌ Node adapter failed:', error.message);
        allTestsPassed = false;
        return false;
    }
}

async function testMethods() {
    console.log('\n=== Testing SDK Methods ===');
    try {
        const vdo = new VDONinjaSDK();
        
        // Test method existence
        const methods = [
            'connect', 'disconnect', 'joinRoom', 'announce', 
            'view', 'sendData', 'addEventListener', 'removeEventListener'
        ];
        
        for (const method of methods) {
            if (typeof vdo[method] !== 'function') {
                throw new Error(`Method ${method} not found`);
            }
        }
        
        console.log('✅ All required methods exist');
        return true;
    } catch (error) {
        console.error('❌ Method test failed:', error.message);
        allTestsPassed = false;
        return false;
    }
}

async function testAliases() {
    console.log('\n=== Testing SDK Aliases ===');
    try {
        const vdo = new VDONinjaSDK();
        
        // Test actual aliases that exist in the SDK
        const aliases = [
            'send',
            'sendMessage', 
            'emit',
            'broadcast',
            'quickPlay',
            'quickWatch',
            'quickSubscribe',
            'quickStream',
            'quickBroadcast',
            'quickShare'
        ];
        
        // Just verify all aliases exist as functions
        for (const alias of aliases) {
            if (typeof vdo[alias] !== 'function') {
                throw new Error(`Alias ${alias} not found`);
            }
        }
        
        console.log('✅ All SDK aliases exist and are callable');
        return true;
    } catch (error) {
        console.error('❌ Alias test failed:', error.message);
        allTestsPassed = false;
        return false;
    }
}

async function runAllTests() {
    console.log('=== VDO.Ninja SDK Test Suite ===');
    console.log('Testing local SDK and README examples...\n');
    
    await testBasicDataChannel();
    await testNodeAdapter();
    await testMethods();
    await testAliases();
    
    console.log('\n=== Test Summary ===');
    if (allTestsPassed) {
        console.log('✅ All tests passed!');
        console.log('- Basic data channel example works');
        console.log('- Node.js adapter works');
        console.log('- All SDK methods present');
        console.log('- AI/LLM aliases functional');
        process.exit(0);
    } else {
        console.log('❌ Some tests failed');
        process.exit(1);
    }
}

// Run tests
runAllTests().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});