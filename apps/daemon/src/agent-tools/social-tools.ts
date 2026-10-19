import { z } from 'zod';

/**
 * Công cụ Mạng Lưới Đăng Đa Kênh cho trợ lý AI: xem tổng quan/điều khiển cụm
 * kênh, nạp video vào hàng đợi hẹn giờ đa nền tảng (YouTube/TikTok/Facebook).
 *
 * Route nội bộ `/internal/agent-tools/social/*` chấp quyền bằng capability
 * token — scope `social:read` chỉ đọc, `social:manage` cho phép thay đổi
 * (mặc định hàng đợi chạy tự động theo khung giờ của cụm).
 */

export type SocialToolName = typeof SOCIAL_TOOL_NAMES[number];

export const SOCIAL_TOOL_NAMES = [
  'social_overview',
  'social_create_cluster',
  'social_update_cluster',
  'social_delete_cluster',
  'social_check_proxy',
  'social_open_browser',
  'social_open_login',
  'social_close_browser',
  'social_enqueue_videos',
  'social_remove_job',
  'social_reschedule_job',
  'social_retry_failed',
  'social_pause_queue',
  'social_resume_queue',
  'social_stats',
  'social_list_comments',
  'social_scan_comments'
] as const;

export class SocialToolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'SocialToolError';
  }
}

const overviewSchema = z.object({}).strict();

const createClusterSchema = z.object({
  name: z.string().min(1).describe('Tên cụm kênh (nội dung/sê-ri)'),
  seriesName: z.string().min(1).optional(),
  proxyServer: z.string().min(1).optional()
    .describe('Proxy tĩnh cụm, dạng http://host:port hoặc http://user:pass@host:port'),
  fbMode: z.enum(['graph_api', 'browser']).optional()
    .describe('Cách đăng Facebook: graph_api (Page Access Token) hoặc browser (Business Suite)')
}).strict();

const updateClusterSchema = z.object({
  clusterId: z.string().min(1).describe('id cụm từ social_overview'),
  name: z.string().min(1).optional(),
  seriesName: z.string().min(1).optional(),
  proxyServer: z.string().min(1).optional(),
  fbMode: z.enum(['graph_api', 'browser']).optional(),
  fbPageId: z.string().min(1).optional(),
  fbPageToken: z.string().min(1).optional()
    .describe('Page Access Token riêng của Page — lưu mã hóa trên máy, không trả về dưới dạng thô'),
  defaultScheduleTimes: z.array(z.string().regex(/^\d{1,2}:\d{2}$/)).min(1).max(12).optional()
    .describe('Khung giờ vàng mỗi ngày (giờ cục bộ), ví dụ ["19:30", "07:00"]'),
  defaultDescription: z.string().min(1).optional(),
  ytChannelUrl: z.string().min(1).optional()
    .describe('URL kênh YouTube của cụm — dùng để quét số người đăng ký (thống kê)'),
  tkProfileUrl: z.string().min(1).optional()
    .describe('URL profile TikTok của cụm — dùng để quét follower/thả tim'),
  autoReplyEnabled: z.boolean().optional()
    .describe('Bật tự động trả lời bình luận bằng AI (cap 25 reply/ngày/cụm)'),
  autoReplyPrompt: z.string().min(1).optional()
    .describe('Chỉ dẫn riêng cho AI khi soạn câu trả lời bình luận'),
  autoPublishAfterTranslate: z.boolean().optional()
    .describe('GĐ4: bật tự nạp đăng sau khi dịch xong — khi pipeline dịch xong 1 tập, video được tự xếp vào hàng đợi của cụm theo khung giờ vàng')
}).strict();

const clusterIdSchema = z.object({
  clusterId: z.string().min(1).describe('id cụm từ social_overview')
}).strict();

const platformSettingsSchema = z.object({
  youtube: z.object({
    privacy: z.enum(['public', 'unlisted', 'private']).optional()
      .describe('Quyền xem YouTube: public (công khai), unlisted (không công khai), private (riêng tư)'),
    tags: z.array(z.string().min(1)).max(30).optional()
      .describe('Thẻ (tags) YouTube — tổng độ dài tối đa ~500 ký tự, vượt sẽ bị cắt'),
    madeForKids: z.boolean().optional()
      .describe('Đánh dấu video "Dành cho trẻ em" (mặc định: không dành cho trẻ em)')
  }).strict().optional(),
  tiktok: z.object({
    privacy: z.enum(['public', 'friends', 'private']).optional()
      .describe('Ai có thể xem trên TikTok: public (mọi người), friends (bạn bè), private (riêng tư)'),
    allowDuet: z.boolean().optional(),
    allowStitch: z.boolean().optional(),
    allowComments: z.boolean().optional(),
    directPost: z.boolean().optional()
  }).strict().optional(),
  facebook: z.object({
    postType: z.enum(['post', 'reel', 'story']).optional()
      .describe('Loại bài Facebook (chế độ browser; story/reel tùy hỗ trợ)')
  }).strict().optional()
}).strict();

