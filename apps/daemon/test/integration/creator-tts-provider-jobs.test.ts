import { createDefaultCreatorServicesConfig, creatorTtsProviders } from '@opencreator/protocol';
import type { FastifyInstance } from 'fastify';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/api/server.js';

let server: FastifyInstance | undefined;
let tempDir = '';

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
  tempDir = '';
});

/**
 * Gốc rễ lỗi "Yêu cầu /creator/jobs không hợp lệ (VALIDATION_FAILED)": schema zod của
 * template chỉ nhận 5 provider TTS cũ, trong khi Cấu hình API cho phép chọn ElevenLabs
 * và VieNeu-TTS. Khi provider đang cấu hình là một trong hai, mọi lần tạo job (kể cả
 * preset dùng defaults) đều bị từ chối 400. Test này khoá lại: mọi provider mà giao
 * diện cấu hình được đều phải tạo được job.
 */
describe('creator job TTS providers', () => {
  it.each(['video-translation', 'smart-dubbing', 'stickman-video'] as const)(
    'creates %s jobs for every configurable TTS provider',
    async templateId => {
      tempDir = await mkdtemp(join(tmpdir(), `creator-tts-provider-${templateId}-`));
      const config = createDefaultCreatorServicesConfig();
      server = await buildServer({
        token: 'secret',
        dataDir: tempDir,
        codexHome: join(tempDir, 'codex-home'),
        creatorServicesConfigStore: {
          async read() { return structuredClone(config); },
          async write(next) { return structuredClone(next); },
          async reset() { return structuredClone(config); }
        },
        codexProviderCredentialStore: {
          async readApiKey() { return undefined; },
          async writeApiKey() {}
        }
      });

      for (const ttsProvider of creatorTtsProviders) {
        const created = await server.inject({
          method: 'POST',
          url: '/creator/jobs',
          headers: { authorization: 'Bearer secret' },
          payload: {
            projectId: 'project_tts_provider',
            templateId,
            creationKey: `${templateId}-${ttsProvider}`,
            state: { ttsProvider }
          }
        });
        expect(created.statusCode, `${templateId} / ${ttsProvider}: ${created.body}`).toBe(201);
        expect(created.json().job.state.ttsProvider).toBe(ttsProvider);
      }
    }
  );

  it('still rejects an unknown TTS provider', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'creator-tts-provider-unknown-'));
    const config = createDefaultCreatorServicesConfig();
    server = await buildServer({
      token: 'secret',
      dataDir: tempDir,
      codexHome: join(tempDir, 'codex-home'),
      creatorServicesConfigStore: {
        async read() { return structuredClone(config); },
        async write(next) { return structuredClone(next); },
        async reset() { return structuredClone(config); }
      },
      codexProviderCredentialStore: {
        async readApiKey() { return undefined; },
        async writeApiKey() {}
      }
    });

    const created = await server.inject({
      method: 'POST',
      url: '/creator/jobs',
      headers: { authorization: 'Bearer secret' },
      payload: {
        projectId: 'project_tts_provider',
        templateId: 'video-translation',
        creationKey: 'video-translation-unknown',
        state: { ttsProvider: 'not-a-provider' }
      }
    });
    expect(created.statusCode).toBe(400);
    expect(created.json().error.code).toBe('VALIDATION_FAILED');
  });
});
