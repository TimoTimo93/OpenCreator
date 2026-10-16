import type { CreatorJson } from '@opencreator/protocol';
import { open } from 'node:fs/promises';
import { validateSrtFile } from './validators/srt.js';
import type {
  CreatorOutputValidationFinding,
  CreatorStageOutputValidator
} from './templates/types.js';

const MIN_MEANINGFUL_CHARACTERS = 8;
const MIN_CHINESE_RATIO = 0.2;
const MIN_LATIN_RATIO = 0.25;
// Ngưỡng tỉ lệ dấu tiếng Việt. Thực tế một câu tiếng Việt dài thường có khoảng
// 15-25% ký tự mang dấu thanh nên ngưỡng 5% là rất dễ đạt; chỉ chặn khi bản
// dịch gần như hoàn toàn không dấu (dấu hiệu bản dịch sai ngôn ngữ).
const MIN_VIETNAMESE_DIACRITIC_RATIO = 0.05;
// Các dấu tiếng Việt có dấu. Khi bản dịch có tỉ lệ dấu cao, ta coi là đã dịch
// sang tiếng Việt (tránh phải phân biệt với các ngôn ngữ La-tinh khác vốn không
// dùng biến âm trên quy mô này).
const VIETNAMESE_DIACRITIC = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđĐ]/g;

export class CreatorOutputValidationError extends Error {
  constructor(
    readonly finding: CreatorOutputValidationFinding
  ) {
    super(finding.message);
    this.name = 'CreatorOutputValidationError';
  }

  get code(): string {
    return this.finding.code;
  }
}

export async function validateCreatorStageOutputs(input: Parameters<CreatorStageOutputValidator>[0]) {
  const findings: CreatorOutputValidationFinding[] = await validateCompletedOutputFiles(input);
  for (const validator of input.stage.outputValidators ?? []) {
    findings.push(...await validator(input));
  }
  return findings;
}

async function validateCompletedOutputFiles(
  input: Parameters<CreatorStageOutputValidator>[0]
): Promise<CreatorOutputValidationFinding[]> {
  const findings: CreatorOutputValidationFinding[] = [];
  for (const output of input.candidateOutputs) {
    if (output.status !== 'completed' || output.path === null) continue;
    try {
      const handle = await open(output.path, 'r');
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size <= 0) {
          findings.push({
            code: 'creator_output_file_empty',
            severity: 'blocking',
            message: 'The output file is empty. Run this step again.',
            evidence: { artifactKind: output.kind }
          });
          continue;
        }
        await handle.read(Buffer.alloc(1), 0, 1, 0);
      } finally {
        await handle.close();
      }
    } catch {
      findings.push({
        code: 'creator_output_file_unreadable',
        severity: 'blocking',
        message: 'The output file is unreadable. Run this step again.',
        evidence: { artifactKind: output.kind }
      });
    }
  }
  return findings;
}

export const validateTranslationOutputLanguage: CreatorStageOutputValidator = async input => {
  const targetLanguage = readLanguage(input.job.state.targetLanguage);
  const sourceLanguage = readLanguage(input.job.state.sourceLanguage);
  // Kiểm tra mọi cặp ngôn ngữ nguồn→đích khác nhau, không chỉ khi đích là tiếng
  // Trung. Bản dịch vẫn có thể trả về sai ngôn ngữ (tiếng Anh hoặc tiếng Trung
  // nguyên bản) nên validator chặn để người dùng dịch lại thay vì nhận sub sai.
  if (!targetLanguage || targetLanguage === sourceLanguage) return [];
  const target = input.candidateOutputs.find(output => (
    output.kind === 'target_subtitle' && output.status === 'completed'
  ));
  if (target?.path === null || target?.path === undefined) return [];

  let targetText: string;
  try {
    const cues = await validateSrtFile(target.path, { allowOverlaps: true });
    targetText = cues.map(cue => cue.text).join('\n');
  } catch {
    return [{
      code: 'creator_translation_output_invalid',
      severity: 'blocking',
      message: 'Could not parse the translated subtitle file. Generate it again.',
      evidence: { artifactKind: 'target_subtitle' }
    }];
  }

  const metrics = languageMetrics(targetText);
  const mismatch = translationLanguageMismatch(targetLanguage, metrics);
  if (!mismatch) return [];

  const source = input.candidateOutputs.find(output => (
    output.kind === 'source_subtitle' && output.status === 'completed' && output.path !== null
  ));
  const similarity = source?.path === undefined || source.path === null
    ? null
    : await subtitleSimilarity(source.path, targetText);
  return [{
    code: 'creator_translation_output_language_mismatch',
    severity: 'blocking',
    message: mismatch.message,
    evidence: compactEvidence({
      targetLanguage,
      expectedLanguage: mismatch.expectedLanguage,
      sampleCharacters: metrics.meaningfulCharacters,
      chineseRatio: Number(metrics.chineseRatio.toFixed(3)),
      latinRatio: Number(metrics.latinRatio.toFixed(3)),
      vietnameseDiacriticRatio: Number(metrics.vietnameseDiacriticRatio.toFixed(3)),
      sourceSimilarity: similarity === null ? null : Number(similarity.toFixed(3)),
      threshold: mismatch.threshold
    })
  }];
};

type LanguageMetrics = ReturnType<typeof languageMetrics>;

