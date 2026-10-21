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
    expect(episodes[0]?.seriesKey).toBe('series-1');
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

  it('không ném lỗi khi thành phần Hồng Quá chưa sẵn sàng', async () => {
    const bridge = createDramaDownloadBridge({
      listTasks: async () => { throw new Error('chưa cài'); },
      enqueue: () => undefined
    });
    await expect(bridge.tick()).resolves.toBe(0);
  });
});
