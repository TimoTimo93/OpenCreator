package dubbing

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func readTestJSON(t *testing.T, path string, out any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

func fakeRunnerWritingOutputs(dir string) CommandRunner {
	return func(args []string) error {
		out := args[len(args)-1]
		if strings.HasSuffix(out, ".wav") || strings.HasSuffix(out, ".mp4") {
			return os.WriteFile(out, []byte("media"), 0644)
		}
		return nil
	}
}

func fakeRunnerWritingOutputsWithoutMkdir() CommandRunner {
	return func(args []string) error {
		out := args[len(args)-1]
		if strings.HasSuffix(out, ".wav") || strings.HasSuffix(out, ".mp4") {
			return os.WriteFile(out, []byte("media"), 0644)
		}
		return nil
	}
}

func TestAudioOnlyRunnerDoesNotRequireOrMuxVideo(t *testing.T) {
	root := t.TempDir()
	input := filepath.Join(root, "input.srt")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n你好\n\n"), 0600); err != nil {
		t.Fatal(err)
	}
	result, err := NewRunner(Dependencies{
		TTS: &fakeTTS{writeOnReturn: true}, Language: "zh_cn", Voice: "voice", Workdir: root, InputSRT: input, AudioOnly: true,
		OutputAudio: filepath.Join(root, "output.wav"), Config: DefaultConfig(),
		FFmpeg: func(args []string) error {
			if strings.HasSuffix(args[len(args)-1], ".mp4") {
				t.Fatal("audio-only runner attempted video muxing")
			}
			return fakeRunnerWritingOutputs(root)(args)
		},
		Duration: func(string) (float64, error) { return 0.8, nil },
	}).Run(context.Background())
	if err != nil || result.Audio == "" || result.Video != "" {
		t.Fatalf("result = %+v, error = %v", result, err)
	}
}

func TestRunWritesDubbingArtifactsWithFakeTTS(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n你好\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	result, err := NewRunner(deps).Run(context.Background())
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	for _, path := range []string{
		filepath.Join(dir, DubbingDirName, DubbingInputFileName),
		filepath.Join(dir, DubbingDirName, DubbingPlanFileName),
		filepath.Join(dir, DubbingDirName, DubbingReportName),
		filepath.Join(dir, DubbingDirName, DubSubtitleFileName),
		result.Audio,
		result.Video,
	} {
		if info, err := os.Stat(path); err != nil || info.Size() == 0 {
			t.Fatalf("missing output %s: info=%v err=%v", path, info, err)
		}
	}
}

func TestRunWritesCleanedDubbingInput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n(music) 你好 ™\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	if _, err := NewRunner(deps).Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	data, err := os.ReadFile(filepath.Join(dir, DubbingDirName, DubbingInputFileName))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	if strings.Contains(text, "music") || strings.Contains(text, "™") {
		t.Fatalf("dubbing input contains unclean text: %q", text)
	}
	if !strings.Contains(text, "你好") {
		t.Fatalf("dubbing input missing speech text: %q", text)
	}
}

func TestRunPreservesIntraChunkPauseAndPerCueSegments(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	// Two short cues separated by a 0.1s pause merge into one chunk; the
	// pause must survive as silence between the per-cue segments.
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:00,800\n你好\n\n2\n00:00:00,900 --> 00:00:02,000\n世界\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	result, err := NewRunner(deps).Run(context.Background())
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	concat, err := os.ReadFile(filepath.Join(dir, DubbingDirName, "segments", "fitted", "concat.txt"))
	if err != nil {
		t.Fatal(err)
	}
	joined := string(concat)
	if !strings.Contains(joined, "silence_chunk_1_gap_0.wav") {
		t.Fatalf("concat list = %q, want the original inter-cue pause as silence", joined)
	}
	if !strings.Contains(joined, "1.wav") || !strings.Contains(joined, "2.wav") {
		t.Fatalf("concat list = %q, want per-cue segment files", joined)
	}

	dubSRT, err := os.ReadFile(result.DubSRT)
	if err != nil {
		t.Fatal(err)
	}
	// Speech fills 0 --> 0.8, the original 0.1s pause follows, then the second
	// cue; both are stretched to the 1.0s minimum display time where possible.
	if !strings.Contains(string(dubSRT), "00:00:00,000 --> 00:00:00,900") {
		t.Fatalf("dub.srt = %q, want first cue clamped at the second cue start", string(dubSRT))
	}
}

