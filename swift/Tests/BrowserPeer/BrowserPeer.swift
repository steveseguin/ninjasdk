// Test-only synthetic A/V peer for tests/interop/native-av-live.cjs.
import Foundation
import AudioToolbox
import CoreVideo
import WebRTC
import VDONinja

// Uses WebRTC's public RTCAudioDevice API, with no microphone/hardware dependency.
// https://webrtc.googlesource.com/src/+/refs/heads/main/sdk/objc/components/audio/RTCAudioDevice.h
final class TestAudio: NSObject, RTCAudioDevice {
    let deviceInputSampleRate = 48000.0, deviceOutputSampleRate = 48000.0
    let inputIOBufferDuration = 0.01, outputIOBufferDuration = 0.01
    let inputNumberOfChannels = 1, outputNumberOfChannels = 1
    let inputLatency = 0.0, outputLatency = 0.0
    private let queue = DispatchQueue(label: "test.audio")
    private var delegate: RTCAudioDeviceDelegate?
    private var timer: DispatchSourceTimer?
    private var initialized = false, recording = false, playing = false
    private var recordReady = false, playReady = false
    private var sample = 0, nonzero = 0
    var isInitialized: Bool { queue.sync { initialized } }
    var isPlayoutInitialized: Bool { queue.sync { playReady } }
    var isRecordingInitialized: Bool { queue.sync { recordReady } }
    var isPlaying: Bool { queue.sync { playing } }
    var isRecording: Bool { queue.sync { recording } }
    var receivedBuffers: Int { queue.sync { nonzero } }
    func initialize(with delegate: RTCAudioDeviceDelegate) -> Bool {
        queue.sync {
            self.delegate = delegate; initialized = true
            let timer = DispatchSource.makeTimerSource(queue: queue)
            timer.schedule(deadline: .now(), repeating: .milliseconds(10))
            timer.setEventHandler { [weak self] in self?.tick() }
            self.timer = timer; timer.resume()
        }
        return true
    }
    func terminateDevice() -> Bool {
        queue.sync { timer?.cancel(); timer = nil; delegate = nil; initialized = false }
        return true
    }
    func initializePlayout() -> Bool { queue.sync { playReady = true }; return true }
    func initializeRecording() -> Bool { queue.sync { recordReady = true }; return true }
    func startPlayout() -> Bool { queue.sync { playing = true }; return true }
    func stopPlayout() -> Bool { queue.sync { playing = false }; return true }
    func startRecording() -> Bool { queue.sync { recording = true }; return true }
    func stopRecording() -> Bool { queue.sync { recording = false }; return true }
    private func tick() {
        guard let delegate else { return }
        var flags: AudioUnitRenderActionFlags = []
        var timestamp = AudioTimeStamp()
        timestamp.mSampleTime = Double(sample)
        timestamp.mFlags = .sampleTimeValid
        if recording {
            var pcm = (0..<480).map { Int16(9000 * sin(2 * .pi * 440 * Double(sample + $0) / 48000)) }
            pcm.withUnsafeMutableBytes { bytes in
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 960, mData: bytes.baseAddress))
                _ = delegate.deliverRecordedData(&flags, &timestamp, 0, 480, &list, nil, nil)
            }
        }
        if playing {
            var pcm = [Int16](repeating: 0, count: 480)
            pcm.withUnsafeMutableBytes { bytes in
                var list = AudioBufferList(mNumberBuffers: 1, mBuffers: AudioBuffer(mNumberChannels: 1, mDataByteSize: 960, mData: bytes.baseAddress))
                _ = delegate.getPlayoutData(&flags, &timestamp, 0, 480, &list)
            }
            if pcm.contains(where: { $0 > 10 || $0 < -10 }) {
                nonzero += 1
                if nonzero == 100 { print("RX audio 100") }
            }
        }
        sample += 480
    }
}

final class VideoSink: NSObject, RTCVideoRenderer {
    private let lock = NSLock()
    private var count = 0
    var frames: Int { lock.lock(); defer { lock.unlock() }; return count }
    func setSize(_ size: CGSize) {}
    func renderFrame(_ frame: RTCVideoFrame?) {
        guard let frame, frame.width > 0, frame.height > 0 else { return }
        lock.lock(); defer { lock.unlock() }
        count += 1
        if count == 100 { print("RX video 100") }
    }
}

@main struct BrowserPeer {
    static func main() async throws {
        setbuf(stdout, nil)
        let env = ProcessInfo.processInfo.environment
        RTCInitializeSSL()
        let audio = TestAudio()
        let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory(), audioDevice: audio)
        var options = VDONinjaOptions(host: env["VDO_HOST"]!, password: env["VDO_PASSWORD"]!)
        options.salt = env["VDO_SALT"]!
        let sdk = VDONinja(options: options, factory: factory)
        let sink = VideoSink()
        sdk.on(.track) { event in (event.track as? RTCVideoTrack)?.add(sink) }
        sdk.on(.dataReceived) { event in
            if let data = event.data { sdk.sendData(data, uuid: event.uuid) }
        }
        sdk.on(.error) { print("ERROR \($0.message ?? "unknown")") }
        let source = factory.videoSource()
        let capturer = RTCVideoCapturer(delegate: source)
        let videoTrack = factory.videoTrack(with: source, trackId: "video")
        let audioTrack = factory.audioTrack(with: factory.audioSource(with: nil), trackId: "audio")
        try await sdk.connect()
        _ = try await sdk.publish(tracks: [videoTrack, audioTrack], streamId: env["VDO_PUBLISH"], room: env["VDO_ROOM"])
        print("READY")
        var prefs = ViewOptions(); prefs.downloads = false
        sdk.view(env["VDO_VIEW"]!, options: prefs, timeout: 0) { _ in }
        let videoQueue = DispatchQueue(label: "test.video")
        let timer = DispatchSource.makeTimerSource(queue: videoQueue)
        var tick = 0
        timer.schedule(deadline: .now(), repeating: .milliseconds(50))
        timer.setEventHandler {
            var pixel: CVPixelBuffer?
            guard CVPixelBufferCreate(nil, 320, 240, kCVPixelFormatType_32BGRA, nil, &pixel) == kCVReturnSuccess, let pixel else { return }
            CVPixelBufferLockBaseAddress(pixel, [])
            let stride = CVPixelBufferGetBytesPerRow(pixel) / 4
            let data = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt32.self)
            for y in 0..<240 { for x in 0..<320 { data[y * stride + x] = 0xFF008040 | UInt32((x + tick) % 256) << 16 } }
            CVPixelBufferUnlockBaseAddress(pixel, [])
            let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: pixel), rotation: RTCVideoRotation(rawValue: 0)!, timeStampNs: Int64(DispatchTime.now().uptimeNanoseconds))
            source.capturer(capturer, didCapture: frame)
            tick += 1
        }
        timer.resume()
        signal(SIGINT, SIG_IGN)
        let stop = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        await withCheckedContinuation { (continuation: CheckedContinuation<Void, Never>) in
            stop.setEventHandler { continuation.resume() }
            stop.resume()
        }
        stop.cancel(); timer.cancel()
        await sdk.dispose()
        let evidence: [String: Int] = ["videoFrames": sink.frames, "audioNonzeroBuffers": audio.receivedBuffers]
        try JSONSerialization.data(withJSONObject: evidence).write(to: URL(fileURLWithPath: env["VDO_OUT"]! + "/received-stats.json"))
        print("STOPPED")
    }
}
