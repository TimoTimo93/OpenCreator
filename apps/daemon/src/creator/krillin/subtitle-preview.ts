import type { CreatorSubtitlePreviewRequest } from '@opencreator/protocol';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import sharp from 'sharp';
import type { YtDlpRuntime } from '../yt-dlp/runtime.js';
import { buildKrillinSubtitleStyle } from './adapter.js';
import { cliSupportsRenderLineMode, createKrillinCliEnvironment } from './cli-runner.js';
import { readKrillinRuntimeManifest, resolveInside } from './manifest.js';

const execute = promisify(execFile);

export function createSubtitlePreviewService(input: {
  resourceRoot: string;
  workRoot: string;
  ensureRuntimeReady(): Promise<void>;
  getYtDlpRuntime?(): YtDlpRuntime | undefined;
}) {
  return {
    async render(request: CreatorSubtitlePreviewRequest, signal?: AbortSignal): Promise<Buffer> {
      await input.ensureRuntimeReady();
      const manifest = readKrillinRuntimeManifest(input.resourceRoot);
      const cli = manifest.resources.find(resource => /(?:^|\/)krillinai-cli(?:\.exe)?$/i.test(resource.path));
      if (cli === undefined) throw new Error('KrillinAI CLI is unavailable');
      const cliExecutable = resolveInside(input.resourceRoot, cli.path);
      if (!cliSupportsRenderLineMode(cliExecutable)) {
        return await renderFallbackSubtitlePreview(request);
      }
      await mkdir(input.workRoot, { recursive: true });
      const workdir = await mkdtemp(join(input.workRoot, 'subtitle-preview-'));
      try {
        await mkdir(join(workdir, 'config'));
        await writeFile(join(workdir, 'config/config.toml'), '[app]\nproxy = ""\n', { mode: 0o600 });
        const stylePath = join(workdir, 'style.json');
        const subtitlePath = join(workdir, 'preview.srt');
        const lines = request.bilingual
          ? request.subtitlePosition === 'top'
            ? [request.translationText, request.originalText]
            : [request.originalText, request.translationText]
          : [request.translationText];
        await writeFile(stylePath, JSON.stringify(buildKrillinSubtitleStyle(request.subtitleStyle)));
        await writeFile(subtitlePath, `1\n00:00:00,000 --> 00:00:01,000\n${lines.join('\n')}\n\n`);
        const bin = join(input.resourceRoot, 'bin');
        const ytDlp = input.getYtDlpRuntime?.();
        try {
          await execute(cliExecutable, [
            request.width >= request.height ? 'render-horizontal' : 'render-vertical',
            '--workdir', workdir, '--subtitle', subtitlePath,
            '--subtitle-style-file', stylePath,
            '--line-mode', request.bilingual ? `bilingual-target-${request.subtitlePosition}` : 'target-only',
            '--preview-width', String(request.width), '--preview-height', String(request.height)
          ], {
            cwd: workdir,
            env: {
              ...createKrillinCliEnvironment(process.env, bin, input.resourceRoot, bin, ytDlp),
              ...(ytDlp !== undefined && ytDlp.prefixArgs.length > 0
                ? { OPENCREATOR_YT_DLP_COMMAND: JSON.stringify([ytDlp.executable, ...ytDlp.prefixArgs]) }
                : {})
            },
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
            windowsHide: true,
            signal
          });
        } catch (cause) {
          const stdout = (cause as { stdout?: string }).stdout ?? '';
          const stderr = (cause as { stderr?: string }).stderr ?? '';
          if (stdout.includes('flag provided but not defined') || stderr.includes('flag provided but not defined')) {
            return await renderFallbackSubtitlePreview(request);
          }
          let response: { error?: { message?: string } } | undefined;
          try { response = JSON.parse(stdout?.trim().split('\n').at(-1) ?? ''); } catch { /* Keep process failures without JSON diagnostics. */ }
          if (response?.error?.message) throw new Error(response.error.message);
          throw cause;
        }
        return await readFile(join(workdir, 'subtitle-preview.png'));
      } finally {
        await rm(workdir, { recursive: true, force: true });
      }
    }
  };
}

function escapeXml(unsafe: string): string {
  return unsafe.replace(/[<>&'"]/g, c => {
    switch (c) {
      case '<': return '&lt;';
      case '>': return '&gt;';
      case '&': return '&amp;';
      case '\'': return '&apos;';
      case '"': return '&quot;';
      default: return c;
    }
  });
}

async function renderFallbackSubtitlePreview(request: CreatorSubtitlePreviewRequest): Promise<Buffer> {
  const lines = request.bilingual
    ? request.subtitlePosition === 'top'
      ? [request.translationText, request.originalText]
      : [request.originalText, request.translationText]
    : [request.translationText];
  const fontSize = request.subtitleStyle.fontSize === 'small' ? 22 : request.subtitleStyle.fontSize === 'large' ? 34 : 28;
  const primaryColor = request.subtitleStyle.primaryColor || '#FFFFFF';
  const secondaryColor = request.subtitleStyle.secondaryColor || '#FFD45C';
  const outlineColor = request.subtitleStyle.outlineColor || '#000000';
  const outlineWidth = request.subtitleStyle.outlineWidth ?? 2;
  const fontFamily = request.subtitleStyle.fontPreset === 'serif' ? 'serif' : 'sans-serif';

  const textElements = lines.map((line, idx) => {
    const yOffset = request.height - 40 - (lines.length - 1 - idx) * (fontSize + 10);
    const fill = (lines.length > 1 && idx === 1) ? secondaryColor : primaryColor;
    return `<text x="50%" y="${yOffset}" text-anchor="middle" font-family="${fontFamily}" font-size="${fontSize}px" font-weight="bold" fill="${fill}" stroke="${outlineColor}" stroke-width="${outlineWidth}" paint-order="stroke fill">${escapeXml(line)}</text>`;
  }).join('\n');

  const svg = `<svg width="${request.width}" height="${request.height}" xmlns="http://www.w3.org/2000/svg">
    ${textElements}
  </svg>`;
  return await sharp(Buffer.from(svg)).png().toBuffer();
}

export type SubtitlePreviewService = ReturnType<typeof createSubtitlePreviewService>;
