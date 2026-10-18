import { z } from 'zod';

/**
 * Công cụ Hồng Quả cho trợ lý AI: tìm kiếm / duyệt bảng xếp hạng / chi tiết phim /
 * danh sách tập / tạo lượt tải / theo dõi hàng đợi tải.
 *
 * Các route nội bộ `/internal/agent-tools/drama/*` chấp quyền bằng capability
 * token và phản chiếu API của thành phần Hồng Quả (proxy qua manager), nên
 * trạng thái "chưa cài thành phần" trả về creator_hongguo_unavailable cho trợ lý.
 */

export type DramaToolName = typeof DRAMA_TOOL_NAMES[number];

export const DRAMA_TOOL_NAMES = [
  'drama_search',
  'drama_browse_rankings',
  'drama_series_detail',
  'drama_series_episodes',
  'drama_download_status',
  'drama_download_episodes'
] as const;

export class DramaToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'DramaToolError';
  }
}

const searchSchema = z.object({
  keyword: z.string().min(1).describe('Tên phim cần tìm, có thể là tiếng Việt hoặc tên gốc'),
  page: z.number().int().min(1).max(100).optional()
}).strict();

const browseSchema = z.object({
  category: z.string().min(1).optional()
    .describe('Slug xếp hạng, ví dụ hot-drama / hot-real-drama / hot-comic-drama / hot-ai-drama; bỏ trống dùng mặc định'),
  page: z.number().int().min(1).max(100).optional()
}).strict();

const seriesSchema = z.object({
  seriesId: z.string().min(1).optional()
    .describe('series_id trả về từ drama_search / drama_browse_rankings')
}).strict();

const episodesSchema = z.object({
  seriesId: z.string().min(1)
    .describe('series_id trả về từ drama_search / drama_browse_rankings')
}).strict();

const downloadStatusSchema = z.object({}).strict();

const downloadEpisodeSchema = z.object({
  vid: z.string().min(1).describe('id tập trả về trong danh sách tập (video id)'),
  index: z.number().int().min(1).describe('vid_index của tập (số thứ tự bắt đầu từ 1)'),
  title: z.string().min(1).optional()
}).strict();

const downloadSchema = z.object({
  seriesId: z.string().min(1).describe('series_id của phim'),
  seriesTitle: z.string().min(1).optional(),
  episodes: z.array(downloadEpisodeSchema).min(1).max(100)
    .describe('Chọn nguyên xi từ danh sách trả về của drama_series_episodes — mỗi dự án { vid, index }'),
  quality: z.string().min(1).optional()
}).strict();

