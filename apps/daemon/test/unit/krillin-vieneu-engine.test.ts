import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discoverVieNeuRuntime,
  isVieNeuPresetVoice,
  resolveVieNeuVoice,
  VIENEU_PRESET_VOICES
} from '../../src/creator/krillin/vieneu-engine.js';

const ENV_KEYS = [
  'OPENCREATOR_VIENEU_PYTHON',
  'OPENCREATOR_VIENEU_MODEL_DIR',
  'OPENCREATOR_VIENEU_HF_HOME',
  'HF_HOME'
] as const;

const saved = new Map<string, string | undefined>();
for (const key of ENV_KEYS) saved.set(key, process.env[key]);

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function makeManagedRuntime(): string {
  const runtimeDir = mkdtempSync(join(tmpdir(), 'vieneu-rt-'));
  const python = join(runtimeDir, 'vieneu', '.venv', 'Scripts', 'python.exe');
  const modelDir = join(runtimeDir, 'vieneu', 'models', 'vieneu_v3_turbo');
  mkdirSync(join(runtimeDir, 'vieneu', '.venv', 'Scripts'), { recursive: true });
  mkdirSync(modelDir, { recursive: true });
  writeFileSync(python, '');
  writeFileSync(join(modelDir, 'vieneu_prefill.onnx'), '');
  writeFileSync(join(modelDir, 'vieneu_decode_step.onnx'), '');
  return runtimeDir;
}

describe('discoverVieNeuRuntime', () => {
  it('prefers the OpenCreator-managed runtime under runtimeDir', () => {
    const runtimeDir = makeManagedRuntime();
    const runtime = discoverVieNeuRuntime({ runtimeDir });
    expect(runtime?.python).toContain(join('vieneu', '.venv', 'Scripts', 'python.exe'));
    expect(runtime?.modelDir).toContain('vieneu_v3_turbo');
  });

  it('honours explicit python and model paths over discovery', () => {
    const runtimeDir = makeManagedRuntime();
    const python = join(runtimeDir, 'custom-python.exe');
    const modelDir = join(runtimeDir, 'custom-model');
    mkdirSync(modelDir, { recursive: true });
    writeFileSync(python, '');
    writeFileSync(join(modelDir, 'vieneu_prefill.onnx'), '');
    writeFileSync(join(modelDir, 'vieneu_decode_step.onnx'), '');

    const runtime = discoverVieNeuRuntime({ runtimeDir, python, modelDir });
    expect(runtime).toMatchObject({ python, modelDir });
  });
});

describe('isVieNeuPresetVoice', () => {
  it('recognizes the built-in VieNeu presets', () => {
    expect(VIENEU_PRESET_VOICES).toHaveLength(25);
    expect(VIENEU_PRESET_VOICES).toContain('Hải Đăng');
    expect(isVieNeuPresetVoice('Hải Đăng')).toBe(true);
    expect(isVieNeuPresetVoice('  trúc ly  ')).toBe(true);
  });

  it('rejects Edge TTS voices and provider voice ids', () => {
    expect(isVieNeuPresetVoice('vi-VN-HoaiMyNeural')).toBe(false);
    expect(isVieNeuPresetVoice('marin')).toBe(false);
    expect(isVieNeuPresetVoice('')).toBe(false);
  });
});

describe('resolveVieNeuVoice', () => {
  it('keeps a requested VieNeu preset', () => {
    expect(resolveVieNeuVoice('Trúc Ly', 'Hải Đăng')).toBe('Trúc Ly');
    expect(resolveVieNeuVoice('  hải đăng ', undefined)).toBe('hải đăng');
  });

  it('falls back to a valid configured default when the request is not a VieNeu voice', () => {
    expect(resolveVieNeuVoice('marin', 'Mai Anh')).toBe('Mai Anh');
    expect(resolveVieNeuVoice('vi-VN-HoaiMyNeural', 'Ngọc Linh')).toBe('Ngọc Linh');
  });

  it('falls back to the built-in default when neither voice is a VieNeu preset', () => {
    // Giọng mặc định chung có thể là giọng OpenAI/Edge: VieNeu không đọc được.
    expect(resolveVieNeuVoice('marin', 'marin')).toBe('Hải Đăng');
    expect(resolveVieNeuVoice('', undefined)).toBe('Hải Đăng');
    expect(resolveVieNeuVoice('vi-VN-HoaiMyNeural', '')).toBe('Hải Đăng');
  });
});
