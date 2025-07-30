# VDO.Ninja SDK - Social Stream Ninja (SSN) Integration

This directory contains examples for integrating with Social Stream Ninja, a service that consolidates chat messages from YouTube, Twitch, Discord, Facebook, and other platforms.

## Overview

Social Stream Ninja (SSN) integration demonstrates how to:
- Connect as a "dock" client to receive consolidated chat messages
- Process messages from multiple chat platforms
- Filter messages by the "overlayNinja" key
- Handle various types of chat content and events

## Example File

### socialstreamninja-listener.js
A Node.js application that:
- Connects to Social Stream Ninja (wss://wss.socialstream.ninja)
- Joins a room as a "dock" client
- Receives consolidated chat messages from multiple platforms
- Displays chat messages with platform info, usernames, and content

## Prerequisites

Install a WebRTC implementation:
```bash
# Recommended for full features
npm install @roamhq/wrtc

# OR lightweight option (data channels only)
npm install node-datachannel
```

## Usage

### Basic Usage

Start the SSN listener:
```bash
node socialstreamninja-listener.js your-ssn-session-ID-here
```

The listener will connect to your Social Stream Ninja room and receive all chat messages sent to "dock" clients.

Note: The example uses `password: false` to disable password protection. Modify the code if you need password support.

### Command Line Arguments

```
node socialstreamninja-listener.js [your-ssn-session-ID-here]

Arguments:
  your-ssn-session-ID-here  - The SSN session to join (default: 'testroom')
```

## Message Format

Social Stream Ninja sends chat messages with an "overlayNinja" key containing platform-specific data:

```json
{
  "overlayNinja": {
    "chatname": "Username",
    "chatmessage": "Hello from YouTube!",
    "type": "youtube",
    "chatimg": "profile_image_url",
    "chatbadges": ["badge_urls"],
    "hasDonation": "$5.00",
    "timestamp": 1234567890
  }
}
```

## Features

### Listener Features
- Auto-reconnection on connection loss
- Message counting and timestamps
- Summary on exit
- Real-time status display
- JSON parsing with error handling

### Platform Types
SSN supports messages from:
- `youtube` - YouTube chat
- `twitch` - Twitch chat  
- `discord` - Discord messages
- `facebook` - Facebook comments
- `youtubeshorts` - YouTube Shorts
- And more...

## Troubleshooting

### No Messages Received
- Ensure both scripts are using the same room name
- Check that passwords match (or both have no password)
- Verify WebRTC implementation is installed

### Connection Failed
- Check internet connection
- Ensure firewall allows WebSocket connections
- Try with debug mode: modify `debug: true` in the scripts

### Data Channel Not Opening
- Ensure Social Stream Ninja is configured and running
- Check that you're using the same room name
- Verify the label "dock" is being sent correctly

## Use Cases

- **Streaming Overlays**: Display viewer messages on stream
- **Alert System**: Show notifications during broadcasts  
- **Remote Control**: Send commands to control OBS or other software
- **Analytics Display**: Real-time stats overlay
- **Chat Integration**: Bridge between chat systems and overlays