export function createDramaToolDefinitions(input: {
  request(request: {
    method: 'GET' | 'POST';
    path: string;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  }): Promise<unknown>;
}) {
  return {
    drama_search: {
      description: [
        'Tìm kiếm phim trong thư viện Hồng Quả (trang tải video của OpenCreator) theo tên hoặc từ khóa.',
        'Kết quả kèm tiêu đề gốc và tiêu đề dịch tiếng Việt (nếu có bản dịch). Khi người dùng yêu cầu',
        'tìm/tải phim, luôn bắt đầu bằng công cụ này; không được đoán tên khóa hoặc dùng web search thay thế.'
      ].join(' '),
      inputSchema: searchSchema,
      execute: async (value: unknown) => {
        const parsed = searchSchema.parse(value);
        return input.request({
          method: 'GET',
          path: '/internal/agent-tools/drama/search',
          query: {
            keyword: parsed.keyword,
            ...(parsed.page === undefined ? {} : { page: String(parsed.page) })
          }
        });
      }
    },
    drama_browse_rankings: {
      description: [
        'Duyệt bảng xếp hạng / gợi ý hot của Hồng Quả. Tab phổ biến: hot-drama (tổng hợp),',
        'hot-real-drama (người thật), hot-comic-drama (hoạt hình), hot-ai-drama (AI).'
      ].join(' '),
      inputSchema: browseSchema,
      execute: async (value: unknown) => {
        const parsed = browseSchema.parse(value);
        return input.request({
          method: 'GET',
          path: '/internal/agent-tools/drama/browse',
          query: {
            ...(parsed.category === undefined ? {} : { category: parsed.category }),
            ...(parsed.page === undefined ? {} : { page: String(parsed.page) })
          }
        });
      }
    },
    drama_series_detail: {
      description: 'Chi tiết một phim Hồng Quả (theo series_id): giới thiệu, tag, số tập — dùng trước khi tải.',
      inputSchema: seriesSchema,
      execute: async (value: unknown) => {
        const parsed = seriesSchema.parse(value);
        if (parsed.seriesId === undefined) {
          throw new DramaToolError('VALIDATION_FAILED', 'drama_series_detail cần seriesId từ kết quả drama_search / drama_browse_rankings');
        }
        return input.request({
          method: 'GET',
          path: '/internal/agent-tools/drama/series',
          query: { seriesId: parsed.seriesId }
        });
      }
    },
    drama_series_episodes: {
      description: [
        'Danh sách tập của một phim Hồng Quả. Mỗi tập có { vid, vid_index, title } — dùng chính các',
        'giá trị này làm đối số cho drama_download_episodes.'
      ].join(' '),
      inputSchema: episodesSchema,
      execute: async (value: unknown) => {
        const parsed = episodesSchema.parse(value);
        return input.request({
          method: 'GET',
          path: '/internal/agent-tools/drama/series-episodes',
          query: { seriesId: parsed.seriesId }
        });
      }
    },
    drama_download_status: {
      description: 'Xem hàng đợi tải video của phần mềm: từng tập đang tải / đã xong / lỗi, kèm đường dẫn lưu.',
      inputSchema: downloadStatusSchema,
      execute: async () => input.request({
        method: 'GET',
        path: '/internal/agent-tools/drama/tasks'
      })
    },
    drama_download_episodes: {
      description: [
        'Tạo lượt tải các tập phim Hồng Quả về máy. Trả về số tập đã xếp vào hàng đợi tải;',
        'theo dõi tiến độ bằng drama_download_status. Nếu người dùng chưa chỉ rõ tập nào thì hỏi trước.'
      ].join(' '),
      inputSchema: downloadSchema,
      execute: async (value: unknown) => {
        const parsed = downloadSchema.parse(value);
        return input.request({
          method: 'POST',
          path: '/internal/agent-tools/drama/download-batch',
          body: {
            seriesId: parsed.seriesId,
            ...(parsed.seriesTitle === undefined ? {} : { seriesTitle: parsed.seriesTitle }),
            episodes: parsed.episodes.map(episode => ({
              vid: episode.vid,
              vid_index: episode.index,
              ...(episode.title === undefined ? {} : { title: episode.title })
            })),
            ...(parsed.quality === undefined ? {} : { quality: parsed.quality })
          }
        });
      }
    }
  } as const;
}

export function createDramaToolHttpClient(input: { baseUrl: string; token: string }) {
  return {
    async request(request: {
      method: 'GET' | 'POST';
      path: string;
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    }) {
      const suffix = request.query !== undefined && Object.keys(request.query).length > 0
        ? `?${new URLSearchParams(request.query).toString()}`
        : '';
      const response = await fetch(new URL(`${request.path}${suffix}`, input.baseUrl), {
        method: request.method,
        headers: {
          authorization: `Bearer ${input.token}`,
          ...(request.body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      });
      const payload = await response.json() as unknown;
      if (!response.ok) {
        const message = payload !== null && typeof payload === 'object'
          && 'error' in payload && payload.error !== null && typeof payload.error === 'object'
          && 'message' in payload.error && typeof payload.error.message === 'string'
          ? payload.error.message
          : `Drama tool HTTP ${response.status}`;
        throw new DramaToolError('drama_tool_http_failed', message);
      }
      return payload;
    }
  };
}
