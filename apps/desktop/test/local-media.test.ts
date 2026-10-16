import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { localMediaResponse } from '../src/main/protocol-handler.js';

const root = mkdtempSync(join(tmpdir(), 'opencreator-local-media-'));
const videoPath = join(root, 'episode.mp4');
writeFileSync(videoPath, '0123456789');

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function request(path: string): URL {
  return new URL(`opencreator-app://app/__local-media?path=${encodeURIComponent(path)}`);
}

describe('Desktop local media response', () => {
  it('streams an allowed media file with media headers', async () => {
    const response = await localMediaResponse(request(videoPath));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await response.text()).toBe('0123456789');
  });

  it('rejects non-media extensions and relative paths', async () => {
    expect((await localMediaResponse(request(join(root, 'secret.txt')))).status).toBe(403);
    expect((await localMediaResponse(request('episode.mp4')))).toMatchObject({ status: 403 });
  });

  it('returns 404 for a missing media file', async () => {
    expect((await localMediaResponse(request(join(root, 'missing.mp4')))).status).toBe(404);
  });
});
