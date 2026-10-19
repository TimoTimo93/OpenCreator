package dubbing

import (
	"strings"
	"testing"
)

func TestFitTimelineProducesMonotonicTimesAndChunkSpeed(t *testing.T) {
	cfg := DefaultConfig()
	plan := []PlanItem{
		{Index: 1, OriginalStart: 0, OriginalEnd: 1, SpokenText: "一", ActualDuration: 0.8, ChunkID: 1},
		{Index: 2, OriginalStart: 1.1, OriginalEnd: 2, SpokenText: "二", ActualDuration: 0.8, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0, 1}, Start: 0, End: 2.5}}
	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	if got[0].NewStart != 0 || got[1].NewStart < got[0].NewEnd {
		t.Fatalf("timeline overlaps: %+v", got)
	}
	if report.MaxSpeedFactor <= 0 {
		t.Fatalf("MaxSpeedFactor not set: %+v", report)
	}
}

func TestFitTimelineUsesChunkAudioAndEstimatedWeights(t *testing.T) {
	cfg := DefaultConfig()
	plan := []PlanItem{
		{Index: 1, EstimatedDuration: 1, ChunkID: 1},
		{Index: 2, EstimatedDuration: 3, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0, 1}, Start: 10, End: 15, ActualDuration: 4}}

	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	if got[0].NewStart != 10 || got[0].NewEnd != 11 {
		t.Fatalf("first cue window = %.3f --> %.3f, want 10 --> 11", got[0].NewStart, got[0].NewEnd)
	}
	if got[1].NewStart != 11 || got[1].NewEnd != 14 {
		t.Fatalf("second cue window = %.3f --> %.3f, want 11 --> 14", got[1].NewStart, got[1].NewEnd)
	}
	if got[0].SpeedFactor != 1 || got[1].SpeedFactor != 1 {
		t.Fatalf("SpeedFactor = %.3f %.3f, want chunk speed 1", got[0].SpeedFactor, got[1].SpeedFactor)
	}
	if report.MaxSpeedFactor != 1 {
		t.Fatalf("MaxSpeedFactor = %v, want 1", report.MaxSpeedFactor)
	}
}

func TestFitTimelineClampsSpeedBeyondMaxAndDrifts(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMax = 1.25
	cfg.SpeedAccept = 1.1
	plan := []PlanItem{
		{Index: 1, ActualDuration: 4, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0}, Start: 0, End: 2}}
	got, gotChunks, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	if report.MaxSpeedFactor != 2 {
		t.Fatalf("MaxSpeedFactor = %v, want raw required speed 2", report.MaxSpeedFactor)
	}
	if got[0].SpeedFactor != 1.25 {
		t.Fatalf("SpeedFactor = %v, want clamped max 1.25", got[0].SpeedFactor)
	}
	if gotChunks[0].SpeedFactor != 1.25 {
		t.Fatalf("chunk speed = %v, want clamped max 1.25", gotChunks[0].SpeedFactor)
	}
	if got[0].NewEnd != 3.2 {
		t.Fatalf("NewEnd = %v, want slot 2 plus drift 1.2 = 3.2", got[0].NewEnd)
	}
	if !warningsContain(report.Warnings, "clamped to max") || !warningsContain(report.Warnings, "drifts") {
		t.Fatalf("warnings = %+v, want clamp and drift warnings", report.Warnings)
	}
}

func TestFitTimelineDriftsFollowingChunksAfterClampedOverflow(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMax = 1.3
	plan := []PlanItem{
		{Index: 1, ActualDuration: 3.9, ChunkID: 1},
		{Index: 2, ActualDuration: 1, ChunkID: 2},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0}, Start: 0, End: 2},
		{ID: 2, Items: []int{1}, Start: 5, End: 6},
	}
	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	// Chunk 1 ends at 3.9/1.3 = 3.0, overflowing its slot by 1.0s.
	if got[0].NewEnd != 3 {
		t.Fatalf("first NewEnd = %v, want 3", got[0].NewEnd)
	}
	if got[1].NewStart != 6 {
		t.Fatalf("second NewStart = %v, want scheduled 5 + drift 1 = 6", got[1].NewStart)
	}
	if got[1].NewStart < got[0].NewEnd {
		t.Fatalf("drifted chunk overlaps previous: %+v", got)
	}
	if !warningsContain(report.Warnings, "drifts") {
		t.Fatalf("warnings = %+v, want drift warning", report.Warnings)
	}
}

