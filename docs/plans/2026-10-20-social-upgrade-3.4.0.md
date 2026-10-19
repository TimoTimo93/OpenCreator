# Kế hoạch nâng cấp 3.4.0 — Mạng Lưới Đăng Đa Kênh + Chất lượng Lồng Tiếng

Ngày: 2026-10-20 · Cơ sở: scan toàn repo (ses_eaa175da) · Thực thi: subagent song song, phạm vi file rời rạc

## Mục tiêu
1. Hoàn tất vòng đời: **tải → dịch → (tự) nạp đăng đa kênh**, có công tắc theo cụm.
2. Xóa **lặp giọng đọc (ASR echo)** trong bản lồng tiếng — dedupe TRƯỚC khi lập plan TTS.
3. **Project theo tên phim**: PATCH tên → đổi cả thư mục trên đĩa; batch dịch đặt tên phim → project riêng, full-movie + Exports thuộc project đó.
4. **TikTok: quét bình luận; YouTube/TikTok: đăng reply qua DOM** (best-effort, khi cụm bật auto-reply).
5. (Wave B) **Biểu đồ xu hướng** followers/views từ lịch sử social_stats + hoàn thiện tích hợp.

## Phân công & quyền sở hữu file (không chồng lấn)

| Agent | Phạm vi sở hữu | Việc chính |
|---|---|---|
| A1 — Vòng đời tự nạp đăng | `translation-pipeline/pipeline.ts`, `apps/daemon/src/notifications/**`, `social/service.ts`, `social/db.ts`, `social/types.ts`, `routes.social.ts`, `internal-routes.ts`(social), `social-tools.ts`, `mcp-routes.ts`, `server.ts`(wiring), `SocialWorkspace.tsx`, `social-service.ts`, i18n anchor social | Cột `auto_publish_after_translate` + toggle UI; hook sau từng tập completed → nạp job đăng (lazy socialService); item pipeline nhận `projectId` optional; notification generic cho dịch xong + đăng social xong/lỗi |
| A2 — Chất lượng lồng tiếng (Go) | `runtime/krillinai/**` | Dedupe echo TRƯỚC Plan cho SỐC TTS (không đụng SRT xuất); chia cue >90 ký tự; rebuild Go; go test |
| A3 — Project theo tên phim | `projects/manager.ts`, `routes.projects.ts`, `routes.translation-batch.ts`, `batch-merge.ts` | PATCH tên → rename thư mục (guard run đang chạy); `ensureProjectByName`; enqueue/merge nhận seriesName → project riêng; summary trả projectId |
| A4 — Bình luận + reply DOM | `social/comments.ts`, `platforms/tiktok.ts`, `platforms/youtube.ts`, `platforms/selectors.json` | TikTok quét bình luận (browser best-effort); postReply YT/TikTok qua DOM (selectors có sẵn), giữ cap + guard; bộ test comments đầu tiên |

## Hợp đồng chéo (A1 ↔ A3)
- `manager.ensureProjectByName(name): { id, folder }` (A3 xuất; A1 dùng).
- Pipeline item: `{ projectId?: string }` — có → dùng project đó thay Default (A1 xử dụng trong pipeline.ts; A3 cấp helper).
- `routes.translation-batch` enqueue nhận `projectId` passthrough + trả `projectId` trong summary (A3).

## Wave B (sau A)
- B1: query lịch sử N điểm (db.ts) + `getStats.history` + sparkline SVG trong `social-insights.tsx` + i18n.
- Sau đó: full test → release 3.4.0 → deploy → push.

## Rủi ro/test khóa cần giữ
- `creator-translation-pipeline.test.ts` (thứ tự stage, merge) — hook thêm, không đổi luồng khi tắt.
- `creator-artifact-publisher.test.ts` (naming Exports) — không đổi layout.
- `project-manager.test.ts`/`project-api.test.ts` — rename dir phải giữ id + atomic; run đang chạy → 409.
- `social-db.test.ts` migration cộng cột trên DB cũ — auto_publish dùng cùng helper.
- Worker pump không đổi (A4 không đụng worker.ts).
