import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';
import { createNotificationService } from '../../src/notifications/service.js';
import { openRuntimeDatabase } from '../../src/storage/database.js';

let db: Database.Database | undefined;
let dir = '';
afterEach(() => {
  db?.close();
  db = undefined;
  if (dir !== '') rm(dir, { recursive: true, force: true }).catch(() => undefined);
  dir = '';
});

function makeService() {
  dir = mkdtempSync(join(tmpdir(), 'notifications-service-'));
  db = openRuntimeDatabase(join(dir, 'app.sqlite'));
  return createNotificationService({ db });
}

describe('notifications — enqueueGenericEvent', () => {
  it('lưu sự kiện generic vào outbox với kind mới, listPending trả về đủ title/body', () => {
    const service = makeService();
    const item = service.enqueueGenericEvent({
      kind: 'translation_episode_done',
      title: 'Đã dịch xong: Long Hổ Riệu — Tập 3',
      body: 'Video đã dịch xong, sẵn sàng trong hàng đợi đăng đa kênh.',
      dedupeKey: 'translation_episode_done:D:/out/tap-3.mp4'
    });
    expect(item).toBeDefined();
    expect(item!.kind).toBe('translation_episode_done');
    expect(item!.title).toBe('Đã dịch xong: Long Hổ Riệu — Tập 3');
    expect(item!.body).toContain('sẵn sàng');
    const pending = service.listPending({ after: 0, limit: 10 }).notifications;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe('translation_episode_done');
  });

  it('dedupe: cùng dedupeKey nạp 2 lần → chỉ còn 1 thông báo chờ', () => {
    const service = makeService();
    const input = {
      kind: 'social_job_failed' as const,
      title: 'Đăng thất bại: Tập 5',
      body: 'Cụm A · youtube: Studio đổi giao diện',
      dedupeKey: 'social_job_failed:job_1:youtube:1'
    };
    const first = service.enqueueGenericEvent(input);
    const second = service.enqueueGenericEvent(input);
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const pending = service.listPending({ after: 0, limit: 10 }).notifications;
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(first!.id);
  });

  it('đủ 3 kind generic cho pipeline/social', () => {
    const service = makeService();
    service.enqueueGenericEvent({ kind: 'social_job_done', title: 'a', body: 'b', dedupeKey: 'k1' });
    service.enqueueGenericEvent({ kind: 'social_job_failed', title: 'a', body: 'b', dedupeKey: 'k2' });
    service.enqueueGenericEvent({ kind: 'translation_episode_done', title: 'a', body: 'b', dedupeKey: 'k3' });
    expect(service.listPending({ after: 0, limit: 10 }).notifications).toHaveLength(3);
  });

  it('title/body quá dài bị cắt an toàn (giới hạn toast OS)', () => {
    const service = makeService();
    const item = service.enqueueGenericEvent({
      kind: 'translation_episode_done',
      title: 'x'.repeat(300),
      body: 'y'.repeat(500),
      dedupeKey: 'truncate'
    });
    expect(item!.title.length).toBeLessThanOrEqual(80);
    expect(item!.body.length).toBeLessThanOrEqual(120);
  });
});
