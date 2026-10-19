package dubbing

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeTTS struct {
	failures      int
	calls         int
	texts         []string
	writeOnReturn bool
}

func (f *fakeTTS) Text2Speech(text, voice, outputFile string) error {
	f.calls++
	f.texts = append(f.texts, text)
	if f.calls <= f.failures {
		return errors.New("tts failed")
	}
	if !f.writeOnReturn {
		return nil
	}
	return os.WriteFile(outputFile, []byte("wav"), 0644)
}

func TestGenerateRawSegmentsRetriesAndWritesFiles(t *testing.T) {
	dir := t.TempDir()
	tts := &fakeTTS{failures: 1, writeOnReturn: true}
	plan := []PlanItem{{Index: 1, SpokenText: "你好"}}
	got, err := GenerateRawSegments(context.Background(), tts, plan, "voice", dir, nil, func(string) (float64, error) {
		return 1.2, nil
	})
	if err != nil {
		t.Fatalf("GenerateRawSegments() error = %v", err)
	}
	if tts.calls != 2 {
		t.Fatalf("calls = %d, want 2", tts.calls)
	}
	if got[0].ActualDuration != 1.2 {
		t.Fatalf("ActualDuration = %v", got[0].ActualDuration)
	}
	if _, err := os.Stat(filepath.Join(dir, "raw", "1.wav")); err != nil {
		t.Fatalf("raw file missing: %v", err)
	}
}

func TestRetryTTSRejectsNonPositiveAttempts(t *testing.T) {
	err := retryTTS(&fakeTTS{}, "hello", "voice", filepath.Join(t.TempDir(), "out.wav"), 0)
	if err == nil || !strings.Contains(err.Error(), "attempts must be > 0") {
		t.Fatalf("retryTTS() error = %v, want attempts validation", err)
	}
}

func TestRetryTTSDoesNotTreatStaleOutputAsSuccess(t *testing.T) {
	output := filepath.Join(t.TempDir(), "out.wav")
	if err := os.WriteFile(output, []byte("stale"), 0644); err != nil {
		t.Fatalf("write stale output: %v", err)
	}

	tts := &fakeTTS{writeOnReturn: false}
	err := retryTTS(tts, "hello", "voice", output, 1)
	if err == nil {
		t.Fatal("retryTTS() error = nil, want missing output error")
	}
	if _, statErr := os.Stat(output); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("stale output stat error = %v, want removed output", statErr)
	}
}

func TestGenerateRawSegmentsWrapsDurationProbeError(t *testing.T) {
	dir := t.TempDir()
	tts := &fakeTTS{writeOnReturn: true}
	plan := []PlanItem{{Index: 1, SpokenText: "你好"}}

	_, err := GenerateRawSegments(context.Background(), tts, plan, "voice", dir, nil, func(string) (float64, error) {
		return 0, errors.New("probe failed")
	})
	if err == nil {
		t.Fatal("GenerateRawSegments() error = nil, want duration error")
	}
	output := filepath.Join(dir, "raw", "1.wav")
	if !strings.Contains(err.Error(), "measure segment 1 duration failed") || !strings.Contains(err.Error(), output) {
		t.Fatalf("GenerateRawSegments() error = %q, want segment index and output path", err)
	}
}

func TestGenerateRawChunkSegmentsSynthesizesPerCueInMultiCueChunks(t *testing.T) {
	dir := t.TempDir()
	tts := &fakeTTS{writeOnReturn: true}
	plan := []PlanItem{
		{Index: 1, SpokenText: "我认为学习速记是一项技能"},
		{Index: 2, SpokenText: "它能够改变你的人生。"},
		{Index: 3, SpokenText: "学习是免费的。"},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0, 1}, Start: 0, End: 5},
		{ID: 2, Items: []int{2}, Start: 6, End: 8},
	}

	var progress [][2]int
	gotPlan, gotChunks, err := GenerateRawChunkSegments(
		context.Background(),
		tts,
		plan,
		chunks,
		"voice",
		dir,
		nil,
		func(path string) (float64, error) {
			switch {
			case strings.Contains(path, "chunk_2.wav"):
				return 1.1, nil
			case strings.HasSuffix(path, "1.wav"):
				return 1.4, nil
			case strings.HasSuffix(path, "2.wav"):
				return 1.6, nil
			default:
				return 0, errors.New("unexpected probe path " + path)
			}
		},
		func(completed, total int) {
			progress = append(progress, [2]int{completed, total})
		},
	)
	if err != nil {
		t.Fatalf("GenerateRawChunkSegments() error = %v", err)
	}
	if tts.calls != 3 {
		t.Fatalf("TTS calls = %d, want one call per cue in the multi-cue chunk plus the single-cue chunk", tts.calls)
	}
	if got := tts.texts[0]; got != "我认为学习速记是一项技能" || got == "我认为学习速记是一项技能 它能够改变你的人生。" {
		t.Fatalf("first TTS text = %q, want per-cue text without joined sentences", got)
	}
	if got := tts.texts[1]; got != "它能够改变你的人生。" {
		t.Fatalf("second TTS text = %q, want the second cue alone", got)
	}
	if gotPlan[0].ActualDuration != 1.4 || gotPlan[1].ActualDuration != 1.6 {
		t.Fatalf("item actual durations = %.2f %.2f, want per-cue measurements", gotPlan[0].ActualDuration, gotPlan[1].ActualDuration)
	}
	if gotChunks[0].ActualDuration != 0 {
		t.Fatalf("multi-cue chunk duration = %v, want unset so item actuals are summed", gotChunks[0].ActualDuration)
	}
	if gotChunks[1].ActualDuration != 1.1 {
		t.Fatalf("single-cue chunk duration = %v, want chunk measurement", gotChunks[1].ActualDuration)
	}
	if len(progress) != 2 || progress[0] != [2]int{1, 2} || progress[1] != [2]int{2, 2} {
		t.Fatalf("progress = %+v, want [[1 2] [2 2]]", progress)
	}
	for _, name := range []string{"1.wav", "2.wav", "chunk_2.wav"} {
		if _, err := os.Stat(filepath.Join(dir, "raw", name)); err != nil {
			t.Fatalf("raw file %s missing: %v", name, err)
		}
	}
}

func TestGenerateRawChunkSegmentsWritesSilenceForSilenceOnlyCue(t *testing.T) {
	dir := t.TempDir()
	tts := &fakeTTS{writeOnReturn: true}
	plan := []PlanItem{
		{Index: 1, SpokenText: "你好"},
		{Index: 2, SpokenText: "（音乐）"},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0, 1}, Start: 0, End: 4}}

	silenceRuns := 0
	_, _, err := GenerateRawChunkSegments(
		context.Background(),
		tts,
		plan,
		chunks,
		"voice",
		dir,
		func(args []string) error {
			out := args[len(args)-1]
			if strings.Contains(out, "2.wav") {
				silenceRuns++
			}
			return os.WriteFile(out, []byte("media"), 0644)
		},
		func(string) (float64, error) { return 0.5, nil },
		nil,
	)
	if err != nil {
		t.Fatalf("GenerateRawChunkSegments() error = %v", err)
	}
	if tts.calls != 1 {
		t.Fatalf("TTS calls = %d, want a single call for the spoken cue", tts.calls)
	}
	if silenceRuns != 1 {
		t.Fatalf("silence writer runs = %d, want 1 for the music cue", silenceRuns)
	}
}