func TestFitTimelineRecoversDriftWhenChunkFinishesEarly(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMax = 1.3
	plan := []PlanItem{
		{Index: 1, ActualDuration: 3.9, ChunkID: 1},
		{Index: 2, ActualDuration: 0.5, ChunkID: 2},
		{Index: 3, ActualDuration: 1, ChunkID: 3},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0}, Start: 0, End: 2},
		{ID: 2, Items: []int{1}, Start: 6, End: 8},
		{ID: 3, Items: []int{2}, Start: 8, End: 9},
	}
	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	// Chunk 1 ends at 3.9/1.3 = 3.0 (drift +1.0); chunk 2 uses only 0.5s of its
	// 2s slot, so the drift is recovered and chunk 3 starts on schedule.
	if got[1].NewStart != 7 {
		t.Fatalf("second NewStart = %v, want scheduled 6 + drift 1 = 7", got[1].NewStart)
	}
	if got[2].NewStart != 8 {
		t.Fatalf("third NewStart = %v, want recovered schedule 8", got[2].NewStart)
	}
	if warningsContain(report.Warnings, "drift capped") {
		t.Fatalf("warnings = %+v, want no drift cap warning", report.Warnings)
	}
}

func TestFitTimelineCapsDriftAndPacksFollowingChunks(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMax = 1.3
	cfg.MaxDriftSeconds = 0.5
	plan := []PlanItem{
		{Index: 1, ActualDuration: 3.9, ChunkID: 1},
		{Index: 2, ActualDuration: 3.9, ChunkID: 2},
		{Index: 3, ActualDuration: 1, ChunkID: 3},
	}
	chunks := []Chunk{
		{ID: 1, Items: []int{0}, Start: 0, End: 2},
		{ID: 2, Items: []int{1}, Start: 2, End: 4},
		{ID: 3, Items: []int{2}, Start: 4, End: 5},
	}
	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	if !warningsContain(report.Warnings, "drift capped") {
		t.Fatalf("warnings = %+v, want drift cap warning", report.Warnings)
	}
	// Chunk 1 ends at 3.0 (+1.0 overflow) but drift is capped at 0.5s, so
	// chunk 2 packs at the previous end instead of drifting further.
	if got[1].NewStart != 3 {
		t.Fatalf("chunk 2 start = %v, want packed at previous end 3", got[1].NewStart)
	}
	if got[2].NewStart != 6 {
		t.Fatalf("chunk 3 start = %v, want packed at previous end 6", got[2].NewStart)
	}
	for i := 1; i < len(got); i++ {
		if got[i].NewStart+1e-9 < got[i-1].NewEnd {
			t.Fatalf("packed chunk %d overlaps previous: %+v", i+1, got)
		}
	}
}

func TestFitTimelinePreservesIntraChunkPauses(t *testing.T) {
	cfg := DefaultConfig()
	plan := []PlanItem{
		{Index: 1, OriginalStart: 0, OriginalEnd: 1, ActualDuration: 1, ChunkID: 1},
		{Index: 2, OriginalStart: 1.5, OriginalEnd: 2.5, ActualDuration: 1, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0, 1}, Start: 0, End: 2.5}}
	got, gotChunks, _, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	// The 0.5s pause is preserved; the speech (2.0s) fits the remaining 2.0s at speed 1.
	if got[0].NewStart != 0 || got[0].NewEnd != 1 {
		t.Fatalf("first cue window = %.3f --> %.3f, want 0 --> 1", got[0].NewStart, got[0].NewEnd)
	}
	if got[1].NewStart != 1.5 {
		t.Fatalf("second cue must start after the original 0.5s pause, got %v", got[1].NewStart)
	}
	if got[1].NewEnd != 2.5 {
		t.Fatalf("second cue end = %v, want 2.5", got[1].NewEnd)
	}
	if gotChunks[0].SpeedFactor != 1 {
		t.Fatalf("chunk speed = %v, want 1", gotChunks[0].SpeedFactor)
	}
}

