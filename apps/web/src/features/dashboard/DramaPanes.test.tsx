import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { HongguoDramaBrowseResponse, HongguoDramaItem } from '@opencreator/protocol';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import { DramaHotPane } from './DramaPanes.js';

/** Mục bảng xếp hạng hợp lệ (mã series 6-30 chữ số, có ảnh bìa để kiểm tra lazy-load). */
function hotItem(offset: number): HongguoDramaItem {
  const seriesId = String(910_000_000 + offset);
  return {
    series_id: seriesId,
    series_title: `Phim ${offset + 1}`,
    cover: `https://img.example.com/${seriesId}.jpg`,
    rank: offset + 1,
    heat: `${10_000 + offset} nhiệt độ`,
    episode_count: 24,
    tags: ['Đô thị']
  };
}

type HotPage = { results: HongguoDramaItem[]; hasMore?: boolean; totalPages?: number };

/** Service giả trả từng trang như API browse của thành phần Hồng Quả. */
function hotService(pages: HotPage[]) {
  const browse = vi.fn((query: { page?: number }) => {
    const page = pages[(query.page ?? 1) - 1];
    if (page === undefined) throw new Error(`unexpected page ${String(query.page)}`);
    const response: HongguoDramaBrowseResponse = {
      success: true,
      results: page.results,
      ...(page.hasMore === undefined ? {} : { hasMore: page.hasMore }),
      ...(page.totalPages === undefined ? {} : { totalPages: page.totalPages })
    };
    return Promise.resolve(response);
  });
  return {
    browse,
    service: {
      getDramaStatus: vi.fn(async () => ({ hongguo: { installed: true, downloadsRoot: 'D:\\hongguo' } })),
      getDramaCategories: vi.fn(async () => ({
        categories: [
          { slug: 'hot-drama', label: 'Bảng xếp hạng hot' },
          { slug: 'hot-real-drama', label: 'Phim ngắn người thật' }
        ]
      })),
      browseDrama: browse,
      translateDramaTitles: vi.fn(async () => ({ translations: {} }))
    }
  };
}

function renderHotPane(service: unknown) {
  return render(
    <LanguageProvider initialPreference="vi-VN">
      <DramaHotPane runtimeDependencies={{ service } as never} />
    </LanguageProvider>
  );
}

const cardCount = (view: { container: HTMLElement }) => view.container.querySelectorAll('.drama-card').length;
const pagerInfo = () => document.querySelector('.drama-pager-info')?.textContent ?? '';

describe('DramaHotPane grid "Tải thêm"', () => {
  it('hiển thị hết video của bảng xếp hạng: mở rộng cửa sổ render trước rồi mới đánh trang API', async () => {
    const page1 = Array.from({ length: 70 }, (_, offset) => hotItem(offset));
    const page2 = Array.from({ length: 30 }, (_, offset) => hotItem(100 + offset));
    const { browse, service } = hotService([
      { results: page1, hasMore: true, totalPages: 2 },
      { results: page2, hasMore: false, totalPages: 2 }
    ]);
    const view = renderHotPane(service);
    try {
      const loadMore = await screen.findByRole('button', { name: 'Tải thêm' });
      await waitFor(() => expect(cardCount(view)).toBe(60));
      await waitFor(() => expect(pagerInfo()).toBe('Đang hiện 60/70+'));
      expect(view.container.querySelector('.drama-card img')?.getAttribute('loading')).toBe('lazy');

      // Lượt 1: còn 10 mục đã tải chưa vẽ -> chỉ mở rộng cửa sổ render, không gọi mạng.
      fireEvent.click(loadMore);
      await waitFor(() => expect(cardCount(view)).toBe(70));
      expect(browse).toHaveBeenCalledTimes(1);

      // Lượt 2: đã hết hàng đã tải -> gọi trang 2 và hiển thị nốt phần còn lại.
      fireEvent.click(screen.getByRole('button', { name: 'Tải thêm' }));
      await waitFor(() => expect(cardCount(view)).toBe(100));
      expect(browse).toHaveBeenCalledTimes(2);
      expect(browse.mock.calls[1]?.[0]).toMatchObject({ category: 'hot-drama', page: 2 });
      await waitFor(() => expect(pagerInfo()).toBe('Đang hiện 100/100'));
      expect(screen.queryByRole('button', { name: 'Tải thêm' })).not.toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });

  it('bảng xếp hạng trả gọn một trang thì hiện đủ sau một lượt "Tải thêm" mà không đánh thêm trang', async () => {
    const results = Array.from({ length: 75 }, (_, offset) => hotItem(offset));
    const { browse, service } = hotService([{ results }]);
    const view = renderHotPane(service);
    try {
      // Đổi sang bảng xếp hạng khác bằng tab: danh sách của tab đó được tải và hiển thị hết.
      fireEvent.click(screen.getByRole('button', { name: 'Phim ngắn người thật' }));
      const loadMore = await screen.findByRole('button', { name: 'Tải thêm' });
      await waitFor(() => expect(cardCount(view)).toBe(60));
      await waitFor(() => expect(pagerInfo()).toBe('Đang hiện 60/75'));

      // Đếm lời gọi sau khi tải xong tab (mặc định lúc mount + lần chuyển tab).
      const callsAfterLoad = browse.mock.calls.length;
      fireEvent.click(loadMore);
      await waitFor(() => expect(cardCount(view)).toBe(75));
      expect(browse.mock.calls.length).toBe(callsAfterLoad);
      expect(screen.queryByRole('button', { name: 'Tải thêm' })).not.toBeInTheDocument();
    } finally {
      view.unmount();
    }
  });
});
