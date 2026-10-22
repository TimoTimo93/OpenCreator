/**
 * Cầu nối: video tải từ Hồng Quá ⇒ tự nối vào hàng đợi "Dịch video".
 *
 * Thành phần Hồng Quá tải phim về máy và báo trạng thái qua
 * `GET /api/v1/download-tasks`. Mỗi task hoàn tất có đường dẫn file cục bội ⇒
 * bridge đưa file đó vào pipeline dịch (dịch xong pipeline tự nạp video vào
 * hàng đợi đăng của các cụm đang bật "Tự nạp đăng sau khi dịch xong").
 *
 * Bộ tách đường dẫn viết theo kiểu "shape-agnostic" (quét mọi trường chuỗi
 * trong task) vì thành phần Hồng Quá có thể đổi tên trường giữa các bản.
 */
import type { PipelineEnqueueRequest } from '../translation-pipeline/pipeline.js';

export type DramaDownloadedEpisode = {
  path: string;
  title: string;
  episodeIndex?: number;
  seriesKey?: string;
};

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.mov', '.webm', '.avi', '.flv', '.m4v', '.ts'];

/** Kiểm tra chuỗi có phải đường dẫn file video cục bội không. */
export function isLocalVideoPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === '') return false;
  const lower = trimmed.toLowerCase();
  if (!VIDEO_EXTENSIONS.some(extension => lower.endsWith(extension))) return false;
  // Phải là đường dẫn tuyệt đối trên máy (dạng C:\... hoặc /...).
  return /^[a-z]:[\\/]/i.test(trimmed) || trimmed.startsWith('/');
}

function collectStrings(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6) return out;
  if (typeof value === 'string') {
    out.push(value);
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, depth + 1, out);
    return out;
  }
  if (typeof value === 'object' && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, depth + 1, out);
    }
  }
  return out;
}

function readString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * Tìm key bộ phim trong object lồng nhau (kiểu `hongguoInfo.series_id` của task
 * tải Hồng Quả) — đọc theo tầng: key riêng của object trước, rồi con (DFS).
 */
function findNestedSeriesKey(value: unknown, depth = 0): string | undefined {
  if (depth > 6 || Array.isArray(value) || typeof value !== 'object' || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const seriesId = readString(record, ['seriesId', 'series_id']);
  if (seriesId !== '') return `honggua:${seriesId}`;
  const seriesTitle = readString(record, ['seriesTitle', 'series_title']);
  if (seriesTitle !== '') return `title:${seriesNameFromTitle(seriesTitle)}`;
  for (const child of Object.values(record)) {
    if (typeof child !== 'object' || child === null) continue;
    const found = findNestedSeriesKey(child, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** Rút tên bộ phim từ tiêu đề: thẻ `《tên phim》` nếu có, không → chuỗi nguyên. */
function seriesNameFromTitle(source: string): string {
  const match = source.match(/《(.+?)》/);
  return (match?.[1] ?? source).trim();
}

/** Giá trị seriesKey phẳng: đã có tiền tố trải dùng nguyên, còn lại coi là id Hồng Quả. */
function normalizeSeriesKey(value: string): string {
  const trimmed = value.trim();
  return /^(honggua|title|folder|solo):/.test(trimmed) ? trimmed : `honggua:${trimmed}`;
}

/** Fallback cuối: thư mục cha tải của Hồng Quả `<tên bộ>-<hash>` — chỉ nhận khi
 * tên thư mục có hậu tố hash để không ghép nhầm các video lẻ cùng một thư mục. */
function seriesKeyFromFolder(path: string): string | undefined {
  const segments = path.split(/[\\/]/).filter(segment => segment !== '');
  const folder = segments.at(-2);
  if (folder === undefined) return undefined;
  const match = folder.match(/^(.+)-[0-9a-f]{6,}$/i);
  if (match === null || match[1] === undefined) return undefined;
  const cleaned = match[1].trim();
  return cleaned === '' ? undefined : `folder:${cleaned}`;
}

/**
 * Suy key bộ phim cho một task tải xong: key phẳng có sẵn → object lồng nhau
 * (`hongguoInfo`) → thẻ `《tên phim》` trong tiêu đề → thư mục cha của file.
 * Không suy ra được ⇒ undefined (video lẻ, giữ hành vi cũ).
 */
function detectSeriesKey(
  record: Record<string, unknown>,
  title: string,
  path: string
): string | undefined {
  const flat = readString(record, ['seriesKey', 'series_key', 'seriesId', 'series_id', 'series']);
  if (flat !== '') return normalizeSeriesKey(flat);
  const nested = findNestedSeriesKey(record);
  if (nested !== undefined) return nested;
  const fromTitle = seriesNameFromTitle(title);
  if (fromTitle !== '' && title.includes('《')) return `title:${fromTitle}`;
  return seriesKeyFromFolder(path);
}

function readNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) return Number(value.trim());
  }
  return undefined;
}

/**
 * Rút danh sách tập đã tải xong từ payload của `download-tasks`.
 * Chỉ nhận task có trạng thái "hoàn tất" (completed/done/success/finished).
 */
export function extractDownloadedEpisodes(payload: unknown): DramaDownloadedEpisode[] {
  const records: Record<string, unknown>[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 5) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'object' && value !== null) {
      records.push(value as Record<string, unknown>);
      for (const item of Object.values(value as Record<string, unknown>)) visit(item, depth + 1);
    }
  };
  visit(payload);

  const episodes: DramaDownloadedEpisode[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    const status = readString(record, ['status', 'state', 'phase', 'result']).toLowerCase();
    if (status !== '' && !/^(completed|complete|done|success|succeeded|finished|ok)$/.test(status)) continue;
    const explicitPath = readString(record, [
      'path', 'filePath', 'file_path', 'outputPath', 'output_path', 'localPath',
      'local_path', 'videoPath', 'video_path', 'downloadedPath', 'savedPath', 'target'
    ]);
    // Bản ghi không có trạng thái lẫn không có đường dẫn ⇒ không phải task
    // (thường là object chứa danh sách) ⇒ bỏ qua để không nuôi nhầm tập.
    if (status === '' && explicitPath === '') continue;
    const candidates = explicitPath !== ''
      ? [explicitPath]
      : collectStrings(record).filter(isLocalVideoPath);
    for (const candidate of candidates) {
      const path = candidate.trim();
      if (!isLocalVideoPath(path) || seen.has(path)) continue;
      seen.add(path);
      const title = readString(record, ['title', 'name', 'episodeTitle', 'episode_title']) !== ''
        ? readString(record, ['title', 'name', 'episodeTitle', 'episode_title'])
        : path.split(/[\\/]/).pop() ?? path;
      const episodeIndex = readNumber(record, ['episodeIndex', 'episode_index', 'index', 'no', 'number']);
      // seriesKey tự suy (object lồng nhau / tiêu đề 《...》/ thư mục cha) để các
      // tập của CÙNG MỘT bộ vào chung nhóm dịch "dịch cả bộ", không lẫn phim khác.
      const seriesKey = detectSeriesKey(record, title, path);
      episodes.push({
        path,
        title,
        ...(episodeIndex === undefined ? {} : { episodeIndex }),
        ...(seriesKey === undefined ? {} : { seriesKey })
      });
    }
  }
  return episodes;
}

