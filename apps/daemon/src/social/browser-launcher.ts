/**
 * Lớp khởi trình duyệt chống phát hiện (Patchright):
 * - Persistent context theo cụm — cookie/login lưu tại profileDir.
 * - VÂN TAY CỐ ĐỊNH THEO CỤM: `fingerprint-generator` (Apify, Apache-2.0)
 *   sinh 1 lần duy nhất, lưu `fingerprint.json` trong profileDir; lần mở sau
 *   ĐỌC LẠI file này và áp vào launch options (userAgent, viewport,
 *   deviceScaleFactor, locale, timezoneId — thay `viewport: null` cố định
 *   trước đây). Geo theo quốc gia proxy khi có nhãn cc, mặc định vi-VN.
 */
import { chromium } from 'patchright';
import type { BrowserContext, Page } from 'patchright';
import type { SocialBrowserHandle } from './worker.js';
import {
  buildLaunchFingerprintPatch,
  loadClusterFingerprint
} from './fingerprint.js';

export type LaunchClusterBrowserInput = {
  clusterId: string;
  proxyServer: string;
  profileDir: string;
};

const CHANNEL_CANDIDATES: Array<'chrome' | 'msedge' | undefined> = ['chrome', 'msedge', undefined];

export async function launchClusterBrowser(input: LaunchClusterBrowserInput): Promise<SocialBrowserHandle> {
  const proxy = parseProxy(input.proxyServer);
  // Vân tay cố định của cụm (cache trong file profileDir) — áp vào launch.
  const fingerprint = await loadClusterFingerprint(input.profileDir, input.proxyServer);
  const fingerprintPatch = buildLaunchFingerprintPatch(fingerprint);
  let lastError: Error | undefined;
  for (const channel of CHANNEL_CANDIDATES) {
    try {
      const context = await chromium.launchPersistentContext(input.profileDir, {
        ...(channel === undefined ? {} : { channel }),
        headless: false,
        ...fingerprintPatch,
        proxy,
        timeout: 60_000
      });
      return createHandle(context);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }
  throw new Error(
    `Không khởi động được trình duyệt (Chrome/Edge đều lỗi). Hãy cài Google Chrome. Lỗi cuối: ${lastError?.message ?? 'không rõ'}`
  );
}

function createHandle(context: BrowserContext): SocialBrowserHandle {
  return {
    async newPage(url?: string): Promise<unknown> {
      const page = await context.newPage();
      if (url !== undefined && url !== '') {
        await page.goto(url, { timeout: 60_000, waitUntil: 'domcontentloaded' });
      }
      return page;
    },
    async close(): Promise<void> {
      try {
        await context.close();
      } catch {
        // Context có thể đã bị đóng tay bởi người dùng — bỏ qua.
      }
    }
  };
}

export type ParsedProxy = {
  server: string;
  username?: string;
  password?: string;
} | undefined;

export function parseProxy(proxyServer: string): ParsedProxy {
  const trimmed = proxyServer.trim();
  if (trimmed === '') return undefined;
  try {
    const url = new URL(trimmed);
    const server = `${url.protocol.toLowerCase().replace(/^https:$/, 'http:')}//${url.hostname}${url.port !== '' ? `:${url.port}` : ''}`;
    if (url.username === '' && url.password === '') return { server };
    return {
      server,
      username: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password)
    };
  } catch {
    // Không parse được URL — thử format "host:port" thô.
    return { server: `http://${trimmed}` };
  }
}

export type { Page };
