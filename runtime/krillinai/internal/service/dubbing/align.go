package dubbing

import (
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// DubAlignedSuffix marks subtitle files whose timing was rewritten to follow
// the dubbed audio timeline.
const DubAlignedSuffix = "dub_aligned.srt"

// dubPlanTimingTolerance is the maximum original-timing mismatch (in seconds)
// accepted when aligning subtitle blocks to the dubbing plan by position.
const dubPlanTimingTolerance = 1.0

// dubPlanTileTolerance bounds how far a plan item window may sit from a
// subtitle block edge (in seconds) when a block is matched to a group of plan
// items tiling its window. Tight enough to never swallow a neighbouring cue,
// loose enough for exporters that round timestamps.
const dubPlanTileTolerance = 0.05

// cueTimingMatchEpsilon compares SRT-derived timestamps with plan timings.
const cueTimingMatchEpsilon = 0.001

// AlignSubtitleToDubPlan rewrites the timing of a subtitle file so every cue
// follows the dubbed audio timeline recorded in the dubbing plan (the same
// timeline as dub.srt before normalization). Text lines are preserved so
// bilingual layouts keep their ordering. When blocks cannot be matched to the
// plan the alignment fails and the caller should fall back to the original
// timing.
func AlignSubtitleToDubPlan(subtitlePath, workdir string) (string, error) {
	plan, err := LoadDubPlan(workdir)
	if err != nil {
		return "", err
	}
	blocks, err := readSubtitleBlocks(subtitlePath)
	if err != nil {
		return "", err
	}
	timings, err := matchDubTimings(plan, blocks)
	if err != nil {
		return "", err
	}

	var b strings.Builder
	for i, block := range blocks {
		b.WriteString(strconv.Itoa(i + 1))
		b.WriteString("\n")
		b.WriteString(FormatTimestamp(timings[i][0]))
		b.WriteString(" --> ")
		b.WriteString(FormatTimestamp(timings[i][1]))
		b.WriteString("\n")
		b.WriteString(strings.Join(block.Lines, "\n"))
		b.WriteString("\n\n")
	}

	base := strings.TrimSuffix(filepath.Base(subtitlePath), ".srt")
	if base == "" || base == "." {
		base = "subtitle"
	}
	output := filepath.Join(workdir, DubbingDirName, fmt.Sprintf("%s.%s", base, DubAlignedSuffix))
	if err := os.WriteFile(output, []byte(b.String()), 0644); err != nil {
		return "", err
	}
	return output, nil
}

// LoadDubPlan reads the fitted dubbing plan written by the dubbing runner.
func LoadDubPlan(workdir string) ([]PlanItem, error) {
	path := filepath.Join(workdir, DubbingDirName, DubbingPlanFileName)
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read dubbing plan: %w", err)
	}
	var plan []PlanItem
	if err := json.Unmarshal(data, &plan); err != nil {
		return nil, fmt.Errorf("parse dubbing plan %s: %w", path, err)
	}
	if len(plan) == 0 {
		return nil, fmt.Errorf("dubbing plan %s is empty", path)
	}
	return plan, nil
}

type subtitleBlock struct {
	Start float64
	End   float64
	Lines []string
}

func readSubtitleBlocks(path string) ([]subtitleBlock, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read subtitle %s: %w", path, err)
	}
	text := strings.ReplaceAll(string(data), "\r\n", "\n")
	text = strings.ReplaceAll(text, "\r", "\n")
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.TrimSpace(text)
	if text == "" {
		return nil, fmt.Errorf("subtitle %s is empty", path)
	}

	var blocks []subtitleBlock
	for _, block := range strings.Split(text, "\n\n") {
		lines := nonEmptyLines(block)
		if len(lines) < 2 {
			continue
		}
		parts := strings.Split(lines[1], "-->")
		if len(parts) != 2 {
			continue
		}
		start, err := ParseTimestamp(strings.TrimSpace(parts[0]))
		if err != nil {
			continue
		}
		end, err := ParseTimestamp(strings.TrimSpace(parts[1]))
		if err != nil {
			continue
		}
		blocks = append(blocks, subtitleBlock{
			Start: start,
			End:   end,
			Lines: append([]string(nil), lines[2:]...),
		})
	}
	if len(blocks) == 0 {
		return nil, fmt.Errorf("subtitle %s has no readable cues", path)
	}
	return blocks, nil
}