export type DramaDownloadBridgeDeps = {
  /** Lấy payload download-tasks (qua thành phần Hồng Quá). */
  listTasks: () => Promise<unknown>;
  /** Nạp tập vào pipeline dịch. */
  enqueue: (requests: readonly PipelineEnqueueRequest[]) => unknown;
  /** Ghi log. */
  log?: (message: string) => void;
  /** Chu kỳ thăm dò (ms). */
  pollMs?: number;
};

/**
 * Cầu nối đang chạy: thăm dò task tải, mỗi tập tải xong chỉ nạp 1 lần.
 */
export function createDramaDownloadBridge(deps: DramaDownloadBridgeDeps): {
  start: () => void;
  stop: () => void;
  tick: () => Promise<number>;
} {
  const pollMs = deps.pollMs ?? 15_000;
  const enqueued = new Set<string>();
  let timer: ReturnType<typeof setInterval> | undefined;

  const tick = async (): Promise<number> => {
    let payload: unknown;
    try {
      payload = await deps.listTasks();
    } catch {
      return 0;
    }
    const episodes = extractDownloadedEpisodes(payload);
    const requests: PipelineEnqueueRequest[] = [];
    for (const episode of episodes) {
      if (enqueued.has(episode.path)) continue;
      enqueued.add(episode.path);
      requests.push({
        path: episode.path,
        title: episode.title,
        ...(episode.episodeIndex === undefined ? {} : { episodeIndex: episode.episodeIndex }),
        // Có seriesKey ⇒ vào nhóm "dịch cả bộ": không tự nạp đăng tung tập,
        // dịch xong toàn bộ mới ghép full movie rồi nạp đăng. Video lẻ giữ hành
        // vi cũ (tự nạp đăng từng tập).
        ...(episode.seriesKey === undefined
          ? {}
          : { seriesKey: episode.seriesKey, batchMode: true })
      });
    }
    if (requests.length > 0) {
      try {
        deps.enqueue(requests);
        deps.log?.(`[creator] Hồng Quá: đã nối ${requests.length} tập vào hàng đợi dịch video`);
      } catch (error) {
        deps.log?.(`[creator] Hồng Quá: nối vào hàng đợi dịch thất bại — ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return requests.length;
  };

  return {
    start: () => {
      if (timer !== undefined) return;
      timer = setInterval(() => { void tick(); }, pollMs);
      void tick();
    },
    stop: () => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    },
    tick
  };
}
