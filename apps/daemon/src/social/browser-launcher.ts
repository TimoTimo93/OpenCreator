/**
 * Lớp khởi trình duyệt chống phát hiện (Patchright):
 * - Persistent context theo cụm — cookie/login lưu tại profileDir.
 * - VÂN TAY CỐ ĐỊNH THEO CỤM: `fingerprint-generator` (Apify, Apache-2.0)
 *   sinh 1 lần duy nhất, lưu `fingerprint.json` trong profileDir; lần mở sau
 *   ĐỌC LẠI file này và áp vào launch options (userAgent, viewport,
 *   deviceScaleFactor, locale, timezoneId — thay `viewport: null` cố định
 *   trước đây). Geo theo quốc gia proxy khi có nhãn cc, mặc định vi-VN.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
      // "Opening in existing browser session" = một chrome/edge còn ở lại từ lần
      // trước (daemon khởi động lại nhưng cửa sổ cụm chưa đóng) đang giữ
      // user-data-dir của cụm. Dọn orphan đúng profile đó rồi thử lại —
      // KHÔNG đụng trình duyệt thường của người dùng (chỉ process có
      // --user-data-dir trùng profile này mới bị dọn).
      if (lastError.message.includes('Opening in existing browser session')) {
        const cleaned = await closeOrphanBrowsersForProfile(input.profileDir);
        if (cleaned === 0) break;
      }
    }
  }
  throw new Error(
    `Không khởi động được trình duyệt (Chrome/Edge đều lỗi). Hãy đóng cửa sổ trình duyệt cũ của cụm rồi thử lại. Lỗi cuối: ${lastError?.message ?? 'không rõ'}`
  );
}

/** Số process chrome/edge orphan đang giữ đúng user-data-dir của cụm — trả 0 nếu không tra được. */
async function closeOrphanBrowsersForProfile(profileDir: string): Promise<number> {
  const execFileAsync = promisify(execFile);
  try {
    const query = 'Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq "chrome.exe" -or $_.Name -eq "msedge.exe") -and $_.CommandLine -match [regex]::Escape("'
      + normalizeToSlash(profileDir) + '") } | ForEach-Object { $_.ProcessId }';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', query], {
      encoding: 'utf8',
      timeout: 20_000
    });
    const pids = stdout.split(/\r?\n/).map(line => line.trim()).filter(line => /^\d+$/.test(line));
    if (pids.length === 0) return 0;
    for (const pid of pids) {
      await execFileAsync('taskkill', ['/F', '/T', '/PID', pid]).catch(() => undefined);
    }
    return pids.length;
  } catch {
    return 0;
  }
}

/** Escape regex cho toàn bộ path profile (match cả '\\' và '/' trong command line). */
function normalizeToSlash(profileDir: string): string {
  return profileDir.replace(/[\\/+()[\]{}$^.|*?]/g, ch => `\\${ch}`);
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