func TestRunRejectsEmptySRTBeforeWritingArtifacts(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	if err := os.WriteFile(input, []byte(""), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}

	_, err := NewRunner(deps).Run(context.Background())
	if err == nil || !strings.Contains(err.Error(), "input srt has no cues") {
		t.Fatalf("Run() error = %v, want no cues error", err)
	}
	if _, statErr := os.Stat(filepath.Join(dir, DubbingDirName, DubbingInputFileName)); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatalf("dubbing input stat error = %v, want not exist", statErr)
	}
}

func TestRunCreatesCustomOutputParentDirs(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	outputAudio := filepath.Join(dir, "nested", "audio", "tts_final_audio.wav")
	outputVideo := filepath.Join(dir, "nested", "video", "video_with_tts.mp4")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n你好\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: outputAudio,
		OutputVideo: outputVideo,
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputsWithoutMkdir(),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}

	result, err := NewRunner(deps).Run(context.Background())
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}
	for _, path := range []string{result.Audio, result.Video} {
		if info, err := os.Stat(path); err != nil || info.Size() == 0 {
			t.Fatalf("missing output %s: info=%v err=%v", path, info, err)
		}
	}
}

func TestRunFailsWhenMuxDoesNotCreateOutput(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n你好\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg: func(args []string) error {
			out := args[len(args)-1]
			if strings.HasSuffix(out, ".wav") {
				return os.WriteFile(out, []byte("media"), 0644)
			}
			return nil
		},
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	_, err := NewRunner(deps).Run(context.Background())
	if err == nil {
		t.Fatalf("Run() error = nil, want missing mux output error")
	}
}