const enqueueSchema = z.object({
  clusterId: z.string().min(1).describe('id cụm sẽ đăng'),
  videos: z.array(z.object({
    path: z.string().min(1).describe('Đường dẫn tuyệt đối tới file video MP4 hoàn chỉnh'),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    thumbnailPath: z.string().min(1).optional(),
    scheduledAt: z.string().min(10).optional()
      .describe('ISO hẹn ngày giờ công khai; bỏ trống để tự xếp khung giờ trống tiếp theo của cụm'),
    platformSettings: platformSettingsSchema.optional()
      .describe('Cấu hình riêng từng nền tảng cho video này (privacy/tags/toggles)')
  })).min(1).max(60)
    .describe('Danh sách cần xếp hàng đợi — file video như vậy phải tồn tại trên đĩa')
}).strict();

const jobIdSchema = z.object({
  jobId: z.string().min(1).describe('id job trong hàng đợi (từ social_overview)')
}).strict();

const loginSchema = z.object({
  clusterId: z.string().min(1).describe('id cụm từ social_overview'),
  platform: z.enum(['youtube', 'tiktok', 'facebook'])
    .describe('Nền tảng cần mở trang đăng nhập')
}).strict();

const rescheduleSchema = z.object({
  jobId: z.string().min(1).describe('id job trong hàng đợi (từ social_overview)'),
  scheduledAt: z.string().min(10)
    .describe('ISO mới cho ngày giờ công khai — chỉ áp dụng với job chưa đăng/chưa hẹn trên nền tảng')
}).strict();

