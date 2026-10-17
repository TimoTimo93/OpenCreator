import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAppLanguage } from '../../i18n/LanguageProvider.js';
import type { RuntimeDependencyService } from '../../services/runtime-dependency-service.js';

/**
 * Dịch tên phim tiếng Trung sang ngôn ngữ giao diện.
 *
 * Tên phim gốc được giữ nguyên ở thành phần Hồng Quả nên muốn hiển thị tiếng Việt
 * phải nhờ daemon gọi mô hình ngôn ngữ. Hook này gom danh sách tên đang hiển thị,
 * chỉ gửi những tên chưa có bản dịch, và trả về hàm tra cứu — tên nào chưa dịch
 * được thì giữ nguyên bản gốc.
 */
export function useDramaTitleTranslations(
  service: RuntimeDependencyService | null,
  titles: readonly (string | undefined | null)[]
): (title: string | undefined) => string {
  const { language } = useAppLanguage();
  const [map, setMap] = useState<Record<string, string>>({});
  const requested = useRef(new Set<string>());

  const key = useMemo(() => {
    const unique = new Set<string>();
    for (const title of titles) {
      if (typeof title === 'string' && title.trim() !== '') unique.add(title);
    }
    return [...unique].join('\u0000');
  }, [titles]);

  useEffect(() => {
    if (service === null || language === 'zh-CN' || key === '') return;
    const wanted = key.split('\u0000');
    const missing = wanted.filter(title => {
      const token = `${language}\u0000${title}`;
      if (requested.current.has(token)) return false;
      requested.current.add(token);
      return true;
    });
    if (missing.length === 0) return;
    let active = true;
    void service.translateDramaTitles(missing, language)
      .then(response => {
        if (!active || response?.translations === undefined) return;
        setMap(previous => ({ ...previous, ...response.translations }));
      })
      .catch(() => undefined);
    return () => { active = false; };
  }, [key, language, service]);

  return useCallback((title: string | undefined) => {
    if (typeof title !== 'string' || title === '') return title ?? '';
    return map[title] ?? title;
  }, [map]);
}
