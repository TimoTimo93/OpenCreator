package dubbing

import (
	"strings"
	"testing"
)

func TestPrepareSpeechCuesSilencesEchoDuplicatesKeepingFirst(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 10.0, End: 10.5, Text: "Lại là thiên phú"},
		{Index: 2, Start: 11.2, End: 12.2, Text: "Lại là thiên phú"},
		{Index: 3, Start: 12.8, End: 13.0, Text: "Lại là thiên phú"},
		{Index: 4, Start: 14.0, End: 15.5, Text: "Khác hoàn toàn"},
	}
	got, stats := PrepareSpeechCues(cues)
	if len(got) != len(cues) {
		t.Fatalf("len(cues) = %d, want %d: echoed slots must survive as silence", len(got), len(cues))
	}
	if got[0].Silence || got[0].Text != "Lại là thiên phú" {
		t.Fatalf("first echo occurrence must stay spoken: %+v", got[0])
	}
	for _, i := range []int{1, 2} {
		if !got[i].Silence || got[i].Text != "" {
			t.Fatalf("cue %d must become a silence cue: %+v", i+1, got[i])
		}
		if got[i].Start != cues[i].Start || got[i].End != cues[i].End {
			t.Fatalf("silence cue %d slot moved: %.3f-%.3f, want %.3f-%.3f",
				i+1, got[i].Start, got[i].End, cues[i].Start, cues[i].End)
		}
	}
	if got[3].Silence || got[3].Text != "Khác hoàn toàn" {
		t.Fatalf("unrelated cue must stay spoken: %+v", got[3])
	}
	for i, cue := range got {
		if cue.Index != i+1 {
			t.Fatalf("cue %d index = %d, want renumbered %d", i+1, cue.Index, i+1)
		}
	}
	if stats.EchoSilenced != 2 {
		t.Fatalf("EchoSilenced = %d, want 2", stats.EchoSilenced)
	}
	if len(stats.EchoSilencedIndexes) != 2 || stats.EchoSilencedIndexes[0] != 2 || stats.EchoSilencedIndexes[1] != 3 {
		t.Fatalf("EchoSilencedIndexes = %v, want source indexes [2 3]", stats.EchoSilencedIndexes)
	}
	if stats.SplitCues != 0 || stats.SplitParts != 0 {
		t.Fatalf("split stats = %+v, want zero", stats)
	}
}

func TestPrepareSpeechCuesEchoKeyIgnoresCaseAndWhitespace(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 1.0, Text: "Lại là thiên phú"},
		{Index: 2, Start: 1.2, End: 2.2, Text: "  lại  LÀ Thiên\tphú "},
	}
	got, stats := PrepareSpeechCues(cues)
	if !got[1].Silence {
		t.Fatalf("case/whitespace variants must count as echo: %+v", got[1])
	}
	if stats.EchoSilenced != 1 {
		t.Fatalf("EchoSilenced = %d, want 1", stats.EchoSilenced)
	}
}

func TestPrepareSpeechCuesKeepsIntentionalRepetitionBeyondWindow(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 1.2, Text: "Chào"},
		{Index: 2, Start: 5.0, End: 6.2, Text: "Chào"},
	}
	got, stats := PrepareSpeechCues(cues)
	if got[0].Silence || got[1].Silence {
		t.Fatalf("repetition beyond the echo window is intentional: %+v", got)
	}
	if stats.EchoSilenced != 0 {
		t.Fatalf("EchoSilenced = %d, want 0", stats.EchoSilenced)
	}
}

func TestPrepareSpeechCuesSilencesAgainWithinNextWindow(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0.0, End: 1.2, Text: "Chào"},
		{Index: 2, Start: 3.5, End: 4.7, Text: "Chào"},
		{Index: 3, Start: 6.5, End: 7.7, Text: "Chào"},
		{Index: 4, Start: 8.0, End: 9.2, Text: "Chào"},
	}
	got, stats := PrepareSpeechCues(cues)
	// Windows anchor on the latest spoken occurrence: 3.5 echoes 0, 6.5 is a
	// fresh occurrence (6.5s after the spoken one), 8.0 echoes 6.5.
	wantSilence := map[int]bool{1: true, 3: true}
	for i, cue := range got {
		if cue.Silence != wantSilence[i] {
			t.Fatalf("cue %d silence = %v, want %v", i+1, cue.Silence, wantSilence[i])
		}
	}
	if stats.EchoSilenced != 2 {
		t.Fatalf("EchoSilenced = %d, want 2", stats.EchoSilenced)
	}
}

