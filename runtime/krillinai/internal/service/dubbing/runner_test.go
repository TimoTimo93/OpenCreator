package dubbing

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

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
