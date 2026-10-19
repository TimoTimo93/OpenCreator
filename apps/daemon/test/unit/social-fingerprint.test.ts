/**
 * Test vân tay cố định theo cụm + selectors bổ sung từ cộng đồng:
 * - loadClusterFingerprint: gọi N lần vẫn chỉ sinh 1 lần rồi reuse (cache
 *   file + cache tiến trình); file hỏng/thiếu → sinh mới + ghi file.
 * - buildLaunchFingerprintPatch: vân tay đè đúng vào launch options
 *   (userAgent, viewport, locale, timezone…).
 * - selectors.json: bổ sung mới vẫn parse được + fallback đầy đủ.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildLaunchFingerprintPatch,
  FINGERPRINT_SCHEMA_VERSION,
  geoFromProxy,
  loadClusterFingerprint,
  type ClusterFingerprint
} from '../../src/social/fingerprint.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
  cleanup = undefined;
});

/** Fingerprint giả lập (không chạy generator thật). */
function fakeFingerprint(tag: string): ClusterFingerprint {
  return {
    version: FINGERPRINT_SCHEMA_VERSION,
    generatedAt: '2026-01-01T00:00:00.000Z',
    locale: 'vi-VN',
    languages: ['vi-VN', 'vi', 'en-US', 'en'],
    timezoneId: 'Asia/Ho_Chi_Minh',
    userAgent: `Mozilla/5.0 (Windows NT 10.0) Chrome/125 ${tag}`,
    platform: 'Win32',
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    webGl: { vendor: 'Google Inc.', renderer: 'ANGLE (Fake)' },
    hardwareConcurrency: 8,
    deviceMemory: 8,
    raw: {} as ClusterFingerprint['raw']
  };
}

describe('loadClusterFingerprint (generator + cache cố định)', () => {
  it('sinh đúng 1 lần rồi reuse dù gọi 10 lần (cache file)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-cache-'));
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
    let generateCalls = 0;
    const fake = fakeFingerprint('call-A');
    const generate = (proxy: string): ClusterFingerprint => {
      void proxy;
      generateCalls += 1;
      return fake;
    };
    const profileDir = join(dir, 'cluster_a');

    const results: ClusterFingerprint[] = [];
    for (let index = 0; index < 10; index += 1) {
      results.push(await loadClusterFingerprint(profileDir, '', { generate }));
    }

    expect(generateCalls).toBe(1); // bấm thế nào cũng chỉ sinh 1 lần
    expect(new Set(results.map(fp => fp.userAgent)).size).toBe(1);
    expect(results.every(fp => fp.userAgent === fake.userAgent)).toBe(true);

    // File ghi ra đúng schema — lần mở tiến trình sau đọc lại cùng file.
    const persisted = JSON.parse(await readFile(join(profileDir, 'fingerprint.json'), 'utf8'));
    expect(persisted.userAgent).toBe(fake.userAgent);
    expect(persisted.version).toBe(FINGERPRINT_SCHEMA_VERSION);
  });

  it('2 cụm có 2 profile khác nhau → sinh riêng (fake generator gắn 2 tag)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-cache-'));
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
    const pool = ['A', 'B'];
    let index = 0;
    const generate = (): ClusterFingerprint => fakeFingerprint(`tag-${pool[index++]}`);
    const a = await loadClusterFingerprint(join(dir, 'cluster_a'), '', { generate });
    const b = await loadClusterFingerprint(join(dir, 'cluster_b'), '', { generate });
    expect(a.userAgent).not.toBe(b.userAgent);
    // Gọi lại cụm A → vẫn reuse của cụm A chứ không sinh mới.
    const again = await loadClusterFingerprint(join(dir, 'cluster_a'), '', { generate });
    expect(again.userAgent).toBe(a.userAgent);
  });

  it('file hỏng → sinh mới và ghi đè lại', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-corrupt-'));
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
    const profileDir = join(dir, 'cluster_x');
    await mkdir(profileDir, { recursive: true });
    await writeFile(join(profileDir, 'fingerprint.json'), '{not json!', 'utf8');
    let generateCalls = 0;
    const fake = fakeFingerprint('regen');
    const generate = (): ClusterFingerprint => { generateCalls += 1; return fake; };
    const fp = await loadClusterFingerprint(profileDir, '', { generate });
    expect(generateCalls).toBe(1);
    expect(fp.userAgent).toBe(fake.userAgent);
    const persisted = JSON.parse(await readFile(join(profileDir, 'fingerprint.json'), 'utf8'));
    expect(persisted.userAgent).toBe(fake.userAgent);
  });

  it('schema cũ/sai → sinh mới (không reuse fingerprint sai chuẩn)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fp-schema-'));
    cleanup = async () => { await rm(dir, { recursive: true, force: true }); };
    const profileDir = join(dir, 'cluster_y');
    await mkdir(profileDir, { recursive: true });
    await writeFile(
      join(profileDir, 'fingerprint.json'),
      JSON.stringify({ version: 99, userAgent: 'UA-mới-y' , locale: '', timezoneId: '', viewport: { width: 100, height: 100 } }),
      'utf8'
    );
    const fp = await loadClusterFingerprint(profileDir, '', { generate: () => fakeFingerprint('v1') });
    expect(fp.userAgent).toContain('v1');
  });
});

