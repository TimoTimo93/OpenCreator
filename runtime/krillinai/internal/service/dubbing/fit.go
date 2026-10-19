package dubbing

import (
	"fmt"
	"strings"
)

// minAvailableSpeechSeconds guards the speed computation against degenerate
// chunks whose inter-cue gaps already fill the whole chunk slot.
const minAvailableSpeechSeconds = 0.01

func FitTimeline(plan []PlanItem, chunks []Chunk, cfg Config) ([]PlanItem, []Chunk, Report, error) {
	cfg = normalizeSpeedConfig(cfg)
	if !(cfg.SpeedMin > 0 && cfg.SpeedMin <= cfg.SpeedAccept && cfg.SpeedAccept <= cfg.SpeedMax) {
		return nil, nil, Report{}, fmt.Errorf("invalid speed config: min %.2f accept %.2f max %.2f", cfg.SpeedMin, cfg.SpeedAccept, cfg.SpeedMax)
	}

	fitted := append([]PlanItem(nil), plan...)
	fittedChunks := append([]Chunk(nil), chunks...)
	report := Report{}

	drift := 0.0
	prevEnd := 0.0
	for chunkIndex, chunk := range fittedChunks {
		available := chunk.End - chunk.Start
		if available <= 0 {
			return nil, nil, report, fmt.Errorf("chunk %d has non-positive duration: %.3f", chunk.ID, available)
		}

		actual, err := chunkActualDuration(fitted, chunk)
		if err != nil {
			return nil, nil, report, err
		}

		// Natural pauses between the cues of a chunk are kept at their original
		// length, so only the remaining time is available for the speech itself.
		availableSpeech := available - chunkIntraGaps(fitted, chunk)
		if availableSpeech < minAvailableSpeechSeconds {
			availableSpeech = minAvailableSpeechSeconds
		}

		speed := 1.0
		if actual > availableSpeech {
			speed = actual / availableSpeech
		}
		if speed > report.MaxSpeedFactor {
			report.MaxSpeedFactor = speed
		}
		if speed > cfg.SpeedAccept {
			report.Warnings = append(report.Warnings, fmt.Sprintf("chunk %d speed %.2f exceeds acceptable %.2f", chunk.ID, speed, cfg.SpeedAccept))
		}
		appliedSpeed := speed
		if appliedSpeed > cfg.SpeedMax {
			appliedSpeed = cfg.SpeedMax
			report.Warnings = append(report.Warnings, fmt.Sprintf("chunk %d speed %.2f clamped to max %.2f", chunk.ID, speed, cfg.SpeedMax))
		}
		if appliedSpeed < cfg.SpeedMin {
			appliedSpeed = cfg.SpeedMin
		}
		fittedChunks[chunkIndex].SpeedFactor = appliedSpeed

		// A chunk clamped at max speed may still overflow its slot; instead of
		// squeezing the voice beyond the quality limit, later chunks drift by
		// the excess (capped so the dub cannot run away from the video).
		start := chunk.Start + drift
		if start < prevEnd {
			start = prevEnd
		}

		durations := allocateChunkDurations(fitted, chunk, actual, appliedSpeed)
		cursor := start
		for i, idx := range chunk.Items {
			fitted[idx].NewStart = cursor
			fitted[idx].NewEnd = cursor + durations[i]
			fitted[idx].SpeedFactor = appliedSpeed
			cursor = fitted[idx].NewEnd
			if gap := planItemGap(fitted, chunk, i); gap > 0 {
				cursor += gap
			}
		}

		fittedChunks[chunkIndex].Start = start
		prevEnd = cursor

		overflow := cursor - chunk.End
		if overflow > 0 {
			drift += overflow
			capped := false
			if drift > cfg.MaxDriftSeconds {
				drift = cfg.MaxDriftSeconds
				capped = true
			}
			report.Warnings = append(report.Warnings, fmt.Sprintf("chunk %d overflows slot by %.2fs even at speed %.2f; timeline drifts +%.2fs", chunk.ID, overflow, appliedSpeed, drift))
			if capped {
				report.Warnings = append(report.Warnings, fmt.Sprintf("timeline drift capped at %.2fs; following chunks are packed to catch up", cfg.MaxDriftSeconds))
			}
		} else {
			drift = 0
		}
	}

	return fitted, fittedChunks, report, nil
}