export function createSocialToolDefinitions(input: {
  request(request: {
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
    path: string;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  }): Promise<unknown>;
}) {
  return {
    social_overview: {
      description: [
        'Xem tổng quan Mạng Lưới Đăng Đa Kênh: trạng thái hàng đợi, số liệu, danh sách cụm kênh',
        '(id, proxy, trạng thái đăng nhập, khung giờ vàng) và danh sách video đã xếp hẹn kèm trạng',
        'thái từng nền tảng. Luôn gọi trước khi thao tác để lấy id mới nhất.'
      ].join(' '),
      inputSchema: overviewSchema,
      execute: async () => input.request({ method: 'GET', path: '/internal/agent-tools/social/overview' })
    },
    social_create_cluster: {
      description: 'Tạo cụm kênh mới (proxy tĩnh + khung giờ vàng mặc định). Dashboard sẽ hướng dẫn người dùng đăng nhập từng nền tảng.',
      inputSchema: createClusterSchema,
      execute: async (value: unknown) => {
        const parsed = createClusterSchema.parse(value);
        return input.request({
          method: 'POST',
          path: '/internal/agent-tools/social/clusters',
          body: {
            name: parsed.name,
            ...(parsed.seriesName === undefined ? {} : { seriesName: parsed.seriesName }),
            ...(parsed.proxyServer === undefined ? {} : { proxyServer: parsed.proxyServer }),
            ...(parsed.fbMode === undefined ? {} : { fbMode: parsed.fbMode })
          }
        });
      }
    },
    social_update_cluster: {
      description: 'Cập nhật cấu hình cụm: tên, proxy, Facebook (pageId/pageToken/mode), khung giờ vàng, mô tả mặc định.',
      inputSchema: updateClusterSchema,
      execute: async (value: unknown) => {
        const parsed = updateClusterSchema.parse(value);
        return input.request({
          method: 'PATCH',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}`,
          body: {
            ...(parsed.name === undefined ? {} : { name: parsed.name }),
            ...(parsed.seriesName === undefined ? {} : { seriesName: parsed.seriesName }),
            ...(parsed.proxyServer === undefined ? {} : { proxyServer: parsed.proxyServer }),
            ...(parsed.fbMode === undefined ? {} : { fbMode: parsed.fbMode }),
            ...(parsed.fbPageId === undefined ? {} : { fbPageId: parsed.fbPageId }),
            ...(parsed.fbPageToken === undefined ? {} : { fbPageToken: parsed.fbPageToken }),
            ...(parsed.defaultScheduleTimes === undefined ? {} : { defaultScheduleTimes: parsed.defaultScheduleTimes }),
            ...(parsed.defaultDescription === undefined ? {} : { defaultDescription: parsed.defaultDescription }),
            ...(parsed.ytChannelUrl === undefined ? {} : { ytChannelUrl: parsed.ytChannelUrl }),
            ...(parsed.tkProfileUrl === undefined ? {} : { tkProfileUrl: parsed.tkProfileUrl }),
            ...(parsed.autoReplyEnabled === undefined ? {} : { autoReplyEnabled: parsed.autoReplyEnabled }),
            ...(parsed.autoReplyPrompt === undefined ? {} : { autoReplyPrompt: parsed.autoReplyPrompt }),
            ...(parsed.autoPublishAfterTranslate === undefined ? {} : { autoPublishAfterTranslate: parsed.autoPublishAfterTranslate })
          } as Record<string, unknown>
        });
      }
    },
    social_delete_cluster: {
      description: 'Xóa vĩnh viễn một cụm và toàn bộ video chờ đăng của cụm. Cần người dùng xác nhận rõ ràng trước khi gọi.',
      inputSchema: clusterIdSchema,
      execute: async (value: unknown) => {
        const parsed = clusterIdSchema.parse(value);
        return input.request({
          method: 'DELETE',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}`
        });
      }
    },
    social_check_proxy: {
      description: 'Kiểm tra proxy của cụm còn sống không; trả về trạng thái + thời gian phản hồi.',
      inputSchema: clusterIdSchema,
      execute: async (value: unknown) => {
        const parsed = clusterIdSchema.parse(value);
        return input.request({
          method: 'POST',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}/check-proxy`
        });
      }
    },
    social_open_browser: {
      description: [
        'Mở cửa sổ Chrome đã vá (tàn nhẫn chống phát hiện) của cụm để người dùng đăng nhập/quản lý tay',
        'YouTube, TikTok, Facebook Business Suite. Cụm chưa đăng nhập nên gọi trước khi xếp hàng đợi.'
      ].join(' '),
      inputSchema: clusterIdSchema,
      execute: async (value: unknown) => {
        const parsed = clusterIdSchema.parse(value);
        return input.request({
          method: 'POST',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}/open-browser`
        });
      }
    },
    social_open_login: {
      description: [
        'Mở trang đăng nhập của một nền tảng (youtube | tiktok | facebook) trong trình duyệt persistent của cụm.',
        'Không điền thông tin đăng nhập — người dùng tự đăng nhập tay, cookie phiên được giữ lại trong profile cụm.'
      ].join(' '),
      inputSchema: loginSchema,
      execute: async (value: unknown) => {
        const parsed = loginSchema.parse(value);
        return input.request({
          method: 'POST',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}/login/${parsed.platform}`
        });
      }
    },
    social_close_browser: {
      description: 'Đóng cửa sổ trình duyệt của cụm (cookie phiên vẫn giữ trong profile riêng).',
      inputSchema: clusterIdSchema,
      execute: async (value: unknown) => {
        const parsed = clusterIdSchema.parse(value);
        return input.request({
          method: 'POST',
          path: `/internal/agent-tools/social/clusters/${encodeURIComponent(parsed.clusterId)}/close-browser`
        });
      }
    },
    social_enqueue_videos: {
      description: [
        'Xếp video vào hàng đợi đăng đa kênh của cụm (YouTube Studio, TikTok Studio, Facebook).',
        'Không chỉ định scheduledAt → hệ thống tự xếp khung giờ trống tiếp theo theo khung giờ vàng của cụm.',
        'Chỉ dùng cho file video có thật trên đĩa; sau khi xếp hãy đọc social_overview để báo tiến độ.'
      ].join(' '),
      inputSchema: enqueueSchema,
      execute: async (value: unknown) => {
        const parsed = enqueueSchema.parse(value);
        return input.request({
          method: 'POST',
          path: '/internal/agent-tools/social/jobs',
          body: {
            items: parsed.videos.map(video => ({
              clusterId: parsed.clusterId,
              path: video.path,
              ...(video.title === undefined ? {} : { title: video.title }),
              ...(video.description === undefined ? {} : { description: video.description }),
              ...(video.thumbnailPath === undefined ? {} : { thumbnailPath: video.thumbnailPath }),
              ...(video.scheduledAt === undefined ? {} : { scheduledAt: video.scheduledAt }),
              ...(video.platformSettings === undefined ? {} : { platformSettings: video.platformSettings })
            }))
          } as Record<string, unknown>
        });
      }
    },
    social_remove_job: {
      description: 'Gỡ một video khỏi hàng đợi (nếu chưa đang chạy).',
      inputSchema: jobIdSchema,
      execute: async (value: unknown) => {
        const parsed = jobIdSchema.parse(value);
        return input.request({
          method: 'DELETE',
          path: `/internal/agent-tools/social/jobs/${encodeURIComponent(parsed.jobId)}`
        });
      }
    },
    social_reschedule_job: {
      description: [
        'Đổi giờ công khai của một video đã xếp hẹn (PATCH /social/jobs/:id).',
        'Chỉ áp dụng cho job chưa đăng/chưa hẹn giờ trên nền tảng nào; xong hệ thống tự xếp lại lịch chạy.'
      ].join(' '),
      inputSchema: rescheduleSchema,
      execute: async (value: unknown) => {
        const parsed = rescheduleSchema.parse(value);
        return input.request({
          method: 'PATCH',
          path: `/internal/agent-tools/social/jobs/${encodeURIComponent(parsed.jobId)}`,
          body: { scheduledAt: parsed.scheduledAt }
        });
      }
    },
    social_retry_failed: {
      description: 'Chạy lại các nền tảng đăng thất bại của một video (đếm lại số lần thử).',
      inputSchema: jobIdSchema,
      execute: async (value: unknown) => {
        const parsed = jobIdSchema.parse(value);
        return input.request({
          method: 'POST',
          path: `/internal/agent-tools/social/jobs/${encodeURIComponent(parsed.jobId)}/retry-failed`
        });
      }
    },
    social_pause_queue: {
      description: 'Tạm dừng hàng đợi (không xếp mới, các phiên đang chạy vẫn được hoàn tất).',
      inputSchema: overviewSchema,
      execute: async () => input.request({ method: 'POST', path: '/internal/agent-tools/social/queue/pause' })
    },
    social_resume_queue: {
      description: 'Chạy lại hàng đợi sau khi tạm dừng.',
      inputSchema: overviewSchema,
      execute: async () => input.request({ method: 'POST', path: '/internal/agent-tools/social/queue/resume' })
    },
    social_stats: {
      description: [
        'Xem thống kê đa kênh (GĐ3): followers/người đăng ký từng nền tảng theo cụm kèm chênh lệch so lần trước,',
        'lượt view từng video đã đăng và thời gian quét gần nhất. Dùng khi người dùng hỏi "kênh đang có bao nhiêu sub/view".'
      ].join(' '),
      inputSchema: overviewSchema,
      execute: async () => input.request({ method: 'GET', path: '/internal/agent-tools/social/stats' })
    },
    social_list_comments: {
      description: [
        'Xem bình luận mới nhất thu được từ các video đã đăng (đặt alongside trạng thái tự trả lời).',
        'Hỏi clusterId để lọc theo một cụm; bỏ trống để xem tất cả.'
      ].join(' '),
      inputSchema: z.object({
        clusterId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional()
      }).strict(),
      execute: async (value: unknown) => {
        const parsed = z.object({
          clusterId: z.string().min(1).optional(),
          limit: z.number().int().min(1).max(200).optional()
        }).strict().parse(value);
        return input.request({
          method: 'GET',
          path: '/internal/agent-tools/social/comments',
          query: {
            ...(parsed.clusterId === undefined ? {} : { clusterId: parsed.clusterId }),
            ...(parsed.limit === undefined ? {} : { limit: String(parsed.limit) })
          }
        });
      }
    },
    social_scan_comments: {
      description: [
        'Quét bình luận ngay (Facebook qua Graph API, YouTube qua trình duyệt cụm) và để AI tự trả lời',
        'các cụm đã bật "auto-reply". Không bật auto-reply → chỉ thu thập, chờ người dùng trả lời.'
      ].join(' '),
      inputSchema: z.object({
        clusterId: z.string().min(1).optional().describe('Chỉ quét một cụm; bỏ trống để quét tất cả')
      }).strict(),
      execute: async (value: unknown) => {
        const parsed = z.object({ clusterId: z.string().min(1).optional() }).strict().parse(value);
        return input.request({
          method: 'POST',
          path: '/internal/agent-tools/social/comments/scan',
          body: parsed.clusterId === undefined ? {} : { clusterId: parsed.clusterId }
        });
      }
    }
  } as const;
}

export function createSocialToolHttpClient(input: { baseUrl: string; token: string }) {
  return {
    async request(request: {
      method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
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
          : `Social tool HTTP ${response.status}`;
        throw new SocialToolError('social_tool_http_failed', message);
      }
      return payload;
    }
  };
}