func TestRunnerRequiresInputVideoForMux(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:01,000\n你好\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	deps := Dependencies{
		TTS:         &fakeTTS{writeOnReturn: true},
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	_, err := NewRunner(deps).Run(context.Background())
	if err == nil {
		t.Fatalf("Run() error = nil, want missing input video error")
	}
}

func TestRunSilencesEchoDuplicatesForSpeechOnly(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	// ASR echo: the same line three times inside a 4s window. The voice must
	// read it once; the echoed slots stay silent in the dub timeline.
	srt := "1\n00:00:10,000 --> 00:00:10,500\nLại là thiên phú\n\n" +
		"2\n00:00:11,200 --> 00:00:12,200\nLại là thiên phú\n\n" +
		"3\n00:00:12,800 --> 00:00:13,000\nLại là thiên phú\n\n" +
		"4\n00:00:14,000 --> 00:00:15,500\nKhác hoàn toàn\n\n"
	if err := os.WriteFile(input, []byte(srt), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	tts := &fakeTTS{writeOnReturn: true}
	deps := Dependencies{
		TTS:         tts,
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	result, err := NewRunner(deps).Run(context.Background())
	if err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	spoken := map[string]int{}
	for _, text := range tts.texts {
		spoken[text]++
	}
	if spoken["Lại là thiên phú"] != 1 {
		t.Fatalf("echo line spoken %d times, want exactly once: %v", spoken["Lại là thiên phú"], tts.texts)
	}
	if spoken["Khác hoàn toàn"] != 1 {
		t.Fatalf("unrelated line spoken %d times, want once: %v", spoken["Khác hoàn toàn"], tts.texts)
	}

	var report Report
	readTestJSON(t, filepath.Join(dir, DubbingDirName, DubbingReportName), &report)
	if report.EchoSilencedCues != 2 {
		t.Fatalf("echo_silenced_cues = %d, want 2: %+v", report.EchoSilencedCues, report)
	}
	if len(report.EchoSilencedIndexes) != 2 || report.EchoSilencedIndexes[0] != 2 || report.EchoSilencedIndexes[1] != 3 {
		t.Fatalf("echo_silenced_indexes = %v, want [2 3]", report.EchoSilencedIndexes)
	}
	if report.SplitCues != 0 || report.SplitParts != 0 {
		t.Fatalf("split stats = %d/%d, want zero", report.SplitCues, report.SplitParts)
	}

	var plan []PlanItem
	readTestJSON(t, filepath.Join(dir, DubbingDirName, DubbingPlanFileName), &plan)
	if len(plan) != 4 {
		t.Fatalf("plan items = %d, want 4: echoed slots must stay in the timeline", len(plan))
	}
	if plan[0].Silence || plan[0].SpokenText != "Lại là thiên phú" {
		t.Fatalf("first echo occurrence must be spoken: %+v", plan[0])
	}
	for _, i := range []int{1, 2} {
		if !plan[i].Silence || plan[i].SpokenText != "" {
			t.Fatalf("plan item %d must be a silence cue: %+v", i+1, plan[i])
		}
		if plan[i].OriginalStart != []float64{10.0, 11.2, 12.8, 14.0}[i] ||
			plan[i].OriginalEnd != []float64{10.5, 12.2, 13.0, 15.5}[i] {
			t.Fatalf("plan item %d original window = %.3f-%.3f, want the untouched source slot",
				i+1, plan[i].OriginalStart, plan[i].OriginalEnd)
		}
	}
	if plan[3].Silence {
		t.Fatalf("unrelated plan item must stay spoken: %+v", plan[3])
	}

	dubSRT, err := os.ReadFile(result.DubSRT)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Count(string(dubSRT), "Lại là thiên phú"); got != 1 {
		t.Fatalf("dub.srt repeats the echo line %d times, want once: %q", got, string(dubSRT))
	}
}

func TestRunSplitsOverlongCueIntoLighterSegments(t *testing.T) {
	dir := t.TempDir()
	input := filepath.Join(dir, "input.srt")
	video := filepath.Join(dir, "origin.mp4")
	long := "Đầu tiên chúng ta cần chuẩn bị đầy đủ mọi thứ cần thiết, sau đó bắt tay vào việc ngay lập tức để kịp tiến độ"
	if err := os.WriteFile(input, []byte("1\n00:00:00,000 --> 00:00:08,000\n"+long+"\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(video, []byte("video"), 0644); err != nil {
		t.Fatal(err)
	}
	tts := &fakeTTS{writeOnReturn: true}
	deps := Dependencies{
		TTS:         tts,
		Language:    "zh_cn",
		Voice:       "voice",
		Workdir:     dir,
		InputSRT:    input,
		InputVideo:  video,
		OutputAudio: filepath.Join(dir, "tts_final_audio.wav"),
		OutputVideo: filepath.Join(dir, "video_with_tts.mp4"),
		Config:      DefaultConfig(),
		FFmpeg:      fakeRunnerWritingOutputs(dir),
		Duration: func(string) (float64, error) {
			return 0.8, nil
		},
	}
	if _, err := NewRunner(deps).Run(context.Background()); err != nil {
		t.Fatalf("Run() error = %v", err)
	}

	if tts.calls != 2 {
		t.Fatalf("tts calls = %d, want one per split part: %v", tts.calls, tts.texts)
	}

	var plan []PlanItem
	readTestJSON(t, filepath.Join(dir, DubbingDirName, DubbingPlanFileName), &plan)
	if len(plan) != 2 {
		t.Fatalf("plan items = %d, want 2 parts: %+v", len(plan), plan)
	}
	if plan[0].Silence || plan[1].Silence {
		t.Fatalf("split parts must stay spoken: %+v", plan)
	}
	if plan[0].OriginalStart != 0 || plan[1].OriginalEnd != 8 {
		t.Fatalf("part windows = %.3f-%.3f and %.3f-%.3f, want tiling of 0-8",
			plan[0].OriginalStart, plan[0].OriginalEnd, plan[1].OriginalStart, plan[1].OriginalEnd)
	}
	if math.Abs(plan[0].OriginalEnd-plan[1].OriginalStart) > 1e-9 {
		t.Fatalf("part windows must tile the slot: %.3f vs %.3f", plan[0].OriginalEnd, plan[1].OriginalStart)
	}
	if rebuilt := strings.TrimSpace(plan[0].SpokenText + " " + plan[1].SpokenText); rebuilt != long {
		t.Fatalf("rebuilt speech = %q, want the original line", rebuilt)
	}

	var report Report
	readTestJSON(t, filepath.Join(dir, DubbingDirName, DubbingReportName), &report)
	if report.SplitCues != 1 || report.SplitParts != 2 {
		t.Fatalf("split stats = %d/%d, want 1 cue into 2 parts", report.SplitCues, report.SplitParts)
	}
	if report.EchoSilencedCues != 0 {
		t.Fatalf("echo_silenced_cues = %d, want 0", report.EchoSilencedCues)
	}
}