func chunkActualDuration(plan []PlanItem, chunk Chunk) (float64, error) {
	if chunk.ActualDuration > 0 {
		for itemIndex, idx := range chunk.Items {
			if idx < 0 || idx >= len(plan) {
				return 0, fmt.Errorf("chunk %d references plan item %d out of range", chunk.ID, itemIndex)
			}
		}
		return chunk.ActualDuration, nil
	}

	actual := 0.0
	for itemIndex, idx := range chunk.Items {
		if idx < 0 || idx >= len(plan) {
			return 0, fmt.Errorf("chunk %d references plan item %d out of range", chunk.ID, itemIndex)
		}
		if plan[idx].ActualDuration <= 0 {
			return 0, fmt.Errorf("chunk %d item %d references plan index %d with non-positive actual duration: %.3f", chunk.ID, itemIndex, idx, plan[idx].ActualDuration)
		}
		actual += plan[idx].ActualDuration
	}
	return actual, nil
}

// planItemGap returns the original inter-cue pause between the items at
// chunk.Items[itemIndex] and the following one, clamped at zero.
func planItemGap(plan []PlanItem, chunk Chunk, itemIndex int) float64 {
	if itemIndex >= len(chunk.Items)-1 {
		return 0
	}
	cur := chunk.Items[itemIndex]
	next := chunk.Items[itemIndex+1]
	if cur < 0 || cur >= len(plan) || next < 0 || next >= len(plan) {
		return 0
	}
	if plan[cur].OriginalEnd <= 0 || plan[next].OriginalStart <= 0 {
		return 0
	}
	gap := plan[next].OriginalStart - plan[cur].OriginalEnd
	if gap < 0 {
		return 0
	}
	return gap
}

func chunkIntraGaps(plan []PlanItem, chunk Chunk) float64 {
	gaps := 0.0
	for i := range chunk.Items {
		gaps += planItemGap(plan, chunk, i)
	}
	return gaps
}

func allocateChunkDurations(plan []PlanItem, chunk Chunk, actual, speed float64) []float64 {
	durations := make([]float64, len(chunk.Items))
	if len(chunk.Items) == 0 {
		return durations
	}
	if speed <= 0 {
		speed = 1
	}

	total := actual / speed
	weights := make([]float64, len(chunk.Items))
	weightSum := 0.0
	useItemActual := chunk.ActualDuration <= 0
	for i, idx := range chunk.Items {
		weight := 0.0
		if useItemActual {
			weight = plan[idx].ActualDuration
		}
		if weight <= 0 {
			weight = plan[idx].EstimatedDuration
		}
		if weight <= 0 {
			weight = float64(len([]rune(strings.TrimSpace(plan[idx].SpokenText))))
		}
		if weight <= 0 {
			weight = 1
		}
		weights[i] = weight
		weightSum += weight
	}
	if weightSum <= 0 {
		even := total / float64(len(durations))
		for i := range durations {
			durations[i] = even
		}
		return durations
	}
	for i, weight := range weights {
		durations[i] = total * weight / weightSum
	}
	return durations
}

func normalizeSpeedConfig(cfg Config) Config {
	defaults := DefaultConfig()
	if cfg.SpeedMin <= 0 {
		cfg.SpeedMin = defaults.SpeedMin
	}
	if cfg.SpeedAccept <= 0 {
		cfg.SpeedAccept = defaults.SpeedAccept
	}
	if cfg.SpeedMax <= 0 {
		cfg.SpeedMax = defaults.SpeedMax
	}
	if cfg.MaxDriftSeconds <= 0 {
		cfg.MaxDriftSeconds = defaults.MaxDriftSeconds
	}
	return cfg
}