func TestPrepareSpeechCuesSplitsLongCueAtPunctuationNearMiddle(t *testing.T) {
	text := strings.Repeat("abcdefghij", 5) + ", " + strings.Repeat("klmnopqrst", 5)
	got, stats := PrepareSpeechCues([]Cue{{Index: 7, Start: 0, End: 6.0, Text: text}})
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2 parts: %+v", len(got), got)
	}
	if stats.SplitCues != 1 || stats.SplitParts != 2 {
		t.Fatalf("split stats = %+v, want one cue split into 2 parts", stats)
	}
	if !strings.HasSuffix(got[0].Text, ",") {
		t.Fatalf("first part = %q, want the cut right after the comma", got[0].Text)
	}
	if got[0].Start != 0 || got[0].End != got[1].Start || got[1].End != 6.0 {
		t.Fatalf("part slots must tile the original window: %.3f-%.3f, %.3f-%.3f",
			got[0].Start, got[0].End, got[1].Start, got[1].End)
	}
	if joined := got[0].Text + " " + got[1].Text; joined != text {
		t.Fatalf("joined parts = %q, want the original text", joined)
	}
	if got[0].Duration() <= got[1].Duration() {
		t.Fatalf("part slots must follow text weight: %.3f vs %.3f", got[0].Duration(), got[1].Duration())
	}
	if got[0].Index != 1 || got[1].Index != 2 {
		t.Fatalf("indexes = %d %d, want renumbered 1 2", got[0].Index, got[1].Index)
	}
}

func TestPrepareSpeechCuesSplitsVeryLongCueIntoThreeParts(t *testing.T) {
	text := strings.Repeat("abcdefghij", 21)
	got, stats := PrepareSpeechCues([]Cue{{Index: 1, Start: 0, End: 9.0, Text: text}})
	if len(got) != 3 {
		t.Fatalf("len(cues) = %d, want 3 parts: %+v", len(got), got)
	}
	if stats.SplitCues != 1 || stats.SplitParts != 3 {
		t.Fatalf("split stats = %+v, want one cue split into 3 parts", stats)
	}
	for i, cue := range got {
		if n := len([]rune(cue.Text)); n > maxSpeechCueRunes {
			t.Fatalf("part %d has %d runes, want at most %d", i+1, n, maxSpeechCueRunes)
		}
		if strings.TrimSpace(cue.Text) == "" {
			t.Fatalf("part %d is empty: %+v", i+1, cue)
		}
	}
	if joined := got[0].Text + got[1].Text + got[2].Text; joined != text {
		t.Fatalf("joined parts = %q, want the original text", joined)
	}
	if got[0].End != got[1].Start || got[1].End != got[2].Start || got[2].End != 9.0 {
		t.Fatalf("part slots must tile the original window: %+v", got)
	}
}

func TestPrepareSpeechCuesLeavesHealthyCuesUntouched(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 1.5, Text: "một"},
		{Index: 2, Start: 2.0, End: 4.0, Text: strings.Repeat("a", maxSpeechCueRunes)},
	}
	got, stats := PrepareSpeechCues(cues)
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2 unchanged cues", len(got))
	}
	if got[0].Text != "một" || got[1].Text != strings.Repeat("a", maxSpeechCueRunes) {
		t.Fatalf("healthy cues changed: %+v", got)
	}
	if got[0].Start != 0 || got[0].End != 1.5 || got[1].Start != 2.0 || got[1].End != 4.0 {
		t.Fatalf("healthy cue slots moved: %+v", got)
	}
	if stats.EchoSilenced != 0 || stats.SplitCues != 0 || stats.SplitParts != 0 || len(stats.EchoSilencedIndexes) != 0 {
		t.Fatalf("stats = %+v, want zero for healthy input", stats)
	}
}

func TestPrepareSpeechCuesDoesNotSplitSilencedEchoCue(t *testing.T) {
	long := strings.Repeat("abcdefghij", 10)
	cues := []Cue{
		{Index: 1, Start: 0, End: 2.0, Text: long},
		{Index: 2, Start: 2.2, End: 6.0, Text: long},
	}
	got, stats := PrepareSpeechCues(cues)
	if len(got) != 3 {
		t.Fatalf("len(cues) = %d, want 2 split parts + 1 silence slot: %+v", len(got), got)
	}
	if !got[2].Silence || got[2].Text != "" {
		t.Fatalf("echo copy must stay an unsplit blank silence cue: %+v", got[2])
	}
	if got[2].Start != 2.2 || got[2].End != 6.0 {
		t.Fatalf("silence slot moved: %.3f-%.3f, want 2.200-6.000", got[2].Start, got[2].End)
	}
	if stats.EchoSilenced != 1 || stats.SplitCues != 1 || stats.SplitParts != 2 {
		t.Fatalf("stats = %+v, want echo 1, split 1 cue into 2 parts", stats)
	}
	if len(stats.EchoSilencedIndexes) != 1 || stats.EchoSilencedIndexes[0] != 2 {
		t.Fatalf("EchoSilencedIndexes = %v, want [2]", stats.EchoSilencedIndexes)
	}
}
