export type DownloadIssueFact = {
  code: string;
  message: string;
  kind: 'unauthorized' | 'unsupported' | 'http-rejected' | 'timeout' | 'dns' | 'connection-refused' | 'unavailable' | 'unknown';
  httpStatus?: number;
};

/**
 * Maps Douyin download errors, including captcha challenges and identity rejections,
 * to actionable user guidance.
 */
export function classifyDouyinChallenge(stderr: string): DownloadIssueFact | undefined {
  const text = stderr.toLowerCase();
  const douyin = /\[douyin(?:\+[^\]]+)?\]/.test(text) || text.includes('douyin');
  if (!douyin) return undefined;

  const statusMatch = /http error\s+(\d{3})\b/i.exec(stderr);
  const httpStatus = statusMatch ? Number(statusMatch[1]) : 403;

  if (text.includes('douyin request signature is required')) {
    return {
      code: 'platform_request_signature_required',
      message: 'Douyin rejected the downloader because its required browser request signature is not supported. Reconnecting cookies alone cannot fix this; use a local video file.',
      kind: 'unsupported',
      httpStatus: 403,
    };
  }

  if (text.includes('website verification') || text.includes('validate error') || text.includes('captcha') || text.includes('slider')) {
    return {
      code: 'platform_session_required',
      message: 'Douyin requires website verification (anti-bot captcha). Open Douyin in Settings > Platform connections to complete verification (no sign-in required), and retry.',
      kind: 'unauthorized',
      httpStatus,
    };
  }

  if (text.includes('fresh cookies') || text.includes('douyin browser identity was rejected')) {
    return {
      code: 'platform_session_required',
      message: 'Douyin did not accept the browser session or requires website verification. Reconnect Douyin in Settings > Platform connections and retry; signing in is not necessarily required.',
      kind: 'unauthorized',
      httpStatus: statusMatch ? Number(statusMatch[1]) : undefined,
    };
  }

  return undefined;
}