// matchDubTimings maps every subtitle block to a plan item window. Exact
// original-timing matches win; otherwise blocks map positionally when the
// counts agree and the timings are close enough to prove the plan belongs to
// the same subtitle.
func matchDubTimings(plan []PlanItem, blocks []subtitleBlock) ([][2]float64, error) {
	timings := make([][2]float64, len(blocks))

	byTiming := make(map[[2]float64]int, len(plan))
	for i, item := range plan {
		byTiming[[2]float64{item.OriginalStart, item.OriginalEnd}] = i
	}
	allMatched := true
	for i, block := range blocks {
		idx, ok := byTiming[[2]float64{block.Start, block.End}]
		if !ok {
			timing, tiled := matchTiledDubItems(plan, block)
			if !tiled {
				allMatched = false
				break
			}
			timings[i] = timing
			continue
		}
		timings[i] = dubTimingForItem(plan[idx], block)
	}
	if allMatched {
		return timings, nil
	}

	if len(blocks) != len(plan) {
		return nil, fmt.Errorf("subtitle has %d cues but the dubbing plan has %d items", len(blocks), len(plan))
	}
	for i, block := range blocks {
		if math.Abs(block.Start-plan[i].OriginalStart) > dubPlanTimingTolerance ||
			math.Abs(block.End-plan[i].OriginalEnd) > dubPlanTimingTolerance {
			return nil, fmt.Errorf("subtitle cue %d timing does not match the dubbing plan", i+1)
		}
		timings[i] = dubTimingForItem(plan[i], block)
	}
	return timings, nil
}

// dubTimingForItem returns the dub timeline for one matched plan item.
// Items that had content but produce no speech (silenced echoes, noise-only
// cues) keep the source timing: their subtitle must not collapse onto the
// tiny silence window. Minimal plans without text fields stay re-timed.
func dubTimingForItem(item PlanItem, block subtitleBlock) [2]float64 {
	if item.Silence || (item.OriginalText != "" && strings.TrimSpace(item.SpokenText) == "") {
		return [2]float64{block.Start, block.End}
	}
	return [2]float64{item.NewStart, item.NewEnd}
}

// matchTiledDubItems matches a subtitle block to consecutive plan items whose
// original windows tile the block window — the shape produced when a long cue
// is split into parts. The block is then timed to the union of the fitted
// part windows. Requires at least two items so loose single-item windows can
// never fake a match.
func matchTiledDubItems(plan []PlanItem, block subtitleBlock) ([2]float64, bool) {
	first := -1
	last := -1
	for i, item := range plan {
		if item.OriginalStart < block.Start-dubPlanTileTolerance || item.OriginalEnd > block.End+dubPlanTileTolerance {
			continue
		}
		if first < 0 || item.OriginalStart < plan[first].OriginalStart {
			first = i
		}
		if last < 0 || item.OriginalEnd > plan[last].OriginalEnd {
			last = i
		}
	}
	if first < 0 || first == last {
		return [2]float64{}, false
	}

	if math.Abs(plan[first].OriginalStart-block.Start) > dubPlanTileTolerance ||
		math.Abs(plan[last].OriginalEnd-block.End) > dubPlanTileTolerance {
		return [2]float64{}, false
	}
	for i := first; i < last; i++ {
		if plan[i].OriginalStart < block.Start-dubPlanTileTolerance || plan[i].OriginalEnd > block.End+dubPlanTileTolerance {
			return [2]float64{}, false
		}
		if math.Abs(plan[i+1].OriginalStart-plan[i].OriginalEnd) > dubPlanTileTolerance {
			return [2]float64{}, false
		}
	}
	return [2]float64{plan[first].NewStart, plan[last].NewEnd}, true
}
