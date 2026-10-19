/**
 * Vân tay thiết bị CỐ ĐỊNH theo cụm kênh:
 * - Sinh 1 LẦN duy nhất mỗi cụm bằng `fingerprint-generator` (Apify, Apache-2.0)
 *   rồi lưu `fingerprint.json` vào thư mục profile của cụm; các lần mở sau
 *   luôn ĐỌC LẠI file này (không sinh mới) — trình duyệt của giữa cụm không
 *   đổi vân tay qua các phiên, khác biệt với các cụm khác.
 * - Không cài injector (fingerprint-injector cần khớp playwright-core version
 *   với patchright — rủi ro); ta tự áp các trường an toàn khi launch:
 *   userAgent, viewport, deviceScaleFactor, locale, timezoneId. Các trường
 *   chỉ mang tính tham khảo (webGl, screen, hardware…) vẫn lưu trong file
 *   để dùng sau khi injector tương thích.
 * - Geo/locale/timezone suy từ proxy khi được gắn nhãn quốc gia (dạng
 *   "user-cc-us", "?cc=jp"…); không suy được → mặc định vi-VN/Asia/Ho_Chi_Minh.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { FingerprintGenerator } from 'fingerprint-generator';
import type { Fingerprint } from 'fingerprint-generator';

export const FINGERPRINT_SCHEMA_VERSION = 1;

export type ClusterFingerprint = {
  version: number;
  generatedAt: string;
  /** Geo suy từ proxy (hoặc mặc định vi-VN). */
  locale: string;
  languages: string[];
  timezoneId: string;
  userAgent: string;
  platform: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  webGl: { vendor: string; renderer: string };
  hardwareConcurrency: number;
  deviceMemory: number | null;
  /** Fingerprint gốc của generator (tham khảo / dùng khi injector bật sau). */
  raw: Fingerprint;
};

export type FingerprintLoaderOptions = {
  /** Thay generator cho test (mặc định dùng fingerprint-generator). */
  generate?: FingerprintFactory;
};

export type FingerprintFactory = (proxyServer: string) => ClusterFingerprint;

/** Bộ sinh dùng chung cả tiến trình — tạo 1 lần (tốn RAM do dataset bên trong). */
let sharedGenerator: FingerprintGenerator | undefined;

function getGenerator(): FingerprintGenerator {
  sharedGenerator ??= new FingerprintGenerator({
    browsers: [{ name: 'chrome', minVersion: 120 }],
    operatingSystems: ['windows'],
    devices: ['desktop'],
    locales: ['vi-VN']
  });
  return sharedGenerator;
}

const FINGERPRINT_FILENAME = 'fingerprint.json';

/** Cache trong tiến trình: cụm đã load/sinh vân tay thì không đọc file lại. */
const fingerprintCache = new Map<string, ClusterFingerprint>();

/**
 * Đọc vân tay cố định của cụm từ profileDir; thiếu/hỏng → sinh mới + ghi file.
 * Sinh đúng 1 lần thật sự: các lần gọi sau reuse cache/file (kể cả gọi 10 lần).
 */
export async function loadClusterFingerprint(
  profileDir: string,
  proxyServer: string,
  options?: FingerprintLoaderOptions
): Promise<ClusterFingerprint> {
  const cached = fingerprintCache.get(profileDir);
  if (cached !== undefined) return cached;
  const path = join(profileDir, FINGERPRINT_FILENAME);
  const fromFile = await readFingerprintFile(path);
  if (fromFile !== null) {
    fingerprintCache.set(profileDir, fromFile);
    return fromFile;
  }
  const generated = (options?.generate ?? defaultGenerate)(proxyServer);
  fingerprintCache.set(profileDir, generated);
  await writeFingerprintFile(path, generated).catch(() => undefined);
  return generated;
}

/** Ghi đè chú ý: hàm sinh mặc định dùng generator với geo theo proxy. */
function defaultGenerate(proxyServer: string): ClusterFingerprint {
  const geo = geoFromProxy(proxyServer);
  const { fingerprint } = getGenerator().getFingerprint({
    locales: [geo.locale],
    screen: { minWidth: 1280, minHeight: 720 }
  });
  const userAgent = fingerprint.navigator.userAgent;
  return {
    version: FINGERPRINT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    locale: geo.locale,
    languages: [
      geo.locale,
      geo.locale.split('-')[0]!,
      'en-US',
      'en'
    ],
    timezoneId: geo.timezoneId,
    userAgent,
    platform: fingerprint.navigator.platform || 'Win32',
    viewport: {
      width: fingerprint.screen.width,
      height: fingerprint.screen.height
    },
    deviceScaleFactor: fingerprint.screen.devicePixelRatio || 1,
    webGl: {
      vendor: fingerprint.videoCard?.vendor ?? 'Google Inc. (NVIDIA)',
      renderer: fingerprint.videoCard?.renderer ?? 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1050 Direct3D11 vs_5_0 ps_5_0, D3D11)'
    },
    hardwareConcurrency: fingerprint.navigator.hardwareConcurrency || 8,
    deviceMemory: fingerprint.navigator.deviceMemory ?? null,
    raw: fingerprint
  };
}

async function readFingerprintFile(path: string): Promise<ClusterFingerprint | null> {
  try {
    const text = await readFile(path, 'utf8');
    const parsed = JSON.parse(text);
    if (!isValidFingerprint(parsed)) return null;
    return parsed as ClusterFingerprint;
  } catch {
    return null; // File thiếu hoặc hỏng → sinh mới bên ngoài.
  }
}