/**
 * Trả về finding (kèm ngưỡng và thông báo) khi bản dịch không khớp ngôn ngữ đích.
 * - Ngôn ngữ đích là tiếng Trung: chỉ kiểm tra khi đủ dữ liệu chữ (đừng chặn sub
 *   quá ngắn vốn chỉ toàn ký hiệu).
 * - Ngôn ngữ đích khác (tiếng Việt, Anh, v.v.): kiểm tra mọi lúc, kể cả sub ngắn,
 *   vì lỗi thường gặp nhất là dịch ra sai ngôn ngữ (Anh/Trung nguyên bản).
 */
function translationLanguageMismatch(
  targetLanguage: string,
  metrics: LanguageMetrics
): { message: string; expectedLanguage: string; threshold: number } | null {
  const expectedLanguage = expectedLanguageLabel(targetLanguage);
  const threshold = isChinese(targetLanguage) ? MIN_CHINESE_RATIO
    : isVietnamese(targetLanguage) ? MIN_VIETNAMESE_DIACRITIC_RATIO
    : MIN_LATIN_RATIO;
  if (metrics.meaningfulCharacters === 0) {
    return {
      message: `The target language is ${expectedLanguage}, but the translation is empty. Generate it again.`,
      expectedLanguage,
      threshold
    };
  }
  if (isChinese(targetLanguage)) {
    // Giữ nguyên hành vi cũ cho tiếng Trung: chỉ chặn khi đủ chữ và tỉ lệ Hán tự
    // thấp (dấu hiệu bản dịch phần lớn là tiếng Anh).
    if (metrics.meaningfulCharacters < MIN_MEANINGFUL_CHARACTERS) return null;
    if (metrics.chineseRatio >= MIN_CHINESE_RATIO) return null;
  } else if (isVietnamese(targetLanguage)) {
    // Tiếng Việt: bản dịch hợp lệ hầu như luôn có dấu thanh và chữ "đ". Nếu sub
    // dài nhưng không có bất kỳ dấu nào thì phần lớn là bản dịch sai ngôn ngữ
    // (thường là tiếng Anh) nên chặn để người dùng dịch lại.
    if (metrics.meaningfulCharacters < MIN_MEANINGFUL_CHARACTERS) return null;
    if (metrics.vietnameseDiacriticRatio >= MIN_VIETNAMESE_DIACRITIC_RATIO) return null;
  } else {
    // Ngôn ngữ La-tinh khác (Anh, Tây Ban Nha, ...): chặn khi phần lớn là Hán tự.
    if (metrics.latinRatio >= MIN_LATIN_RATIO) return null;
  }
  return {
    message: `The target language is ${expectedLanguage}, but the translation is mostly not ${expectedLanguage}. Generate it again.`,
    expectedLanguage,
    threshold
  };
}

function languageMetrics(value: string) {
  const clean = normalizeText(value);
  const hanCharacters = (clean.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latinCharacters = (clean.match(/[a-z]/gi) ?? []).length;
  const vietnameseDiacritics = (clean.match(VIETNAMESE_DIACRITIC) ?? []).length;
  const meaningfulCharacters = hanCharacters + latinCharacters;
  return {
    hanCharacters,
    latinCharacters,
    vietnameseDiacritics,
    meaningfulCharacters,
    chineseRatio: meaningfulCharacters === 0 ? 0 : hanCharacters / meaningfulCharacters,
    latinRatio: meaningfulCharacters === 0 ? 0 : latinCharacters / meaningfulCharacters,
    vietnameseDiacriticRatio: meaningfulCharacters === 0
      ? 0
      : vietnameseDiacritics / meaningfulCharacters
  };
}

function isVietnamese(language: string): boolean {
  return language === 'vi' || language.startsWith('vi_') || language === 'vietnamese';
}

function expectedLanguageLabel(language: string): string {
  if (isChinese(language)) return 'Chinese';
  if (isVietnamese(language)) return 'Vietnamese';
  if (language === 'en' || language.startsWith('en_') || language === 'english') return 'English';
  return language.toUpperCase();
}

async function subtitleSimilarity(path: string, targetText: string): Promise<number | null> {
  try {
    const cues = await validateSrtFile(path, { allowOverlaps: true });
    return diceCoefficient(
      normalizeText(cues.map(cue => cue.text).join('\n')),
      normalizeText(targetText)
    );
  } catch {
    return null;
  }
}

function normalizeText(value: string): string {
  return value
    .replace(/<[^>]+>|\{\\[^}]+\}/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .toLowerCase()
    .trim();
}

function diceCoefficient(left: string, right: string): number {
  const leftParts = ngrams(left.replace(/\s+/g, ''), 3);
  const rightParts = ngrams(right.replace(/\s+/g, ''), 3);
  if (leftParts.length === 0 || rightParts.length === 0) return left === right ? 1 : 0;
  const counts = new Map<string, number>();
  for (const part of leftParts) counts.set(part, (counts.get(part) ?? 0) + 1);
  let intersection = 0;
  for (const part of rightParts) {
    const count = counts.get(part) ?? 0;
    if (count <= 0) continue;
    intersection += 1;
    counts.set(part, count - 1);
  }
  return 2 * intersection / (leftParts.length + rightParts.length);
}

function ngrams(value: string, size: number): string[] {
  if (value.length < size) return value.length === 0 ? [] : [value];
  return Array.from({ length: value.length - size + 1 }, (_, index) => value.slice(index, index + size));
}

function readLanguage(value: CreatorJson | undefined): string {
  return typeof value === 'string' ? value.trim().toLowerCase().replace('-', '_') : '';
}

function isChinese(language: string): boolean {
  return language === 'zh' || language.startsWith('zh_') || language === 'chinese';
}

function compactEvidence(input: Record<string, CreatorJson>): Record<string, CreatorJson> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== null));
}
