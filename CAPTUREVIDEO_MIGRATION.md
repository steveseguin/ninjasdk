# CaptureVideo.js Migration Guide

## Overview
The `capturevideo.js` file has been updated to use the external VDO.Ninja SDK instead of having an old development version embedded within it.

## File Changes

### Original Structure (capturevideo.js)
- Lines 1-14: Header comments
- Lines 15-1998: Embedded VDONinjaSDK class (old development version)
- Lines 1999-2007: SDK export statements
- Lines 2008-3394: Application code (Chrome extension logic)

### New Structure (capturevideo-updated.js)
- Lines 1-9: Header comments
- Lines 10-476: Application code only (Chrome extension logic)
- External dependency: `vdoninja-sdk.js`

## API Changes

### SDK Initialization
**Old (embedded SDK):**
```javascript
const vdo = new VDONinjaSDK({
    room: ROOM_ID,
    password: settings.password !== false ? (settings.password || "abc123") : false,
    streamID: streamID,
    debug: true
});
```

**New (external SDK):**
```javascript
const vdo = new VDONinjaSDK({
    room: ROOM_ID,
    password: false,  // Simplified for demo
    debug: true
});
```

### Publishing
**Old:**
```javascript
await vdo.publish({
    stream: combinedStream,
    streamID: streamID
});
```

**New:**
```javascript
await vdo.connect();  // Connect first
await vdo.publish(combinedStream, { streamID });  // Then publish
```

### Event Handling
Both versions use the same event listener pattern:
```javascript
vdo.addEventListener('connected', () => { ... });
vdo.addEventListener('disconnected', () => { ... });
vdo.addEventListener('error', (event) => { ... });
```

## Chrome Extension Integration

### Manifest.json Update Required
```json
{
  "content_scripts": [{
    "matches": ["https://discord.com/*"],
    "js": [
      "vdoninja-sdk.js",        // Load SDK first
      "capturevideo-updated.js"  // Then load application
    ],
    "run_at": "document_start"
  }]
}
```

### File Size Reduction
- Original `capturevideo.js`: 3,394 lines
- New `capturevideo-updated.js`: 476 lines
- Reduction: ~86% smaller (removing embedded SDK)

## Benefits of Migration

1. **Maintainability**: Uses the official, maintained SDK version
2. **Updates**: Automatically benefits from SDK updates and bug fixes
3. **Size**: Significantly smaller file size
4. **Consistency**: Same SDK API as all other demos and documentation
5. **Security**: Benefits from SDK security updates

## Testing Checklist

- [ ] Update Chrome extension manifest to include both JS files
- [ ] Ensure `vdoninja-sdk.js` loads before `capturevideo-updated.js`
- [ ] Test video capture on Discord
- [ ] Verify stream publishing works
- [ ] Check overlay buttons appear correctly
- [ ] Confirm clipboard copy functionality
- [ ] Test enable/disable toggle in extension settings
- [ ] Verify cleanup on page unload

## Rollback Plan

If issues arise, you can temporarily use the original `capturevideo.js` which has the SDK embedded. However, it's recommended to resolve any issues with the external SDK approach for long-term maintainability.