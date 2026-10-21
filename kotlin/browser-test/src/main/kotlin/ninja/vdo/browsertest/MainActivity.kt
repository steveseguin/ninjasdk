package ninja.vdo.browsertest

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.util.Log
import ninja.vdo.sdk.VdoNinja
import ninja.vdo.sdk.core.*
import org.webrtc.*
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/** Test fixture only: synthetic video, microphone audio, explicit application-data echo. */
class MainActivity : Activity() {
    private val worker = Executors.newSingleThreadScheduledExecutor()
    private lateinit var sdk: VdoNinja
    private lateinit var video: VideoSource
    private lateinit var audio: AudioSource
    private var stopReceiver: BroadcastReceiver? = null
    private fun report(text: String) = Log.i("VdoBrowserTest", text)
    override fun onCreate(state: Bundle?) {
        super.onCreate(state)
        window.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        fun arg(key: String) = intent.getStringExtra(key)!!
        stopReceiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                worker.shutdownNow()
                Thread {
                    sdk.disconnect()
                    report("STOPPED")
                }.start()
            }
        }.also { registerReceiver(it, IntentFilter("ninja.vdo.browsertest.STOP")) }
        worker.execute {
            try {
                PeerConnectionFactory.initialize(PeerConnectionFactory.InitializationOptions.builder(this).createInitializationOptions())
                val factory = PeerConnectionFactory.builder()
                    .setVideoEncoderFactory(SoftwareVideoEncoderFactory())
                    .setVideoDecoderFactory(SoftwareVideoDecoderFactory())
                    .createPeerConnectionFactory()
                sdk = VdoNinja(this, VdoNinjaOptions(host=arg("VDO_HOST"), password=arg("VDO_PASSWORD"), salt=arg("VDO_SALT")), factory=factory)
                video = sdk.factory.createVideoSource(false)
                audio = sdk.factory.createAudioSource(MediaConstraints())
                sdk.on(VdoEvents.DATA_RECEIVED) { sdk.sendData(it.data, uuid=it.uuid) }
                sdk.on(VdoEvents.ERROR) { report("ERROR ${it.message}") }
                sdk.on(VdoEvents.TRACK) { event ->
                    if (event.track is VideoTrack) {
                        val count = AtomicInteger()
                        (event.track as VideoTrack).addSink {
                            if (count.incrementAndGet() == 100) report("RX video 100")
                        }
                    }
                }
                sdk.connect()
                sdk.publish(listOf(sdk.factory.createVideoTrack("video", video), sdk.factory.createAudioTrack("audio", audio)), arg("VDO_PUBLISH"), arg("VDO_ROOM"))
                report("READY")
                sdk.view(arg("VDO_VIEW"), ViewOptions(downloads=false), timeoutMs=0)
                video.capturerObserver.onCapturerStarted(true)
                var frameIndex = 0
                worker.scheduleWithFixedDelay({
                    val buffer = JavaI420Buffer.allocate(320, 240)
                    val yPlane = buffer.dataY; val uPlane = buffer.dataU; val vPlane = buffer.dataV
                    // Animated bars: nonblank frames without requiring a device camera.
                    for (y in 0 until 240) for (x in 0 until 320) yPlane.put(y*buffer.strideY+x, (16+(x+frameIndex)%200).toByte())
                    for (y in 0 until 120) for (x in 0 until 160) {
                        uPlane.put(y*buffer.strideU+x, 90.toByte())
                        vPlane.put(y*buffer.strideV+x, 180.toByte())
                    }
                    val frame = VideoFrame(buffer, 0, System.nanoTime())
                    video.capturerObserver.onFrameCaptured(frame)
                    frame.release(); frameIndex++
                }, 0, 100, TimeUnit.MILLISECONDS)
                var audioReported = false
                worker.scheduleWithFixedDelay({
                    sdk.peers().forEach { uuid -> sdk.connection(uuid, "viewer")?.pc?.getStats { stats ->
                        stats.statsMap.values.filter { it.type == "inbound-rtp" }.forEach { stat ->
                            val samples = (stat.members["totalSamplesReceived"] as? Number)?.toLong() ?: 0
                            val energy = (stat.members["totalAudioEnergy"] as? Number)?.toDouble() ?: 0.0
                            if (samples > 48000 && energy > 0 && !audioReported) { audioReported=true; report("RX audio 100") }
                        }
                    } }
                }, 1, 1, TimeUnit.SECONDS)
            } catch (error: Exception) { Log.e("VdoBrowserTest", "FAILED", error) }
        }
    }
}
