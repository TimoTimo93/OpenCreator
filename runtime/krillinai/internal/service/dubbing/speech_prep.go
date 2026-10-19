package dubbing

import "strings"

// Speech preparation runs on the raw target-language cues right before the
// TTS plan is built. It only shapes the SPEECH timeline:
//   - ASR echo (the same line repeated within a few seconds) is read once;
//     later copies become silence cues that keep their original timeline slot
//     so nothing downstream shifts;
//   - cues that are too long for one TTS call are split into 2-3 balanced
//     parts, each with a proportional sub-slot, so timeline fitting works on
//     smaller, more accurate segments.
//
// The burned subtitle is never touched: it keeps the source text and is only
// re-timed through AlignSubtitleToDubPlan.
const (
	// maxSpeechCueRunes is the cue length above which a cue is split before
	// speech synthesis.
	maxSpeechCueRunes = 90
	// maxSpeechCueParts caps the number of split parts per cue.
	maxSpeechCueParts = 3
)

// SpeechPrepStats records what preparation changed, for dubbing_report.json.
type SpeechPrepStats struct {
	EchoSilenced        int
	EchoSilencedIndexes []int
	SplitCues           int
	SplitParts          int
}

// PrepareSpeechCues silences ASR echo copies, splits overlong cues and
// renumbers the result so every cue keeps a unique index for its TTS segment.
func PrepareSpeechCues(cues []Cue) ([]Cue, SpeechPrepStats) {
	stats := SpeechPrepStats{}
	silenced := silenceEchoCues(cues, &stats)

	prepared := make([]Cue, 0, len(silenced))
	for _, cue := range silenced {
		if cue.Silence {
			// A silenced echo has no speech to fit; keep its slot as-is.
			prepared = append(prepared, cue)
			continue
		}
		parts := splitSpeechTextParts(cue.Text)
		if len(parts) <= 1 {
			prepared = append(prepared, cue)
			continue
		}
		stats.SplitCues++
		stats.SplitParts += len(parts)
		prepared = append(prepared, allocateSpeechSlots(cue, parts)...)
	}

	for i := range prepared {
		prepared[i].Index = i + 1
	}
	return prepared, stats
}

// silenceEchoCues marks every echo copy after the first as a silence cue.
// Echo windows anchor on the latest spoken occurrence, so the voice reads the
// line at most once per echoWindowSeconds.
func silenceEchoCues(cues []Cue, stats *SpeechPrepStats) []Cue {
	out := make([]Cue, len(cues))
	copy(out, cues)

	spokenStart := make(map[string]float64, len(cues))
	for i := range out {
		key := speechEchoKey(out[i].Text)
		if key == "" {
			continue
		}
		if start, seen := spokenStart[key]; seen && out[i].Start-start < echoWindowSeconds {
			// The copy becomes a silence cue: same slot, no speech. The text
			// is blanked so every downstream speech consumer sees silence,
			// with Silence keeping the reason explicit.
			out[i].Silence = true
			out[i].Text = ""
			stats.EchoSilenced++
			stats.EchoSilencedIndexes = append(stats.EchoSilencedIndexes, out[i].Index)
			continue
		}
		spokenStart[key] = out[i].Start
	}
	return out
}

// speechEchoKey folds a cue text for echo comparison: case and whitespace
// differences do not matter.
func speechEchoKey(text string) string {
	return strings.ToLower(strings.Join(strings.Fields(text), " "))
}

// splitSpeechTextParts returns 2-3 balanced text parts for a cue longer than
// maxSpeechCueRunes, or nil when the cue needs no split.
func splitSpeechTextParts(text string) []string {
	runes := []rune(strings.TrimSpace(text))
	total := len(runes)
	if total <= maxSpeechCueRunes {
		return nil
	}

	parts := 2
	if total > maxSpeechCueRunes*2 {
		parts = maxSpeechCueParts
	}

	cuts := speechCutPoints(runes, parts)
	segments := make([]string, 0, parts)
	begin := 0
	for _, cut := range cuts {
		segments = append(segments, strings.TrimSpace(string(runes[begin:cut])))
		begin = cut
	}
	segments = append(segments, strings.TrimSpace(string(runes[begin:])))

	nonEmpty := make([]string, 0, len(segments))
	for _, segment := range segments {
		if segment != "" {
			nonEmpty = append(nonEmpty, segment)
		}
	}
	if len(nonEmpty) <= 1 {
		return nil
	}
	return nonEmpty
}

// speechCutPoints chooses cut positions between parts. Cuts prefer sentence
// punctuation, then softer punctuation, then whitespace, staying as close to
// the proportional middle as possible; text without any separator is cut at
// the middle itself.
func speechCutPoints(runes []rune, parts int) []int {
	total := len(runes)
	window := total / (parts * 4)
	if window < 6 {
		window = 6
	}

	cuts := make([]int, 0, parts-1)
	prev := 0
	for k := 1; k < parts; k++ {
		ideal := total * k / parts
		if ideal <= prev {
			ideal = prev + 1
		}
		if ideal >= total {
			ideal = total - 1
		}
		cut := bestSpeechCut(runes, prev, ideal, window)
		if cut <= prev || cut >= total {
			cut = ideal
		}
		cuts = append(cuts, cut)
		prev = cut
	}
	return cuts
}

func bestSpeechCut(runes []rune, prev, ideal, window int) int {
	low := prev + 1
	if low < ideal-window {
		low = ideal - window
	}
	high := len(runes) - 1
	if high > ideal+window {
		high = ideal + window
	}
	if low > high {
		return ideal
	}

	bestCut := ideal
	bestScore := -1
	for cut := low; cut <= high; cut++ {
		score := 0
		switch previous := runes[cut-1]; {
		case isSentenceEndRune(previous):
			score = 3
		case isSoftPunctuationRune(previous):
			score = 2
		case previous == ' ':
			score = 1
		}
		if score < bestScore {
			continue
		}
		if score > bestScore || abs(cut-ideal) < abs(bestCut-ideal) {
			bestScore = score
			bestCut = cut
		}
	}
	return bestCut
}

func isSentenceEndRune(r rune) bool {
	switch r {
	case '.', '!', '?', '。', '！', '？', '…':
		return true
	}
	return false
}

func isSoftPunctuationRune(r rune) bool {
	switch r {
	case ',', ';', ':', '，', '、', '；', '：':
		return true
	}
	return false
}

// allocateSpeechSlots divides the cue window between the text parts, each
// getting a share proportional to its content so fitting per part stays fair.
func allocateSpeechSlots(cue Cue, parts []string) []Cue {
	weights := make([]float64, len(parts))
	weightSum := 0.0
	for i, part := range parts {
		weight := float64(nonSpaceRuneCount(part))
		if weight <= 0 {
			weight = 1
		}
		weights[i] = weight
		weightSum += weight
	}

	out := make([]Cue, 0, len(parts))
	start := cue.Start
	for i, part := range parts {
		end := cue.End
		if i < len(parts)-1 && weightSum > 0 {
			end = start + cue.Duration()*weights[i]/weightSum
		}
		out = append(out, Cue{Index: cue.Index, Start: start, End: end, Text: part})
		start = end
	}
	return out
}

func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
