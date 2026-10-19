/**
 * Kiểm tra proxy tĩnh: request GET "generate_204" qua proxy (HttpsProxyAgent),
 * đo thời gian phản hồi; chỉ dùng để xác định proxy sống/chết.
 */
import { HttpsProxyAgent } from 'https-proxy-agent';
import { request as httpsRequest } from 'node:https';

export type ProxyCheckResult = {
  status: 'online' | 'dead' | 'no_proxy';
  detail: string | null;
};

const PROBE_URL = 'https://www.gstatic.com/generate_204';

export async function checkProxy(proxyServer: string): Promise<ProxyCheckResult> {
  const trimmed = proxyServer.trim();
  if (trimmed === '') return { status: 'no_proxy', detail: null };
  if (!/^(http|https|socks[45]):\/\//i.test(trimmed)) {
    return { status: 'dead', detail: 'Định dạng proxy không hợp lệ (cần http:// hoặc socks5://host:port)' };
  }
  const started = Date.now();
  try {
    await probeOnce(trimmed);
    return { status: 'online', detail: `${Date.now() - started}ms qua proxy` };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: 'dead', detail: `${Date.now() - started}ms — ${message}` };
  }
}

function probeOnce(proxyServer: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const agent = new HttpsProxyAgent(proxyServer, { timeout: 10_000 });
    const request = httpsRequest(PROBE_URL, {
      method: 'GET',
      agent: agent as never,
      timeout: 10_000
    }, response => {
      // Bất kể mã 204 hay 3xx/4xx từ proxy — phản hồi tức proxy sống.
      response.resume();
      response.on('end', resolvePromise);
      request.destroy();
      resolvePromise();
    });
    request.on('error', rejectPromise);
    request.on('timeout', () => {
      request.destroy(new Error('Quá 10 giây không nhận phản hồi qua proxy'));
    });
    request.end();
  });
}
