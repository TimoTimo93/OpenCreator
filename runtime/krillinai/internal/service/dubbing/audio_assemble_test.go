package dubbing

import (
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAssembleAudioWritesConcatListInFittedDir(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rawDir, "1.wav"), []byte("raw"), 0644); err != nil {
		t.Fatal(err)
	}
	plan := []PlanItem{{Index: 1, NewStart: 0.5, NewEnd: 1.3, SpeedFactor: 1.0}}
	err := AssembleAudio(plan, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		return os.WriteFile(args[len(args)-1], []byte("media"), 0644)
	})
	if err != nil {
		t.Fatalf("AssembleAudio() error = %v", err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "fitted", "concat.txt"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "silence_1.wav") || !strings.Contains(string(data), "1.wav") {
		t.Fatalf("concat list = %q", string(data))
	}
}

func TestAssembleAudioRejectsInvalidWindowBeforeRunner(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rawDir, "1.wav"), []byte("raw"), 0644); err != nil {
		t.Fatal(err)
	}
	calls := 0
	plan := []PlanItem{{Index: 1, NewStart: 1.0, NewEnd: 1.0, SpeedFactor: 1.0}}
	err := AssembleAudio(plan, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		calls++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "new end must be greater than new start") {
		t.Fatalf("AssembleAudio() error = %v, want invalid window error", err)
	}
	if calls != 0 {
		t.Fatalf("runner calls = %d, want 0", calls)
	}
}

func TestAssembleAudioRejectsOverlappingPlanBeforeRunner(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"1.wav", "2.wav"} {
		if err := os.WriteFile(filepath.Join(rawDir, name), []byte("raw"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	calls := 0
	plan := []PlanItem{
		{Index: 1, NewStart: 1.0, NewEnd: 2.0, SpeedFactor: 1.0},
		{Index: 2, NewStart: 0.5, NewEnd: 1.5, SpeedFactor: 1.0},
	}
	err := AssembleAudio(plan, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		calls++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "starts before previous end") {
		t.Fatalf("AssembleAudio() error = %v, want overlap error", err)
	}
	if calls != 0 {
		t.Fatalf("runner calls = %d, want 0", calls)
	}
}

func TestAssembleAudioRejectsInvalidSpeedFactorBeforeRunner(t *testing.T) {
	tests := []struct {
		name        string
		speedFactor float64
	}{
		{name: "zero", speedFactor: 0},
		{name: "infinity", speedFactor: math.Inf(1)},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			dir := t.TempDir()
			rawDir := filepath.Join(dir, "raw")
			if err := os.MkdirAll(rawDir, 0755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(rawDir, "1.wav"), []byte("raw"), 0644); err != nil {
				t.Fatal(err)
			}
			calls := 0
			plan := []PlanItem{{Index: 1, NewStart: 0, NewEnd: 1, SpeedFactor: tt.speedFactor}}
			err := AssembleAudio(plan, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
				calls++
				t.Fatalf("runner called with args = %v", args)
				return nil
			})
			if err == nil {
				t.Fatal("AssembleAudio() error = nil, want invalid speed factor error")
			}
			if calls != 0 {
				t.Fatalf("runner calls = %d, want 0", calls)
			}
		})
	}
}

func TestAssembleAudioRejectsMissingRawSegmentBeforeRunner(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	calls := 0
	plan := []PlanItem{{Index: 1, NewStart: 0, NewEnd: 1, SpeedFactor: 1}}
	err := AssembleAudio(plan, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		calls++
		t.Fatalf("runner called with args = %v", args)
		return nil
	})
	if err == nil {
		t.Fatal("AssembleAudio() error = nil, want missing raw segment error")
	}
	if calls != 0 {
		t.Fatalf("runner calls = %d, want 0", calls)
	}
}

func TestAssembleAudioRejectsEmptyPlan(t *testing.T) {
	dir := t.TempDir()
	calls := 0
	err := AssembleAudio(nil, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		calls++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "plan is empty") {
		t.Fatalf("AssembleAudio() error = %v, want empty plan error", err)
	}
	if calls != 0 {
		t.Fatalf("runner calls = %d, want 0", calls)
	}
}

func TestAssembleChunkAudioUsesPerItemSegmentsWithOriginalPauses(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"chunk_1.wav", "1.wav", "2.wav"} {
		if err := os.WriteFile(filepath.Join(rawDir, name), []byte("raw"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	plan := []PlanItem{
		{Index: 1, OriginalStart: 0, OriginalEnd: 1, NewStart: 1, NewEnd: 2, SpeedFactor: 1, ChunkID: 1},
		{Index: 2, OriginalStart: 1.5, OriginalEnd: 2.5, NewStart: 2.5, NewEnd: 4, SpeedFactor: 1, ChunkID: 1},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0, 1}, Start: 1, End: 4, SpeedFactor: 1},
	}
	gapSilenceDuration := ""
	fittedInputs := []string{}

	err := AssembleChunkAudio(plan, chunks, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		out := args[len(args)-1]
		for i, arg := range args {
			if arg == "-i" && i+1 < len(args) {
				fittedInputs = append(fittedInputs, args[i+1])
			}
			if arg == "-t" && i+1 < len(args) && strings.Contains(out, "gap") {
				gapSilenceDuration = args[i+1]
			}
		}
		return os.WriteFile(out, []byte("media"), 0644)
	})
	if err != nil {
		t.Fatalf("AssembleChunkAudio() error = %v", err)
	}
	var rawInputs []string
	for _, in := range fittedInputs {
		switch filepath.Base(in) {
		case "1.wav", "2.wav":
			if strings.Contains(in, "raw") {
				rawInputs = append(rawInputs, in)
			}
		}
	}
	if len(rawInputs) != 2 {
		t.Fatalf("raw per-cue inputs = %+v, want the two per-cue raw segment files", rawInputs)
	}
	if gapSilenceDuration != "0.500" {
		t.Fatalf("pause between cues = %q, want the original 0.500s gap", gapSilenceDuration)
	}
	data, err := os.ReadFile(filepath.Join(dir, "fitted", "concat.txt"))
	if err != nil {
		t.Fatal(err)
	}
	joined := string(data)
	if !strings.Contains(joined, "1.wav") || !strings.Contains(joined, "silence_chunk_1_gap_0.wav") || !strings.Contains(joined, "2.wav") {
		t.Fatalf("concat list = %q, want item segments interleaved with the pause", joined)
	}
}

