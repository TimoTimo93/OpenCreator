package dubbing

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeDubPlanForTest(t *testing.T, workdir string) {
	t.Helper()
	path := filepath.Join(workdir, DubbingDirName)
	if err := os.MkdirAll(path, 0755); err != nil {
		t.Fatal(err)
	}
	data := []byte(`[
  {"index": 1, "original_start": 0, "original_end": 2, "new_start": 0, "new_end": 1.5},
  {"index": 2, "original_start": 2.5, "original_end": 4, "new_start": 3.5, "new_end": 4.75}
]`)
	if err := os.WriteFile(filepath.Join(path, DubbingPlanFileName), data, 0644); err != nil {
		t.Fatal(err)
	}
}

func TestAlignSubtitleToDubPlanRewritesTimingAndKeepsLines(t *testing.T) {
	workdir := t.TempDir()
	writeDubPlanForTest(t, workdir)

	subtitle := filepath.Join(workdir, "bilingual_srt.srt")
	content := "1\n00:00:00,000 --> 00:00:02,000\nXin chào\nHello\n\n2\n00:00:02,500 --> 00:00:04,000\nThế giới\nWorld\n\n"
	if err := os.WriteFile(subtitle, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	aligned, err := AlignSubtitleToDubPlan(subtitle, workdir)
	if err != nil {
		t.Fatalf("AlignSubtitleToDubPlan() error = %v", err)
	}
	data, err := os.ReadFile(aligned)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "00:00:00,000 --> 00:00:01,500") {
		t.Fatalf("aligned srt = %q, want dub timing for the first cue", got)
	}
	if !strings.Contains(got, "00:00:03,500 --> 00:00:04,750") {
		t.Fatalf("aligned srt = %q, want dub timing for the second cue", got)
	}
	if !strings.Contains(got, "Xin chào\nHello") || !strings.Contains(got, "Thế giới\nWorld") {
		t.Fatalf("aligned srt = %q, want bilingual text lines preserved", got)
	}
	if strings.Contains(got, "00:00:02,000") || strings.Contains(got, "00:00:04,000\n") {
		t.Fatalf("aligned srt = %q, want original timing replaced", got)
	}
}

func TestAlignSubtitleToDubPlanFallsBackToPositionalMatch(t *testing.T) {
	workdir := t.TempDir()
	writeDubPlanForTest(t, workdir)

	subtitle := filepath.Join(workdir, "target_language_srt.srt")
	// Same cue count; timings rounded slightly differently by an exporter.
	content := "1\n00:00:00,000 --> 00:00:02,001\nXin chào\n\n2\n00:00:02,501 --> 00:00:04,000\nThế giới\n\n"
	if err := os.WriteFile(subtitle, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	aligned, err := AlignSubtitleToDubPlan(subtitle, workdir)
	if err != nil {
		t.Fatalf("AlignSubtitleToDubPlan() error = %v", err)
	}
	data, err := os.ReadFile(aligned)
	if err != nil {
		t.Fatal(err)
	}
	got := string(data)
	if !strings.Contains(got, "00:00:00,000 --> 00:00:01,500") || !strings.Contains(got, "00:00:03,500 --> 00:00:04,750") {
		t.Fatalf("aligned srt = %q, want positional dub timing", got)
	}
}

func TestAlignSubtitleToDubPlanRejectsUnrelatedSubtitle(t *testing.T) {
	workdir := t.TempDir()
	writeDubPlanForTest(t, workdir)

	subtitle := filepath.Join(workdir, "other.srt")
	content := "1\n00:00:00,000 --> 00:00:01,000\nA\n\n2\n00:00:01,000 --> 00:00:02,000\nB\n\n3\n00:00:03,000 --> 00:00:04,000\nC\n\n"
	if err := os.WriteFile(subtitle, []byte(content), 0644); err != nil {
		t.Fatal(err)
	}

	if _, err := AlignSubtitleToDubPlan(subtitle, workdir); err == nil {
		t.Fatal("AlignSubtitleToDubPlan() error = nil, want cue count mismatch error")
	}
}

func TestAlignSubtitleToDubPlanFailsWithoutPlan(t *testing.T) {
	workdir := t.TempDir()
	subtitle := filepath.Join(workdir, "target.srt")
	if err := os.WriteFile(subtitle, []byte("1\n00:00:00,000 --> 00:00:01,000\nA\n\n"), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := AlignSubtitleToDubPlan(subtitle, workdir); err == nil {
		t.Fatal("AlignSubtitleToDubPlan() error = nil, want missing plan error")
	}
}
