import { describe, expect, it } from 'vitest';
import { dramaLabelTranslations, localizeDramaLabel, localizeDramaTags } from './drama-labels.js';

describe('drama label localization', () => {
  it('translates leftover Chinese category labels for Vietnamese and English', () => {
    expect(localizeDramaLabel('惊悚', 'vi-VN')).toBe('Giật gân');
    expect(localizeDramaLabel('志怪', 'vi-VN')).toBe('Kỳ dị');
    expect(localizeDramaLabel('剧情', 'vi-VN')).toBe('Chính kịch');
    expect(localizeDramaLabel('惊悚', 'en-US')).toBe('Thriller');
    expect(localizeDramaLabel('惊悚', 'zh-CN')).toBe('惊悚');
    expect(localizeDramaLabel('富二代', 'vi-VN')).toBe('Phú nhị đại');
    expect(localizeDramaLabel('推文漫剧', 'vi-VN')).toBe('Kịch truyện tranh');
    expect(localizeDramaLabel('都市修仙', 'vi-VN')).toBe('Tu tiên đô thị');
    expect(localizeDramaLabel('都市修仙', 'en-US')).toBe('Urban cultivation');
  });

  it('replaces the leftover English "Shows" label with Vietnamese', () => {
    expect(localizeDramaLabel('Shows', 'vi-VN')).toBe('Tạp kỹ');
    expect(localizeDramaLabel('Shows', 'en-US')).toBe('Shows');
    expect(localizeDramaLabel('Shows', 'zh-CN')).toBe('Shows');
  });

  it('keeps labels the component already localized', () => {
    expect(localizeDramaLabel('Ngọt sủng', 'vi-VN')).toBe('Ngọt sủng');
    expect(localizeDramaLabel('Ngọt sủng', 'en-US')).toBe('Ngọt sủng');
    expect(localizeDramaLabel('', 'vi-VN')).toBe('');
    expect(localizeDramaLabel(undefined, 'vi-VN')).toBe('');
  });

  it('de-duplicates tags and respects the limit', () => {
    expect(localizeDramaTags(['虐渣', '虐渣', 'Đô thị', '惊悚', 'Thừa'], 'vi-VN', 3))
      .toEqual(['Ngược cặn', 'Đô thị', 'Giật gân']);
    expect(localizeDramaTags(undefined, 'vi-VN')).toEqual([]);
  });

  it('covers every entry with both translations', () => {
    for (const [key, copy] of Object.entries(dramaLabelTranslations)) {
      expect(copy.vi, key).not.toBe('');
      expect(copy.en, key).not.toBe('');
    }
  });
});
