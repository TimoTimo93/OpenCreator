import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  canReadLocalMedia,
  fileNameFromPath,
  fileFromLocalPath,
  localMediaUrl,
  mediaTypeForFileName
} from './local-media-file.js';

describe('local media file helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('derives file names and media types from paths', () => {
    expect(fileNameFromPath('D:\\downloads\\episode-01.mp4')).toBe('episode-01.mp4');
    expect(fileNameFromPath('/home/user/clip.MOV')).toBe('clip.MOV');
    expect(fileNameFromPath('')).toBe('video.mp4');
    expect(mediaTypeForFileName('episode-01.mp4')).toBe('video/mp4');
    expect(mediaTypeForFileName('voice.m4a')).toBe('audio/mp4');
    expect(mediaTypeForFileName('notes.txt')).toBeUndefined();
  });

  it('builds an encoded local media url', () => {
    expect(localMediaUrl('D:\\downloads\\a b.mp4'))
      .toBe('opencreator-app://app/__local-media?path=D%3A%5Cdownloads%5Ca%20b.mp4');
  });

  it('reads a local media file into a File', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { 'Content-Type': 'video/mp4' }
    }));
    vi.stubGlobal('fetch', fetchMock);

    const file = await fileFromLocalPath('D:\\downloads\\episode-01.mp4');

    expect(file.name).toBe('episode-01.mp4');
    expect(file.type).toBe('video/mp4');
    expect(file.size).toBe(3);
    expect(fetchMock).toHaveBeenCalledWith(
      'opencreator-app://app/__local-media?path=D%3A%5Cdownloads%5Cepisode-01.mp4',
      { cache: 'no-store' }
    );
  });

  it('throws when the shell cannot read the file', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })));

    await expect(fileFromLocalPath('D:\\downloads\\missing.mp4'))
      .rejects.toThrow('local_media_read_failed:404');
  });

  it('reports shell support from the page protocol', () => {
    expect(canReadLocalMedia()).toBe(false);
  });
});