describe('buildLaunchFingerprintPatch (áp vào launch khi mở persistent context)', () => {
  it('patch chứa đúng userAgent/viewport/locale/timezone của vân tay', () => {
    const fp = fakeFingerprint('patched');
    const patch = buildLaunchFingerprintPatch(fp);
    expect(patch.userAgent).toBe(fp.userAgent);
    expect(patch.viewport).toEqual({ width: 1920, height: 1080 });
    expect(patch.deviceScaleFactor).toBe(fp.deviceScaleFactor);
    expect(patch.locale).toBe('vi-VN');
    expect(patch.timezoneId).toBe('Asia/Ho_Chi_Minh');
  });
});

describe('geoFromProxy (nước của proxy → geo, mặc định vi-VN)', () => {
  it('nhận nhãn cc trong username/URL', () => {
    expect(geoFromProxy('http://user-cc-us:pw@1.2.3.4:8000')).toEqual({ locale: 'en-US', timezoneId: 'America/New_York' });
    expect(geoFromProxy('http://u?cc=jp@host')).toEqual({ locale: 'ja-JP', timezoneId: 'Asia/Tokyo' });
    expect(geoFromProxy('http://user_country.sg@1.1.1.1')).toEqual({ locale: 'en-SG', timezoneId: 'Asia/Singapore' });
  });
  it('không suy được → vi-VN / Asia/Ho_Chi_Minh', () => {
    expect(geoFromProxy('')).toEqual({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    expect(geoFromProxy('http://u:p@1.2.3.4:9090')).toEqual({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
    expect(geoFromProxy('http://u:mã-quốc-nhận-diện')).toEqual({ locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' });
  });
});

// -------------------------------------------------------------------------
// Selectors bổ sung mới — parse được JSON + có fallback.
// -------------------------------------------------------------------------

import { readFile as readFileSafe } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SELECTORS_PATH = fileURLToPath(new URL('../../src/social/platforms/selectors.json', import.meta.url));

describe('selectors.json (bổ sung mẫu cộng đồng, không mất selector cũ)', () => {
  it('parse được và các key mới đều là chuỗi fallback không rỗng', async () => {
    const raw = JSON.parse(await readFileSafe(SELECTORS_PATH, 'utf8')) as Record<string,
      Record<string, string>>;
    // TikTok mới.
    for (const key of [
      'cookie_banner_btn', 'split_window_not_now_btn', 'copyright_popup_btn',
      'post_now_btn', 'post_confirmation'
    ]) {
      expect(typeof raw.tiktok_studio?.[key]).toBe('string');
      expect(raw.tiktok_studio![key]!.trim()).not.toBe('');
    }
    // YouTube mới.
    for (const key of ['publish_confirm_btn', 'published_confirmation']) {
      expect(typeof raw.youtube_studio?.[key]).toBe('string');
      expect(raw.youtube_studio![key]!.trim()).not.toBe('');
    }
    // Selector cũ không bị xoá.
    expect(raw.youtube_studio?.next_btn ?? '').toBe('ytcp-button#next-button');
    expect(raw.tiktok_studio?.post_btn ?? '').toContain('post_video_button');
    expect(raw.facebook_browser?.publish_btn ?? '').not.toBe('');
  });
});