function isValidFingerprint(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const cursor = value as Partial<ClusterFingerprint>;
  if (cursor.version !== FINGERPRINT_SCHEMA_VERSION) return false;
  if (typeof cursor.userAgent !== 'string' || cursor.userAgent.includes('HeadlessChrome')) return false;
  if (typeof cursor.locale !== 'string' || cursor.locale === '') return false;
  if (typeof cursor.timezoneId !== 'string' || cursor.timezoneId === '') return false;
  const viewport = cursor.viewport;
  return viewport !== undefined
    && Number.isFinite(viewport.width) && viewport.width >= 400
    && Number.isFinite(viewport.height) && viewport.height >= 400;
}

async function writeFingerprintFile(path: string, fingerprint: ClusterFingerprint): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(fingerprint, null, 2)}\n`, 'utf8');
}

export type LaunchOptionsPatch = {
  userAgent: string;
  viewport: { width: number; height: number };
  deviceScaleFactor: number;
  locale: string;
  timezoneId: string;
};

/** Chuyển vân tay → patch launchPersistentContext options (áp bám pattern). */
export function buildLaunchFingerprintPatch(fingerprint: ClusterFingerprint): LaunchOptionsPatch {
  return {
    userAgent: fingerprint.userAgent,
    viewport: { width: fingerprint.viewport.width, height: fingerprint.viewport.height },
    deviceScaleFactor: fingerprint.deviceScaleFactor,
    locale: fingerprint.locale,
    timezoneId: fingerprint.timezoneId
  };
}

// ---------------------------------------------------------------------------
// Geo từ proxy
// ---------------------------------------------------------------------------

type ProxyGeo = { locale: string; timezoneId: string };

const GEO_BY_COUNTRY: Record<string, ProxyGeo> = {
  vn: { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' },
  us: { locale: 'en-US', timezoneId: 'America/New_York' },
  gb: { locale: 'en-GB', timezoneId: 'Europe/London' },
  uk: { locale: 'en-GB', timezoneId: 'Europe/London' },
  jp: { locale: 'ja-JP', timezoneId: 'Asia/Tokyo' },
  kr: { locale: 'ko-KR', timezoneId: 'Asia/Seoul' },
  sg: { locale: 'en-SG', timezoneId: 'Asia/Singapore' },
  my: { locale: 'ms-MY', timezoneId: 'Asia/Kuala_Lumpur' },
  id: { locale: 'id-ID', timezoneId: 'Asia/Jakarta' },
  th: { locale: 'th-TH', timezoneId: 'Asia/Bangkok' },
  tw: { locale: 'zh-TW', timezoneId: 'Asia/Taipei' },
  hk: { locale: 'zh-HK', timezoneId: 'Asia/Hong_Kong' },
  de: { locale: 'de-DE', timezoneId: 'Europe/Berlin' },
  fr: { locale: 'fr-FR', timezoneId: 'Europe/Paris' },
  ru: { locale: 'ru-RU', timezoneId: 'Europe/Moscow' },
  in: { locale: 'en-IN', timezoneId: 'Asia/Kolkata' },
  au: { locale: 'en-AU', timezoneId: 'Australia/Sydney' },
  ca: { locale: 'en-CA', timezoneId: 'America/Toronto' },
  br: { locale: 'pt-BR', timezoneId: 'America/Sao_Paulo' }
};

const DEFAULT_GEO: ProxyGeo = { locale: 'vi-VN', timezoneId: 'Asia/Ho_Chi_Minh' };

/**
 * Suy quốc gia từ chuỗi proxy theo nhãn phổ biến trong username/URL:
 * `http://user-cc-us:pass@host`, `http://user?cc=jp@…`, `user_country.sg`.
 * Dùng tham chiếu chuỗi thuần (không regex — tránh phụ.match hoạt động chênh
 * lệch giữa các bản Node). Không có nhãn → vi-VN.
 */
export function geoFromProxy(proxyServer: string): ProxyGeo {
  if (proxyServer.trim() === '') return DEFAULT_GEO;
  const code = findCountryCode(proxyServer);
  if (code === null) return DEFAULT_GEO;
  return GEO_BY_COUNTRY[code] ?? DEFAULT_GEO;
}

const GEO_LABELS = ['country_code', 'country', 'region', 'cc'] as const;
const SEPARATORS = ['-', '_', '.', '=', '?', '&', ' '];

/** Tìm mã nước 2 ký tự sau nhãn cc/country/region (viết thường). */
function findCountryCode(proxyServer: string): string | null {
  const lowered = proxyServer.toLowerCase();
  for (const label of GEO_LABELS) {
    let anchor = lowered.indexOf(label);
    while (anchor !== -1) {
      const before = anchor === 0 ? null : lowered[anchor - 1]!;
      if (before === null || SEPARATORS.includes(before)) {
        const after = label.length;
        const tip = lowered[anchor + after]!;
        if (tip !== undefined && SEPARATORS.includes(tip)) {
          const code = lowered.slice(anchor + after + 1, anchor + after + 3);
          if (/^[a-z]{2}$/.test(code)) return code;
        }
      }
      anchor = lowered.indexOf(label, anchor + 1);
    }
  }
  return null;
}
