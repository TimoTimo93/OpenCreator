package pipeline

import (
	"context"
	"encoding/json"
	"krillin-ai/internal/service"
	"krillin-ai/internal/service/dubbing"
	subtitlestyle "krillin-ai/internal/subtitle_style"
	"krillin-ai/internal/types"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type renderFakeService struct {
	fakeStageService
	lastRender service.RenderVideoRequest
}

func (f *renderFakeService) RenderVideo(_ context.Context, req service.RenderVideoRequest) (string, error) {
	f.lastRender = req
	return req.OutputFile, nil
}

func TestRenderDubbedAlignsSubtitleToDubPlan(t *testing.T) {
	dir := t.TempDir()
	dubbingDir := filepath.Join(dir, "dubbing")
	if err := os.MkdirAll(dubbingDir, 0755); err != nil {
		t.Fatal(err)
	}
	plan := `[
  {"index": 1, "original_start": 0, "original_end": 2, "new_start": 0, "new_end": 1.5},
  {"index": 2, "original_start": 2.5, "original_end": 4, "new_start": 3.5, "new_end": 4.75}
]`
	if err := os.WriteFile(filepath.Join(dubbingDir, "dubbing_plan.json"), []byte(plan), 0644); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(dir, "target_language_srt.srt")
	content := "1\n00:00:00,000 --> 00:00:02,000\nXin chào\n\n2\n00:00:02,500 --> 00:00:04,000\nThế giới\n\n"
	if err := os.WriteFile(target, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	fake := &renderFakeService{}
	req := RenderRequest{
		Workdir:    dir,
		TaskID:     "demo",
		Video:      "origin_video.mp4",
		Subtitle:   target,
		Horizontal: true,
		Dubbed:     true,
	}
	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	aligned, err := dubbing.AlignSubtitleToDubPlan(target, dir)
	if err != nil {
		t.Fatalf("AlignSubtitleToDubPlan() error = %v", err)
	}
	if fake.lastRender.SubtitleFile != aligned {
		t.Fatalf("SubtitleFile = %q, want dub-aligned subtitle %q", fake.lastRender.SubtitleFile, aligned)
	}
	data, err := os.ReadFile(fake.lastRender.SubtitleFile)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "00:00:00,000 --> 00:00:01,500") {
		t.Fatalf("burned subtitle = %q, want dub timing", string(data))
	}
}

func TestRenderDubbedKeepsOriginalSubtitleWhenPlanMissing(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target_language_srt.srt")
	if err := os.WriteFile(target, []byte("1\n00:00:00,000 --> 00:00:02,000\nXin chào\n\n"), 0644); err != nil {
		t.Fatal(err)
	}

	fake := &renderFakeService{}
	req := RenderRequest{
		Workdir:    dir,
		TaskID:     "demo",
		Video:      "origin_video.mp4",
		Subtitle:   target,
		Horizontal: true,
		Dubbed:     true,
	}
	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	if fake.lastRender.SubtitleFile != target {
		t.Fatalf("SubtitleFile = %q, want original subtitle fallback", fake.lastRender.SubtitleFile)
	}
	if len(resp.Warnings) == 0 {
		t.Fatalf("warnings = %+v, want an alignment-skipped warning", resp.Warnings)
	}
}

func TestRenderHorizontalDubbedOutputName(t *testing.T) {
	dir := t.TempDir()
	fake := &renderFakeService{}
	req := RenderRequest{
		Workdir:    dir,
		TaskID:     "demo",
		Video:      "origin_video.mp4",
		Audio:      "tts_final_audio.wav",
		Subtitle:   "target_language_srt.srt",
		Horizontal: true,
		Dubbed:     true,
	}
	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	if !strings.HasSuffix(fake.lastRender.OutputFile, "horizontal_dubbed.mp4") {
		t.Fatalf("OutputFile = %q, want horizontal_dubbed.mp4 suffix", fake.lastRender.OutputFile)
	}
}

func TestRenderPassesSubtitleStyleToService(t *testing.T) {
	dir := t.TempDir()
	fake := &renderFakeService{}
	style := subtitlestyle.DefaultStyleSet()
	req := RenderRequest{
		Workdir:       dir,
		TaskID:        "demo",
		Video:         "origin_video.mp4",
		Subtitle:      "bilingual_srt.srt",
		Horizontal:    true,
		SubtitleStyle: style,
		LineMode:      LineModeBilingualTargetBottom,
	}

	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	if fake.lastRender.StepParam == nil || fake.lastRender.StepParam.SubtitleStyle != style {
		t.Fatalf("SubtitleStyle was not passed to service")
	}
	if fake.lastRender.StepParam.SubtitleResultType != types.SubtitleResultTypeBilingualTranslationOnBottom {
		t.Fatal("subtitle line ordering was not passed to service")
	}
}

func TestRenderVerticalBilingualOutputName(t *testing.T) {
	dir := t.TempDir()
	fake := &renderFakeService{}
	req := RenderRequest{
		Workdir:    dir,
		TaskID:     "demo",
		Video:      "origin_video.mp4",
		Subtitle:   "short_origin_mixed_srt.srt",
		Horizontal: false,
		Dubbed:     false,
	}
	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	if !strings.HasSuffix(fake.lastRender.OutputFile, "vertical_bilingual.mp4") {
		t.Fatalf("OutputFile = %q, want vertical_bilingual.mp4 suffix", fake.lastRender.OutputFile)
	}
}

func TestRenderDubbedDefaultsToVideoWithTTSAndTargetSubtitle(t *testing.T) {
	dir := t.TempDir()
	manifest := NewManifest("demo", dir)
	manifest.Outputs.OriginVideo = filepath.Join(dir, "custom_origin.mp4")
	manifest.Outputs.VideoWithTTS = filepath.Join(dir, "custom_tts_video.mp4")
	manifest.Outputs.TargetSRT = filepath.Join(dir, "custom_target.srt")
	data, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(ManifestPath(dir), data, 0644); err != nil {
		t.Fatal(err)
	}

	fake := &renderFakeService{}
	req := RenderRequest{
		Workdir:    dir,
		TaskID:     "demo",
		Horizontal: true,
		Dubbed:     true,
	}
	resp, err := Render(context.Background(), fake, req)
	if err != nil {
		t.Fatalf("Render() error = %v", err)
	}
	if !resp.OK {
		t.Fatalf("OK = false, want true")
	}
	if fake.lastRender.InputVideo != manifest.Outputs.VideoWithTTS {
		t.Fatalf("InputVideo = %q, want %q", fake.lastRender.InputVideo, manifest.Outputs.VideoWithTTS)
	}
	if fake.lastRender.SubtitleFile != manifest.Outputs.TargetSRT {
		t.Fatalf("SubtitleFile = %q, want %q", fake.lastRender.SubtitleFile, manifest.Outputs.TargetSRT)
	}
	if !strings.HasSuffix(resp.Outputs.HorizontalVideo, "horizontal_dubbed.mp4") {
		t.Fatalf("HorizontalVideo = %q, want horizontal_dubbed.mp4 suffix", resp.Outputs.HorizontalVideo)
	}
}
