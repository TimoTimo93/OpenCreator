package dubbing

import "strings"

// Normalization rules for the dub-facing subtitle output. The source SRT is
// never rewritten; only cues built from the dub timeline pass through here.
const (
	// echoWindowSeconds limits how close two identical cues must be to count
	// as an echo instead of an intentional repetition.
	echoWindowSeconds = 4.0
	// shortCueDurationSeconds is the display threshold below which a cue is
	// merged into its neighbour (subliminal flashes).
	shortCueDurationSeconds = 0.6
	// minCueDurationSeconds is the minimum readable display time per cue.
	minCueDurationSeconds = 1.0
	// minExtendedCueDuration keeps extension away from degenerate windows.
	minExtendedCueDuration = 0.01
)

// NormalizeDubCues cleans the dub-facing subtitle timeline:
//   - echo cues (same text repeated within a short window) collapse to the
//     longest occurrence, preferring the later one on ties;
//   - cues shorter than 0.6s merge into a neighbour;
//   - every cue displays for at least 1.0s unless the next cue clamps it.
func NormalizeDubCues(cues []Cue) []Cue {
	normalized := dedupeEchoCues(cues)
	normalized = mergeShortCues(normalized)
	normalized = enforceMinCueDuration(normalized)
	for i := range normalized {
		normalized[i].Index = i + 1
	}
	return normalized
}

func dedupeEchoCues(cues []Cue) []Cue {
	result := make([]Cue, 0, len(cues))
	for i := 0; i < len(cues); {
		best := cues[i]
		j := i + 1
		for j < len(cues) &&
			strings.TrimSpace(cues[j].Text) != "" &&
			strings.TrimSpace(cues[j].Text) == strings.TrimSpace(best.Text) &&
			cues[j].Start-cues[i].Start < echoWindowSeconds {
			if cues[j].Duration() >= best.Duration() {
				best = cues[j]
			}
			j++
		}
		result = append(result, best)
		i = j
	}
	return result
}

func mergeShortCues(cues []Cue) []Cue {
	if len(cues) == 0 {
		return cues
	}
	merged := make([]Cue, 0, len(cues))
	for i := 0; i < len(cues); i++ {
		cue := cues[i]
		if cue.Duration() >= shortCueDurationSeconds {
			merged = append(merged, cue)
			continue
		}
		if i+1 < len(cues) {
			// Fold into the following cue, which is processed next.
			cues[i+1] = Cue{
				Index: cues[i+1].Index,
				Start: cue.Start,
				End:   cues[i+1].End,
				Text:  joinCueText(cue.Text, cues[i+1].Text),
			}
			continue
		}
		if len(merged) > 0 {
			// Trailing short cue folds into the previous one.
			prev := merged[len(merged)-1]
			prev.End = cue.End
			prev.Text = joinCueText(prev.Text, cue.Text)
			merged[len(merged)-1] = prev
			continue
		}
		merged = append(merged, cue)
	}
	return merged
}

func enforceMinCueDuration(cues []Cue) []Cue {
	for i := range cues {
		cue := &cues[i]
		if cue.Duration() >= minCueDurationSeconds {
			continue
		}
		extended := cue.Start + minCueDurationSeconds
		if i+1 < len(cues) && extended > cues[i+1].Start {
			extended = cues[i+1].Start
		}
		if extended-cue.Start >= minExtendedCueDuration {
			cue.End = extended
		}
	}
	return cues
}

func joinCueText(first, second string) string {
	first = strings.TrimSpace(first)
	second = strings.TrimSpace(second)
	switch {
	case first == "":
		return second
	case second == "":
		return first
	default:
		return first + " " + second
	}
}
