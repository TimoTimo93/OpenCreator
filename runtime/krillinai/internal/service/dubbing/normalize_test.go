package dubbing

import "testing"

func floatsEqual(a, b float64) bool {
	return (a-b) < 1e-9 && (b-a) < 1e-9
}

func TestNormalizeDubCuesDedupesEchoCues(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 10.0, End: 10.5, Text: "Lại là thiên phú"},
		{Index: 2, Start: 11.2, End: 12.2, Text: "Lại là thiên phú"},
		{Index: 3, Start: 12.8, End: 13.0, Text: "Lại là thiên phú"},
		{Index: 4, Start: 14.0, End: 15.5, Text: "Khác hoàn toàn"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2 after echo dedupe: %+v", len(got), got)
	}
	if got[0].Start != 11.2 || got[0].End != 12.2 {
		t.Fatalf("kept cue = %.3f --> %.3f, want the longest echo 11.2 --> 12.2", got[0].Start, got[0].End)
	}
	if got[0].Text != "Lại là thiên phú" || got[1].Text != "Khác hoàn toàn" {
		t.Fatalf("texts = %+v", got)
	}
	if got[0].Index != 1 || got[1].Index != 2 {
		t.Fatalf("indexes = %d %d, want renumbered 1 2", got[0].Index, got[1].Index)
	}
}

func TestNormalizeDubCuesKeepsIntentionalRepetitionBeyondWindow(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 1.2, Text: "Chào"},
		{Index: 2, Start: 5.0, End: 6.2, Text: "Chào"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2: echoes beyond the window are intentional", len(got))
	}
}

func TestNormalizeDubCuesMergesShortCuesIntoNeighbours(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 2.0, Text: "Câu dài"},
		{Index: 2, Start: 2.2, End: 2.5, Text: "chớp"},
		{Index: 3, Start: 2.7, End: 4.7, Text: "Câu sau"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2 after short cue merge: %+v", len(got), got)
	}
	if got[1].Start != 2.2 || got[1].End != 4.7 {
		t.Fatalf("merged window = %.3f --> %.3f, want 2.2 --> 4.7", got[1].Start, got[1].End)
	}
	if got[1].Text != "chớp Câu sau" {
		t.Fatalf("merged text = %q, want both texts joined", got[1].Text)
	}
}

func TestNormalizeDubCuesMergesTrailingShortCueIntoPrevious(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 2.0, Text: "Câu dài"},
		{Index: 2, Start: 2.1, End: 2.4, Text: "hết"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 1 {
		t.Fatalf("len(cues) = %d, want 1: trailing short cue merges back", len(got))
	}
	if got[0].End != 2.4 || got[0].Text != "Câu dài hết" {
		t.Fatalf("merged cue = %+v", got[0])
	}
}

func TestNormalizeDubCuesEnforcesMinimumDuration(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 0.7, Text: "nhanh"},
		{Index: 2, Start: 3.0, End: 5.0, Text: "kế tiếp"},
	}
	got := NormalizeDubCues(cues)
	if got[0].End != 1.0 {
		t.Fatalf("first cue end = %.3f, want stretched to 1.0", got[0].End)
	}
}

func TestNormalizeDubCuesClampsExtensionAtNextCue(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 0.7, Text: "nhanh"},
		{Index: 2, Start: 0.9, End: 2.0, Text: "kế tiếp"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 2 {
		t.Fatalf("len(cues) = %d, want 2: a 0.7s cue is short but not merged", len(got))
	}
	if got[0].End != 0.9 {
		t.Fatalf("first cue end = %.3f, want clamped at next start 0.9", got[0].End)
	}
	if !floatsEqual(got[0].Duration(), 0.9) || got[0].Duration() <= 0 {
		t.Fatalf("clamped cue must keep a positive duration: %+v", got[0])
	}
}

func TestNormalizeDubCuesKeepsHealthyCuesUntouched(t *testing.T) {
	cues := []Cue{
		{Index: 1, Start: 0, End: 1.5, Text: "một"},
		{Index: 2, Start: 2.0, End: 4.0, Text: "hai"},
	}
	got := NormalizeDubCues(cues)
	if len(got) != 2 || got[0].Start != 0 || got[0].End != 1.5 || got[1].Start != 2.0 || got[1].End != 4.0 {
		t.Fatalf("healthy cues changed: %+v", got)
	}
}