func TestAssembleChunkAudioUsesOneRawFilePerSingleCueChunk(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rawDir, "chunk_1.wav"), []byte("raw"), 0644); err != nil {
		t.Fatal(err)
	}
	plan := []PlanItem{
		{Index: 1, NewStart: 1, NewEnd: 4, SpeedFactor: 1, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0}, Start: 1, End: 4, ActualDuration: 3, SpeedFactor: 1}}
	var fittedInputs []string

	err := AssembleChunkAudio(plan, chunks, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		for i, arg := range args {
			if arg == "-i" && i+1 < len(args) {
				fittedInputs = append(fittedInputs, args[i+1])
			}
		}
		return os.WriteFile(args[len(args)-1], []byte("media"), 0644)
	})
	if err != nil {
		t.Fatalf("AssembleChunkAudio() error = %v", err)
	}
	var chunkInputs []string
	for _, in := range fittedInputs {
		if strings.HasSuffix(filepath.Base(in), "chunk_1.wav") && !strings.Contains(filepath.Base(in), "silence") {
			chunkInputs = append(chunkInputs, in)
		}
	}
	if len(chunkInputs) < 1 {
		t.Fatalf("fitted inputs = %+v, want the raw chunk file", fittedInputs)
	}
	if strings.Contains(strings.Join(fittedInputs, " "), filepath.Join("raw", "1.wav")) {
		t.Fatalf("fitted inputs = %+v, single-cue chunks should keep the chunk wav path", fittedInputs)
	}
}

func TestAssembleChunkAudioRejectsMissingRawItemSegment(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(rawDir, "1.wav"), []byte("raw"), 0644); err != nil {
		t.Fatal(err)
	}
	calls := 0
	plan := []PlanItem{
		{Index: 1, NewStart: 0, NewEnd: 1, SpeedFactor: 1, ChunkID: 1},
		{Index: 2, NewStart: 1, NewEnd: 2, SpeedFactor: 1, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0, 1}, Start: 0, End: 2, SpeedFactor: 1}}
	err := AssembleChunkAudio(plan, chunks, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		calls++
		return os.WriteFile(args[len(args)-1], []byte("media"), 0644)
	})
	if err == nil || !strings.Contains(err.Error(), "raw chunk segment") {
		t.Fatalf("AssembleChunkAudio() error = %v, want missing raw chunk segment error", err)
	}
	if calls != 0 {
		t.Fatalf("runner calls = %d, want 0", calls)
	}
}

func TestAssembleChunkAudioPreservesGapAfterShortChunkAudio(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"chunk_1.wav", "chunk_2.wav"} {
		if err := os.WriteFile(filepath.Join(rawDir, name), []byte("raw"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	plan := []PlanItem{
		{Index: 1, NewStart: 0, NewEnd: 3, SpeedFactor: 1, ChunkID: 1},
		{Index: 2, NewStart: 7, NewEnd: 8, SpeedFactor: 1, ChunkID: 2},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0}, Start: 0, End: 5, ActualDuration: 3, SpeedFactor: 1},
		{ID: 2, Items: []int{1}, Start: 7, End: 8, ActualDuration: 1, SpeedFactor: 1},
	}
	silenceDuration := ""

	err := AssembleChunkAudio(plan, chunks, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		out := args[len(args)-1]
		if strings.Contains(out, "silence_chunk_2.wav") {
			for i, arg := range args {
				if arg == "-t" && i+1 < len(args) {
					silenceDuration = args[i+1]
				}
			}
		}
		return os.WriteFile(out, []byte("media"), 0644)
	})
	if err != nil {
		t.Fatalf("AssembleChunkAudio() error = %v", err)
	}
	if silenceDuration != "4.000" {
		t.Fatalf("silence before second chunk = %q, want 4.000", silenceDuration)
	}
}

func TestAssembleChunkAudioAllowsFloatingPointBoundaryNoise(t *testing.T) {
	dir := t.TempDir()
	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"chunk_16.wav", "chunk_17.wav"} {
		if err := os.WriteFile(filepath.Join(rawDir, name), []byte("raw"), 0644); err != nil {
			t.Fatal(err)
		}
	}
	plan := []PlanItem{
		{Index: 42, NewStart: 96.84, NewEnd: 111.00000000000001, SpeedFactor: 1.028, ChunkID: 16},
		{Index: 43, NewStart: 111, NewEnd: 114.08, SpeedFactor: 1, ChunkID: 17},
	}
	chunks := []Chunk{
		{ID: 16, Items: []int{0}, Start: 96.84, End: 111, ActualDuration: 14.56, SpeedFactor: 1.028},
		{ID: 17, Items: []int{1}, Start: 111, End: 114.08, ActualDuration: 3.08, SpeedFactor: 1},
	}

	err := AssembleChunkAudio(plan, chunks, dir, filepath.Join(dir, "out.wav"), func(args []string) error {
		return os.WriteFile(args[len(args)-1], []byte("media"), 0644)
	})
	if err != nil {
		t.Fatalf("AssembleChunkAudio() error = %v, want floating-point boundary accepted", err)
	}
}
