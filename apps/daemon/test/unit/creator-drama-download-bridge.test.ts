import { describe, expect, it } from 'vitest';
import {
  createDramaDownloadBridge,
  extractDownloadedEpisodes,
  isLocalVideoPath
} from '../../src/creator/hongguo/download-bridge.js';

describe('isLocalVideoPath', () => {
  it('nhận đường dẫn video cục bộ', () => {
    expect(isLocalVideoPath('D:\\downloads\\ep1.mp4')).toBe(true);
    expect(isLocalVideoPath('/home/user/ep1.mkv')).toBe(true);
  });

  it('từ chối URL và chuỗi thường', () => {
    expect(isLocalVideoPath('https://cdn.example.com/ep1.mp4')).toBe(false);
    expect(isLocalVideoPath('ep1.mp4')).toBe(false);
    expect(isLocalVideoPath('')).toBe(false);
  });
});

describe('extractDownloadedEpisodes', () => {
  it('lấy tập đã tải xong kèm tiêu đề và chỉ số tập', () => {
    const episodes = extractDownloadedEpisodes({
      tasks: [
        {
          status: 'completed',
          path: 'D:\\downloads\\ep1.mp4',
          title: 'Tập 1',
          episodeIndex: 1,
          seriesId: 'series-1'
        },
        { status: 'downloading', path: 'D:\\downloads\\ep2.mp4' }
      ]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.path).toBe('D:\\downloads\\ep1.mp4');
    expect(episodes[0]?.title).toBe('Tập 1');
    expect(episodes[0]?.episodeIndex).toBe(1);
    expect(episodes[0]?.seriesKey).toBe('honggua:series-1');
  });

  it('suy key bộ từ object lồng nhau (hongguoInfo.series_id)', () => {
    const episodes = extractDownloadedEpisodes({
      tasks: [{
        status: 'completed',
        path: 'D:\\dl\\《天赋万古无双，只手横推三千帝》T?p 084.mp4',
        title: '《天赋万古无双，只手横推三千帝》T?p 084',
        hongguoInfo: { series_id: 'a4d414f2', episode_no: 84 }
      }]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.seriesKey).toBe('honggua:a4d414f2');
  });

  it('suy key bộ từ thẻ 《tên phim》 trong tiêu đề khi không có series_id', () => {
    const episodes = extractDownloadedEpisodes({
      tasks: [{
        status: 'completed',
        path: 'D:\\dl\\《京夜读温》T?p 001.mp4',
        title: '《京夜读温》T?p 001'
      }]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.seriesKey).toBe('title:京夜读温');
  });

  it('fallback cuối: thư mục cha chứa file (bỏ hậu tố hash)', () => {
    const episodes = extractDownloadedEpisodes({
      tasks: [{
        status: 'completed',
        path: 'D:\\Phim Hồng Quả\\Phim hot nhat 2026-a4d414f2356f\\Tap 010.mp4',
        title: 'Tap 010'
      }]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.seriesKey).toBe('folder:Phim hot nhat 2026');
  });

  it('phim lẻ ngoài thư mục tải Hồng Quả (không hash, không 《》) giữ nhóm lẻ', () => {
    const episodes = extractDownloadedEpisodes({
      tasks: [{ status: 'completed', path: 'D:\\download\\clip-x.mp4', title: 'video của tôi' }]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.seriesKey).toBeUndefined();
  });

  it('quét được đường dẫn nằm trong field lạ', () => {
    const episodes = extractDownloadedEpisodes({
      items: [{ state: 'done', result: { output: { localPath: 'C:\\dl\\ep7.mp4' } } }]
    });
    expect(episodes).toHaveLength(1);
    expect(episodes[0]?.path).toBe('C:\\dl\\ep7.mp4');
  });

  it('bỏ qua task chưa xong', () => {
    expect(extractDownloadedEpisodes({ tasks: [{ status: 'running', path: 'D:\\a.mp4' }] })).toHaveLength(0);
  });
});

describe('createDramaDownloadBridge', () => {
  it('nạp mỗi tập đúng 1 lần vào pipeline dịch', async () => {
    const enqueued: unknown[] = [];
    let payload: unknown = { tasks: [{ status: 'completed', path: 'D:\\dl\\ep1.mp4', title: 'Tập 1' }] };
    const bridge = createDramaDownloadBridge({
      listTasks: async () => payload,
      enqueue: (requests) => { enqueued.push(...requests); }
    });
    await bridge.tick();
    await bridge.tick();
    expect(enqueued).toHaveLength(1);
    payload = {
      tasks: [
        { status: 'completed', path: 'D:\\dl\\ep1.mp4', title: 'Tập 1' },
        { status: 'completed', path: 'D:\\dl\\ep2.mp4', title: 'Tập 2' }
      ]
    };
    await bridge.tick();
    expect(enqueued).toHaveLength(2);
  });

  it('cấu hình batchMode cho các tập có seriesKey (dịch cả bộ, không nạp tung tập)', async () => {
    const enqueued: unknown[] = [];
    const payload = {
      tasks: [
        {
          status: 'completed',
          path: 'D:\\dl\\《phim mới》T?p 001.mp4',
          title: '《phim mới》T?p 001'
        },
        { status: 'completed', path: 'D:\\dl\\video lẻ.mp4', title: 'video lẻ' }
      ]
    };
    const bridge = createDramaDownloadBridge({
      listTasks: async () => payload,
      enqueue: (requests) => { enqueued.push(...requests); }
    });
    await bridge.tick();
    expect(enqueued[0]).toMatchObject({ seriesKey: 'title:phim mới', batchMode: true });
    expect(enqueued[1]).not.toHaveProperty('batchMode');
    expect(enqueued[1]).not.toHaveProperty('seriesKey');
  });

  it('không ném lỗi khi thành phần Hồng Quá chưa sẵn sàng', async () => {
    const bridge = createDramaDownloadBridge({
      listTasks: async () => { throw new Error('chưa cài'); },
      enqueue: () => undefined
    });
    await expect(bridge.tick()).resolves.toBe(0);
  });
});