func TestFitTimelineKeepsOverlongChunkBeforeNextChunkBoundary(t *testing.T) {
	cfg := DefaultConfig()
	plan := []PlanItem{
		{Index: 33, EstimatedDuration: 4.8, ChunkID: 13},
		{Index: 34, EstimatedDuration: 3.6, ChunkID: 13},
		{Index: 35, EstimatedDuration: 4.9, ChunkID: 13},
		{Index: 36, EstimatedDuration: 5.1, ChunkID: 14},
	}
	chunks := []Chunk{
		{ID: 13, Items: []int{0, 1, 2}, Start: 82.8, End: 90, ActualDuration: 11.04},
		{ID: 14, Items: []int{3}, Start: 90, End: 93.28, ActualDuration: 3.28},
	}

	got, gotChunks, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	if got[2].NewEnd > got[3].NewStart+1e-9 {
		t.Fatalf("chunk boundary overlaps: previous end %.3f next start %.3f", got[2].NewEnd, got[3].NewStart)
	}
	if gotChunks[0].SpeedFactor != cfg.SpeedMax {
		t.Fatalf("chunk 13 speed = %.3f, want clamped at max %.3f", gotChunks[0].SpeedFactor, cfg.SpeedMax)
	}
	if !warningsContain(report.Warnings, "drifts") {
		t.Fatalf("warnings = %+v, want drift warning for the clamped overflow", report.Warnings)
	}
	if gotChunks[1].Start < gotChunks[0].Start {
		t.Fatalf("chunk starts must stay monotonic: %+v", gotChunks)
	}
}

func TestFitTimelineRejectsNonPositiveActualDuration(t *testing.T) {
	cfg := DefaultConfig()
	plan := []PlanItem{
		{Index: 7, ActualDuration: 1, ChunkID: 3},
		{Index: 8, ActualDuration: 0, ChunkID: 3},
	}
	chunks := []Chunk{{ID: 3, Items: []int{0, 1}, Start: 0, End: 1}}
	_, _, _, err := FitTimeline(plan, chunks, cfg)
	if err == nil {
		t.Fatal("FitTimeline() error = nil, want non-positive actual duration error")
	}
	msg := err.Error()
	if !strings.Contains(msg, "chunk 3") || !strings.Contains(msg, "item 1") || !strings.Contains(msg, "plan index 1") {
		t.Fatalf("error = %q, want chunk id and item/plan index", msg)
	}
}

func TestFitTimelineNormalizesZeroSpeedConfig(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMin = 0
	cfg.SpeedAccept = 0
	cfg.SpeedMax = 0
	plan := []PlanItem{
		{Index: 1, ActualDuration: 1.2, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0}, Start: 0, End: 1}}
	got, _, report, err := FitTimeline(plan, chunks, cfg)
	if err != nil {
		t.Fatalf("FitTimeline() error = %v", err)
	}
	defaults := DefaultConfig()
	if got[0].SpeedFactor != 1.2 {
		t.Fatalf("SpeedFactor = %v, want required speed 1.2", got[0].SpeedFactor)
	}
	if warningsContain(report.Warnings, "acceptable 0") || warningsContain(report.Warnings, "max 0") {
		t.Fatalf("warnings = %+v, want normalized default speed limits %+v", report.Warnings, defaults)
	}
}

func TestFitTimelineRejectsInvalidSpeedOrder(t *testing.T) {
	cfg := DefaultConfig()
	cfg.SpeedMin = 1.4
	cfg.SpeedMax = 1.3
	plan := []PlanItem{
		{Index: 1, ActualDuration: 1, ChunkID: 1},
	}
	chunks := []Chunk{{ID: 1, Items: []int{0}, Start: 0, End: 1}}
	_, _, _, err := FitTimeline(plan, chunks, cfg)
	if err == nil {
		t.Fatal("FitTimeline() error = nil, want invalid speed config error")
	}
	if !strings.Contains(err.Error(), "speed config") {
		t.Fatalf("error = %q, want speed config error", err.Error())
	}
}

func warningsContain(warnings []string, substr string) bool {
	for _, warning := range warnings {
		if strings.Contains(warning, substr) {
			return true
		}
	}
	return false
}
