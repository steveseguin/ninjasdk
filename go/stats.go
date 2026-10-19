// Copyright (c) 2025-2026 Steve Seguin
// SPDX-License-Identifier: MPL-2.0

package vdoninja

import (
	"github.com/pion/webrtc/v4"
)

// PeerQuality is a digest of link quality for one peer.
type PeerQuality struct {
	RTTMs                    float64
	LossRate                 *float64
	CandidatePairType        string
	Relayed                  bool
	AvailableOutgoingBitrate float64
	BytesSent                uint64
	BytesReceived            uint64
}

// Stats returns the raw pion stats reports keyed by connection type
// ("publisher"/"viewer") for one peer.
func (s *SDK) Stats(uuid string) map[string]webrtc.StatsReport {
	out := map[string]webrtc.StatsReport{}
	for _, typ := range []string{"publisher", "viewer"} {
		if c := s.Connection(uuid, typ); c != nil {
			out[typ] = c.pc.GetStats()
		}
	}
	return out
}

// PeerQualityOf digests stats for a peer: RTT, loss, candidate pair type and
// bytes. It returns nil for an unknown peer.
func (s *SDK) PeerQualityOf(uuid string) *PeerQuality {
	reports := s.Stats(uuid)
	if len(reports) == 0 {
		return nil
	}
	q := &PeerQuality{}
	var lost, received uint64
	haveRTP := false
	for _, report := range reports {
		cands := map[string]webrtc.ICECandidateStats{}
		for _, st := range report {
			if c, ok := st.(webrtc.ICECandidateStats); ok {
				cands[c.ID] = c
			}
		}
		for _, st := range report {
			switch v := st.(type) {
			case webrtc.ICECandidatePairStats:
				if !v.Nominated && v.State != webrtc.StatsICECandidatePairStateSucceeded {
					continue
				}
				if v.CurrentRoundTripTime > 0 {
					q.RTTMs = v.CurrentRoundTripTime * 1000
				}
				if v.AvailableOutgoingBitrate > 0 {
					q.AvailableOutgoingBitrate = v.AvailableOutgoingBitrate
				}
				q.BytesSent += v.BytesSent
				q.BytesReceived += v.BytesReceived
				local, remote := cands[v.LocalCandidateID], cands[v.RemoteCandidateID]
				if local.CandidateType != webrtc.ICECandidateTypeUnknown || remote.CandidateType != webrtc.ICECandidateTypeUnknown {
					q.CandidatePairType = local.CandidateType.String() + "/" + remote.CandidateType.String()
					if local.CandidateType == webrtc.ICECandidateTypeRelay || remote.CandidateType == webrtc.ICECandidateTypeRelay {
						q.Relayed = true
					}
				}
			case webrtc.InboundRTPStreamStats:
				haveRTP = true
				if v.PacketsLost > 0 {
					lost += uint64(v.PacketsLost)
				}
				received += uint64(v.PacketsReceived)
			}
		}
	}
	if haveRTP && lost+received > 0 {
		rate := float64(lost) / float64(lost+received)
		q.LossRate = &rate
	}
	return q
}
