// Test-only peer for tests/interop/native-av-live.cjs. Application echoes use pipe, never signaling.
package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/pion/rtcp"
	"github.com/pion/rtp"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"
	"github.com/pion/webrtc/v4/pkg/media/ivfreader"
	"github.com/pion/webrtc/v4/pkg/media/ivfwriter"
	"github.com/pion/webrtc/v4/pkg/media/oggreader"
	"github.com/pion/webrtc/v4/pkg/media/oggwriter"
	vdo "github.com/steveseguin/ninjasdk/go"
)

func must(err error) {
	if err != nil {
		panic(err)
	}
}

func main() {
	sdk := vdo.New(vdo.Options{Host: os.Getenv("VDO_HOST"), Password: os.Getenv("VDO_PASSWORD"), Salt: os.Getenv("VDO_SALT"), Debug: os.Getenv("VDO_DEBUG") != ""})
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	var jobs sync.WaitGroup
	video, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8}, "video", "test")
	must(err)
	audio, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus}, "audio", "test")
	must(err)
	sdk.On(vdo.EventDataReceived, func(ev vdo.Event) { sdk.SendDataTo(ev.UUID, ev.Data) })
	sdk.On(vdo.EventError, func(ev vdo.Event) { fmt.Println("ERROR", ev.Err, ev.Message) })
	sdk.On(vdo.EventTrack, func(ev vdo.Event) {
		jobs.Add(1)
		go func() {
			defer jobs.Done()
			track := ev.Track
			kind := track.Kind().String()
			var writer interface {
				WriteRTP(*rtp.Packet) error
				Close() error
			}
			if kind == "video" {
				w, err := ivfwriter.New(filepath.Join(os.Getenv("VDO_OUT"), "received.ivf"))
				must(err)
				writer = w
				go func() {
					ticker := time.NewTicker(time.Second)
					defer ticker.Stop()
					for {
						select {
						case <-ctx.Done():
							return
						case <-ticker.C:
							if c := sdk.Connection(ev.UUID, "viewer"); c != nil {
								_ = c.PeerConnection().WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(track.SSRC())}})
							}
						}
					}
				}()
			} else {
				w, err := oggwriter.New(filepath.Join(os.Getenv("VDO_OUT"), "received.ogg"), 48000, 2)
				must(err)
				writer = w
			}
			defer writer.Close()
			for n := 1; ; n++ {
				p, _, err := track.ReadRTP()
				if err != nil {
					return
				}
				must(writer.WriteRTP(p))
				if n == 100 {
					fmt.Println("RX", kind, n)
				}
			}
		}()
	})
	must(sdk.Connect(ctx))
	_, err = sdk.Publish(ctx, []webrtc.TrackLocal{video, audio}, vdo.PublishOptions{StreamID: os.Getenv("VDO_PUBLISH"), Room: os.Getenv("VDO_ROOM")})
	must(err)
	for _, kind := range []string{"video", "audio"} {
		jobs.Add(1)
		go func(kind string) {
			defer jobs.Done()
			ext := ".ivf"
			duration := time.Second / 30
			track := video
			if kind == "audio" {
				ext = ".ogg"
				duration = 20 * time.Millisecond
				track = audio
			}
			ticker := time.NewTicker(duration)
			defer ticker.Stop()
			for ctx.Err() == nil {
				f, err := os.Open(os.Getenv("VDO_MEDIA") + ext)
				must(err)
				var next func() ([]byte, error)
				if kind == "video" {
					r, _, err := ivfreader.NewWith(f)
					must(err)
					next = func() ([]byte, error) { b, _, e := r.ParseNextFrame(); return b, e }
				} else {
					r, _, err := oggreader.NewWith(f)
					must(err)
					next = func() ([]byte, error) { b, _, e := r.ParseNextPage(); return b, e }
				}
				for {
					b, err := next()
					if err == io.EOF {
						break
					}
					must(err)
					if len(b) >= 8 && string(b[:8]) == "OpusTags" {
						continue
					}
					select {
					case <-ctx.Done():
						f.Close()
						return
					case <-ticker.C:
					}
					_ = track.WriteSample(media.Sample{Data: b, Duration: duration})
				}
				f.Close()
			}
		}(kind)
	}
	fmt.Println("READY")
	no := false
	_, err = sdk.View(ctx, os.Getenv("VDO_VIEW"), vdo.ViewOptions{Downloads: &no, Timeout: 3 * time.Second})
	if err != nil && err != vdo.ErrStreamNotYetAvailable {
		panic(err)
	}
	<-ctx.Done()
	sdk.Disconnect()
	jobs.Wait()
	fmt.Println("STOPPED")
}
