package dubbing

import (
	"context"
	"errors"
	"fmt"
	"krillin-ai/internal/types"
	"os"
	"path/filepath"
	"strings"
)

func GenerateRawSegments(ctx context.Context, tts types.Ttser, plan []PlanItem, voice, dir string, run CommandRunner, duration DurationProbe) ([]PlanItem, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if run == nil {
		run = defaultFFmpegRunner
	}
	if duration == nil {
		return nil, errors.New("duration probe is required")
	}

	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		return nil, err
	}

	for i := range plan {
		if err := ctx.Err(); err != nil {
			return nil, err
		}

		output := filepath.Join(rawDir, fmt.Sprintf("%d.wav", plan[i].Index))
		if IsSilenceOnlyText(plan[i].SpokenText) {
			if err := WriteTinySilence(output, run); err != nil {
				return nil, err
			}
		} else {
			if tts == nil {
				return nil, errors.New("tts is required for non-silence text")
			}
			if err := retryTTS(tts, plan[i].SpokenText, voice, output, 3); err != nil {
				return nil, fmt.Errorf("tts segment %d failed: %w", plan[i].Index, err)
			}
		}

		dur, err := duration(output)
		if err != nil {
			return nil, fmt.Errorf("measure segment %d duration failed for %s: %w", plan[i].Index, output, err)
		}
		plan[i].ActualDuration = dur
	}

	return plan, nil
}

func GenerateRawChunkSegments(
	ctx context.Context,
	tts types.Ttser,
	plan []PlanItem,
	chunks []Chunk,
	voice,
	dir string,
	run CommandRunner,
	duration DurationProbe,
	reportProgress func(completed, total int),
) ([]PlanItem, []Chunk, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if run == nil {
		run = defaultFFmpegRunner
	}
	if duration == nil {
		return nil, nil, errors.New("duration probe is required")
	}

	rawDir := filepath.Join(dir, "raw")
	if err := os.MkdirAll(rawDir, 0755); err != nil {
		return nil, nil, err
	}

	outPlan := append([]PlanItem(nil), plan...)
	outChunks := append([]Chunk(nil), chunks...)
	for i := range outChunks {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if len(outChunks[i].Items) > 1 {
			// Multi-cue chunks synthesize each cue separately so the natural
			// pause between cues survives as silence during assembly instead of
			// being read away as one run-on sentence.
			if err := generateChunkItemSegments(tts, outPlan, outChunks[i], voice, rawDir, run, duration); err != nil {
				return nil, nil, err
			}
			if reportProgress != nil {
				reportProgress(i+1, len(outChunks))
			}
			continue
		}
		text, err := chunkSpeechText(outPlan, outChunks[i])
		if err != nil {
			return nil, nil, err
		}

		output := filepath.Join(rawDir, fmt.Sprintf("chunk_%d.wav", outChunks[i].ID))
		if IsSilenceOnlyText(text) {
			if err := WriteTinySilence(output, run); err != nil {
				return nil, nil, err
			}
		} else {
			if tts == nil {
				return nil, nil, errors.New("tts is required for non-silence text")
			}
			if err := retryTTS(tts, text, voice, output, 3); err != nil {
				return nil, nil, fmt.Errorf("tts chunk %d failed: %w", outChunks[i].ID, err)
			}
		}

		dur, err := duration(output)
		if err != nil {
			return nil, nil, fmt.Errorf("measure chunk %d duration failed for %s: %w", outChunks[i].ID, output, err)
		}
		outChunks[i].ActualDuration = dur
		if reportProgress != nil {
			reportProgress(i+1, len(outChunks))
		}
	}

	return outPlan, outChunks, nil
}

// generateChunkItemSegments synthesizes every cue of a multi-cue chunk on its
// own and records the measured duration on the plan item, so assembly can
// rebuild the original inter-cue gaps.
func generateChunkItemSegments(
	tts types.Ttser,
	plan []PlanItem,
	chunk Chunk,
	voice,
	rawDir string,
	run CommandRunner,
	duration DurationProbe,
) error {
	for _, idx := range chunk.Items {
		if idx < 0 || idx >= len(plan) {
			return fmt.Errorf("chunk %d references plan item %d out of range", chunk.ID, idx)
		}
		item := plan[idx]
		output := filepath.Join(rawDir, fmt.Sprintf("%d.wav", item.Index))
		text := strings.Join(strings.Fields(item.SpokenText), " ")
		if IsSilenceOnlyText(text) {
			if err := WriteTinySilence(output, run); err != nil {
				return fmt.Errorf("write silence for chunk %d segment %d: %w", chunk.ID, item.Index, err)
			}
		} else {
			if tts == nil {
				return errors.New("tts is required for non-silence text")
			}
			if err := retryTTS(tts, text, voice, output, 3); err != nil {
				return fmt.Errorf("tts chunk %d segment %d failed: %w", chunk.ID, item.Index, err)
			}
		}

		dur, err := duration(output)
		if err != nil {
			return fmt.Errorf("measure chunk %d segment %d duration failed for %s: %w", chunk.ID, item.Index, output, err)
		}
		plan[idx].ActualDuration = dur
	}
	return nil
}

func chunkSpeechText(plan []PlanItem, chunk Chunk) (string, error) {
	parts := make([]string, 0, len(chunk.Items))
	for itemIndex, idx := range chunk.Items {
		if idx < 0 || idx >= len(plan) {
			return "", fmt.Errorf("chunk %d references plan item %d out of range", chunk.ID, itemIndex)
		}
		text := strings.Join(strings.Fields(plan[idx].SpokenText), " ")
		if text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " "), nil
}

func retryTTS(tts types.Ttser, text, voice, output string, attempts int) error {
	if attempts <= 0 {
		return fmt.Errorf("attempts must be > 0: %d", attempts)
	}

	var last error
	for i := 0; i < attempts; i++ {
		if err := os.Remove(output); err != nil && !errors.Is(err, os.ErrNotExist) {
			return fmt.Errorf("remove stale output %s: %w", output, err)
		}
		last = tts.Text2Speech(text, voice, output)
		if last == nil {
			if _, err := os.Stat(output); err == nil {
				return nil
			}
			last = fmt.Errorf("output file missing: %s", output)
		}
	}
	return last
}
