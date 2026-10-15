import { describe, expect, it } from 'vitest';
import {
  getLocalizedPresetTitle,
  getLocalizedPresetDescription,
  getLocalizedWritingTemplate,
  presetViMap,
  writingTemplateViMap
} from './creator-preset-vi.js';

describe('creator-preset-vi localization', () => {
  it('translates all 108 presets to Vietnamese when language is vi-VN', () => {
    expect(Object.keys(presetViMap)).toHaveLength(108);

    const samplePreset = {
      id: 'images-go-hard-thumbnail',
      title: 'Images Go Hard Action Thumbnail',
      description: 'Create a cinematic YouTube thumbnail with a sunset marina, two action characters, and bold three-line typography.'
    };

    expect(getLocalizedPresetTitle(samplePreset, 'vi-VN')).toBe('Thumbnail phim hành động chuẩn điện ảnh');
    expect(getLocalizedPresetDescription(samplePreset, 'vi-VN')).toBe(
      'Tạo ảnh thu nhỏ YouTube đậm chất điện ảnh với bến thuyền hoàng hôn, hai nhân vật hành động và dòng chữ ba hàng nổi bật.'
    );

    // When language is English, preserve English
    expect(getLocalizedPresetTitle(samplePreset, 'en-US')).toBe('Images Go Hard Action Thumbnail');
    expect(getLocalizedPresetDescription(samplePreset, 'en-US')).toBe(samplePreset.description);
  });

  it('translates video presets correctly', () => {
    const videoPreset = {
      id: 'anime-skateboard-chase-nyc',
      title: 'Anime Skateboard Chase in NYC',
      description: 'High-speed anime chase.'
    };
    expect(getLocalizedPresetTitle(videoPreset, 'vi-VN')).toBe(
      'Cuộc rượt đuổi trượt ván phong cách anime tại New York'
    );
  });

  it('translates writing templates to Vietnamese', () => {
    expect(Object.keys(writingTemplateViMap)).toHaveLength(7);

    const template = getLocalizedWritingTemplate(
      'insight',
      'vi-VN',
      { name: 'Deep Insight', description: 'Explore industry trends' }
    );
    expect(template.name).toBe('Góc nhìn chuyên sâu');
    expect(template.description).toContain('Khám phá các xu hướng đầu ngành');

    const englishTemplate = getLocalizedWritingTemplate(
      'insight',
      'en-US',
      { name: 'Deep Insight', description: 'Explore industry trends' }
    );
    expect(englishTemplate.name).toBe('Deep Insight');
  });
});
