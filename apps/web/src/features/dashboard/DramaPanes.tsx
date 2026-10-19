import type {
  HongguoDramaBrowseResponse,
  HongguoDramaCategory,
  HongguoDramaEpisode,
  HongguoDramaGenre,
  HongguoDramaItem,
  HongguoDramaSource,
  HongguoDramaStatusResponse,
  HongguoDramaSeriesDetail,
  HongguoDramaTask
} from '@opencreator/protocol';
import {
  Download,
  Film,
  Languages,
  LoaderCircle,
  Lock,
  RefreshCw,
  Search,
  Send,
  X,
  ChevronDown
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useAppLanguage } from '../../i18n/LanguageProvider.js';
import type { RuntimeDependenciesController } from '../../app/use-runtime-dependencies.js';
import type { RuntimeDependencyService } from '../../services/runtime-dependency-service.js';
import { setPendingTranslationSource } from './pending-translation-source.js';
import { setPendingSocialHandoffSource } from './pending-social-handoff.js';
import { localizeDramaLabel } from './drama-labels.js';
import { useDramaTitleTranslations } from './drama-title-translations.js';
import './drama-panes.css';

/**
 * Khám phá phim + Gợi ý hot.
 *
 * Hai màn hình dữ liệu (danh mục / bảng xếp hạng) đọc qua daemon proxy của
 * drama API loopback của thành phần Hồng Quả; tiến trình thành phần tự khởi
 * động ở lời gọi dữ liệu đầu tiên. Tải tập giao thẳng cho hàng đợi của Hồng
 * Quả (nội dung mã hóa CENC cần bộ giải mã của chính nó).
 */

type DramaPaneProps = {
  runtimeDependencies?: RuntimeDependenciesController;
  onOpenRuntimeComponents?(): void;
};

/** Cắt dải tập: "1-10, 15, 20-30" -> Set<int>. Lỗi thì throw (thông báo đã Việt hóa). */
export function parseEpisodeRange(value: string, total: number): Set<number> {
  const parts = String(value || '').trim().split(/[,，]/);
  const selected = new Set<number>();
  for (const part of parts) {
    const match = part.trim().match(/^(\d+)(?:\s*[-~～]\s*(\d+))?$/);
    if (!match) throw new Error('Định dạng số tập không đúng; hãy nhập 1-30 hoặc 1,5,10; lựa chọn trước vẫn được giữ lại.');
    const a = Number(match[1]);
    const b = Number(match[2] || match[1]);
    if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || a < 1 || b < 1) {
      throw new Error('Số tập phải là số nguyên lớn hơn 0; lựa chọn trước vẫn được giữ lại.');
    }
    for (let n = Math.max(1, Math.min(a, b)); n <= Math.min(total, Math.max(a, b)); n++) selected.add(n);
  }
  if (!selected.size) throw new Error(`Số tập vượt phạm vi, hãy chọn trong 1-${total}; lựa chọn trước vẫn được giữ lại.`);
  return selected;
}

const isSubmitKey = (event: { key: string; isComposing?: boolean; nativeEvent?: { isComposing?: boolean }; keyCode?: number }) =>
  event.key === 'Enter' && !event.isComposing && !event.nativeEvent?.isComposing && event.keyCode !== 229;

/** Trích mã lỗi từ phản hồi lỗi HTTP của daemon (ApiError shape). */
function errorCodeOf(error: unknown): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const code = (error as { error?: { code?: unknown } }).error?.code;
  return typeof code === 'string' ? code : null;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'error' in error) {
    const inner = (error as { error?: { message?: unknown } }).error?.message;
    if (typeof inner === 'string') return inner;
  }
  return String(error);
}

// ---------------------------------------------------------------------------
// Tải trước (preload) dữ liệu Hồng Quả
// ---------------------------------------------------------------------------

/**
 * Bộ đệm cấp module cho Khám phá phim / Gợi ý hot.
 *
 * AppController gọi `prefetchDramaPanes` ngay khi app kết nối Runtime, nên khi
 * người dùng mở trang tải video thì danh mục cùng hai danh sách mặc định đã nằm
 * sẵn trong bộ đệm và hiển thị tức thì. Màn hình vẫn tải nền để dữ liệu không cũ.
 */
const dramaPreload = {
  installed: undefined as boolean | undefined,
  downloadsRoot: undefined as string | undefined,
  categories: undefined as HongguoDramaCategory[] | undefined,
  sources: undefined as HongguoDramaSource[] | undefined,
  browse: new Map<string, HongguoDramaBrowseResponse>(),
  hot: new Map<string, HongguoDramaBrowseResponse>()
};

type DramaListQuery = { source: string; category: string; genre?: string; page: number };

/** Khoá bộ đệm cho một truy vấn danh sách (nguồn + danh mục + thể loại + trang). */
function dramaListKey(query: DramaListQuery): string {
  return [query.source, query.category, query.genre ?? '', query.page].join('\u0000');
}

/** Truy vấn mặc định của hai màn hình dữ liệu (khớp với state khởi tạo bên dưới). */
const DRAMA_BROWSE_DEFAULT: DramaListQuery = { source: 'hongguo', category: 'real-drama', page: 1 };
const DRAMA_HOT_DEFAULT: DramaListQuery = { source: 'hongguo', category: 'hot-drama', page: 1 };

/**
 * Tải trước danh mục + hai danh sách mặc định. Gọi nhiều lần cũng an toàn: chỉ
 * đọc lại bộ đệm phía daemon. Chưa cài thành phần Hồng Quả thì bỏ qua để không
 * đánh thức tiến trình ngoài ý muốn.
 */
export async function prefetchDramaPanes(service: RuntimeDependencyService): Promise<void> {
  const status = await service.getDramaStatus();
  dramaPreload.installed = status.hongguo.installed === true;
  dramaPreload.downloadsRoot = status.hongguo.downloadsRoot;
  if (status.hongguo.installed !== true) return;
  const settled = await Promise.allSettled([
    service.getDramaCategories(),
    service.getDramaMediaSources()
  ]);
  const [categories, sources] = settled;
  if (categories.status === 'fulfilled') dramaPreload.categories = categories.value.categories ?? [];
  if (sources.status === 'fulfilled' && sources.value.success) dramaPreload.sources = sources.value.sources ?? [];
  const browseKey = dramaListKey(DRAMA_BROWSE_DEFAULT);
  const browse = await service.browseDrama({ ...DRAMA_BROWSE_DEFAULT }).catch(() => undefined);
  if (browse !== undefined) dramaPreload.browse.set(browseKey, browse);
  const hotKey = dramaListKey(DRAMA_HOT_DEFAULT);
  const hot = await service.browseDrama({ ...DRAMA_HOT_DEFAULT, category: DRAMA_HOT_DEFAULT.category }).catch(() => undefined);
  if (hot !== undefined) dramaPreload.hot.set(hotKey, hot);
}

/** Lọc danh sách xếp hạng: bỏ mục thiếu mã/tên hợp lệ và mục trùng lặp. */
function filterHotItems(items: HongguoDramaItem[] | undefined): HongguoDramaItem[] {
  const seen = new Set<string>();
  return (items ?? []).filter(item => {
    const id = String(item.series_id ?? '');
    if (!/^\d{6,30}$/.test(id) || typeof item.series_title !== 'string' || item.series_title.trim() === '' || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// khung dùng chung
// ---------------------------------------------------------------------------

function DramaNotice(props: {
  title: string;
  hint?: string;
  actionLabel?: string;
  onAction?(): void;
  tone?: 'info' | 'error';
  children?: ReactNode;
}) {
  return (
    <div className={`drama-notice ${props.tone === 'error' ? 'drama-notice-error' : ''}`} role={props.tone === 'error' ? 'alert' : 'status'}>
      <Film size={26} strokeWidth={1.6} aria-hidden="true" />
      <h3>{props.title}</h3>
      {props.hint === undefined ? null : <p>{props.hint}</p>}
      {props.children}
      {props.actionLabel !== undefined && props.onAction !== undefined ? (
        <button type="button" className="drama-btn" onClick={props.onAction}>{props.actionLabel}</button>
      ) : null}
    </div>
  );
}

function DramaSpinner(props: { label: string }) {
  return (
    <div className="drama-loading" role="status">
      <LoaderCircle className="drama-spin" size={17} aria-hidden="true" />
      <span>{props.label}</span>
    </div>
  );
}

/** Chuẩn bị service + trạng thái cài đặt của thành phần Hồng Quả. */
function useDramaBackend(deps: DramaPaneProps['runtimeDependencies']) {
  const [phase, setPhase] = useState<'unknown' | 'ready' | 'not-installed' | 'failed'>(
    () => dramaPreload.installed === undefined ? 'unknown' : dramaPreload.installed ? 'ready' : 'not-installed'
  );
  const [failure, setFailure] = useState('');
  const [downloadsRoot, setDownloadsRoot] = useState<string | undefined>(dramaPreload.downloadsRoot);
  const service = deps?.service ?? null;

  const probe = useCallback(async () => {
    if (service === null) { setPhase('failed'); return; }
    try {
      const response: HongguoDramaStatusResponse = await service.getDramaStatus();
      dramaPreload.installed = response.hongguo.installed === true;
      dramaPreload.downloadsRoot = response.hongguo.downloadsRoot;
      setDownloadsRoot(response.hongguo.downloadsRoot);
      // Sẵn sàng dùng: lời gọi dữ liệu đầu tiên phía daemon tự khởi động
      // tiến trình thành phần (single-flight) nếu chưa chạy.
      setPhase(response.hongguo.installed ? 'ready' : 'not-installed');
    } catch (error) {
      setPhase('failed');
      setFailure(messageOf(error));
    }
  }, [service]);

  return { service, phase, failure, downloadsRoot, probe };
}

function BackendGate(props: {
  phase: 'unknown' | 'ready' | 'not-installed' | 'failed';
  failure: string;
  onRetry(): void;
  onOpenRuntimeComponents?: () => void;
  children: ReactNode;
}) {
  const { t } = useAppLanguage();
  if (props.phase === 'not-installed') {
    return (
      <DramaNotice
        title={t('dashboard.drama.notInstalled')}
        hint={t('dashboard.drama.notInstalledHint')}
        {...(props.onOpenRuntimeComponents === undefined
          ? {}
          : { actionLabel: t('dashboard.drama.openSettings'), onAction: props.onOpenRuntimeComponents })}
      />
    );
  }
  if (props.phase === 'failed') {
    return (
      <DramaNotice
        tone="error"
        title={t('dashboard.drama.apiFailed')}
        hint={props.failure}
        actionLabel={t('dashboard.drama.retry')}
        onAction={props.onRetry}
      />
    );
  }
  return <>{props.children}</>;
}

// ---------------------------------------------------------------------------
// Drawer chi tiết phim (dùng chung cho cả hai màn hình)
// ---------------------------------------------------------------------------

function DramaDetailDrawer(props: {
  service: RuntimeDependencyService;
  seriesId: string;
  downloadsRoot?: string;
  onClose(): void;
}) {
  const { t } = useAppLanguage();
  const [detail, setDetail] = useState<HongguoDramaSeriesDetail>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const [rangeInput, setRangeInput] = useState('');
  const [rangeError, setRangeError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState('');
  const requestRef = useRef(0);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();
  const translateTitle = useDramaTitleTranslations(
    props.service ?? null,
    useMemo(() => (detail === undefined ? [] : [detail.series_title]), [detail])
  );

  const showToast = useCallback((text: string) => {
    setNotice(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setNotice(''), 3500);
  }, []);

  const loadDetail = useCallback(async (options: { silent: boolean }) => {
    const request = ++requestRef.current;
    if (!options.silent) { setLoading(true); setLoadError(''); }
    try {
      const resolved = await props.service.getDramaSeries(props.seriesId);
      if (request !== requestRef.current) return;
      if (!resolved.success || resolved.data === undefined) {
        setLoadError(resolved.error || t('dashboard.drama.loadFailed'));
        return;
      }
      let merged: HongguoDramaEpisode[] = (resolved.data.episodes ?? []) as HongguoDramaEpisode[];
      // Trạng thái tải tập từ đĩa/queue của Hồng Quả (best-effort).
      try {
        const status = await props.service.getDramaSeriesEpisodes(props.seriesId);
        if (request !== requestRef.current) return;
        if (status.success && status.data !== undefined) {
          const byIndex = new Map<number, HongguoDramaEpisode>();
          for (const episode of (status.data.episodes ?? []) as HongguoDramaEpisode[]) byIndex.set(Number(episode.vid_index), episode);
          merged = merged.map(episode => {
            const extra = byIndex.get(Number(episode.vid_index));
            return extra === undefined ? episode : { ...episode, ...extra, vid: episode.vid ?? extra.vid };
          });
        }
      } catch {
        // danh sách tập vẫn hiển thị được dù thiếu trạng thái
      }
      setDetail({ ...resolved.data, episodes: merged });
      setSelected(new Set(
        merged.filter(episode => episode.locked !== true && episode.status !== 'completed')
          .map(episode => Number(episode.vid_index))
      ));
    } catch (error) {
      if (request === requestRef.current) setLoadError(messageOf(error));
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [props.seriesId, props.service, t]);

  useEffect(() => {
    void loadDetail({ silent: false });
    return () => {
      requestRef.current++;
      clearTimeout(toastTimer.current);
    };
  }, [loadDetail]);

  // Trong lúc còn tập đang tải: poll trạng thái 2 giây.
  const activeDownloads = (detail?.episodes ?? []).some(
    episode => episode.status === 'downloading' || episode.status === 'pending'
  );
  useEffect(() => {
    if (!activeDownloads) return;
    const timer = setInterval(() => { void loadDetail({ silent: true }); }, 2000);
    return () => clearInterval(timer);
  }, [activeDownloads, loadDetail]);

  const applyRange = (expression: string) => {
    if (detail === undefined) return;
    try {
      const numbers = parseEpisodeRange(expression, detail.episodes?.length ?? 0);
      setSelected(new Set(
        (detail.episodes ?? []).filter(episode => episode.locked !== true && numbers.has(Number(episode.vid_index)))
          .map(episode => Number(episode.vid_index))
      ));
      setRangeError('');
    } catch (error) {
      setRangeError(messageOf(error));
    }
  };

  const downloadSelected = async () => {
    if (detail === undefined || selected.size === 0) return;
    setSubmitting(true);
    try {
      const episodes = (detail.episodes ?? [])
        .filter(episode => episode.locked !== true && selected.has(Number(episode.vid_index)))
        .map(episode => ({
          vid: String(episode.vid ?? ''),
          vid_index: Number(episode.vid_index),
          title: episode.title ?? '',
          cover: detail.cover ?? ''
        }));
      const response = await props.service.downloadDramaBatch({
        seriesId: String(detail.series_id),
        seriesTitle: detail.series_title,
        episodes
      });
      if (response.success) {
        showToast(t('dashboard.drama.downloadQueued', { count: response.count ?? episodes.length }));
        await loadDetail({ silent: true });
      } else {
        showToast(`${t('dashboard.drama.downloadFailed')}: ${response.error ?? ''}`.trim());
      }
    } catch (error) {
      showToast(`${t('dashboard.drama.downloadFailed')}: ${messageOf(error)}`);
    } finally {
      setSubmitting(false);
    }
  };

  const total = detail?.episodes?.length ?? detail?.total ?? 0;
  const completedCount = (detail?.episodes ?? []).filter(episode => episode.status === 'completed').length;
  const episodeStatusText = (episode: HongguoDramaEpisode): string | undefined => {
    if (episode.status === 'downloading') return t('dashboard.drama.statusDownloading');
    if (episode.status === 'pending') return t('dashboard.drama.statusPending');
    return undefined;
  };

  return (
    <div className="drama-drawer-mask" onClick={props.onClose}>
      <div
        className="drama-drawer"
        role="dialog"
        aria-modal="true"
        aria-label={t('dashboard.drama.detailTitle')}
        tabIndex={-1}
        onClick={event => event.stopPropagation()}
      >
        <div className="drama-drawer-head">
          <div className="drama-drawer-title">
            <Film size={16} aria-hidden="true" />
            <span>{detail === undefined ? t('dashboard.drama.drawerLoading') : `《${translateTitle(detail.series_title)}》`}</span>
          </div>
          <button type="button" className="drama-icon-btn" onClick={props.onClose} aria-label={t('dashboard.drama.close')} title={t('dashboard.drama.close')}>
            <X size={16} aria-hidden="true" />
          </button>
        </div>

        {loading ? <DramaSpinner label={t('dashboard.drama.drawerLoading')} /> : null}
        {!loading && loadError !== '' ? (
          <DramaNotice
            tone="error"
            title={t('dashboard.drama.loadFailed')}
            hint={loadError}
            actionLabel={t('dashboard.drama.retry')}
            onAction={() => void loadDetail({ silent: false })}
          />
        ) : null}

        {detail !== undefined && !loading ? (
          <>
            <div className="drama-drawer-body">
              <div className="drama-drawer-info">
                {detail.cover ? <img className="drama-drawer-cover" src={detail.cover} alt="" /> : null}
                <div className="drama-drawer-meta">
                  <p className="drama-drawer-count">
                    {t('dashboard.drama.drawerTotal', { count: total })} · {t('dashboard.drama.drawerDownloaded', { count: completedCount })}
                  </p>
                  {detail.web_accessible_episodes != null && detail.web_accessible_episodes < total ? (
                    <p className="drama-drawer-sub">{t('dashboard.drama.webAccessible', { count: detail.web_accessible_episodes })}</p>
                  ) : null}
                  {(detail.episodes ?? []).some(episode => episode.locked === true) ? (
                    <p className="drama-drawer-sub">{t('dashboard.drama.lockedNote')}</p>
                  ) : null}
                  <p className="drama-drawer-sub">{t('dashboard.drama.selectedCount', { count: selected.size })}</p>
                  <div className="drama-range-row">
                    <input
                      type="text"
                      className="drama-input"
                      aria-label={t('dashboard.drama.rangePlaceholder')}
                      placeholder={t('dashboard.drama.rangePlaceholder')}
                      value={rangeInput}
                      onChange={event => { setRangeInput(event.target.value); setRangeError(''); }}
                      onKeyDown={event => { if (isSubmitKey(event)) applyRange(rangeInput); }}
                    />
                    <button type="button" className="drama-btn drama-btn-sm" onClick={() => applyRange(rangeInput)}>
                      {t('dashboard.drama.rangeApply')}
                    </button>
                  </div>
                  {rangeError !== '' ? <p className="drama-inline-error" role="alert">{rangeError}</p> : null}
                  <div className="drama-preset-row">
                    <button type="button" className="drama-chip" onClick={() => applyRange(`1-${Math.min(10, total)}`)}>{t('dashboard.drama.first10')}</button>
                    <button type="button" className="drama-chip" onClick={() => applyRange(`1-${Math.min(30, total)}`)}>{t('dashboard.drama.first30')}</button>
                    <button type="button" className="drama-chip" onClick={() => applyRange(`${Math.max(1, total - 29)}-${total}`)}>{t('dashboard.drama.last30')}</button>
                    <button
                      type="button"
                      className="drama-chip"
                      onClick={() => setSelected(new Set((detail.episodes ?? []).filter(episode => episode.locked !== true).map(episode => Number(episode.vid_index))))}
                    >
                      {t('dashboard.drama.selectAll')}
                    </button>
                    <button type="button" className="drama-chip" onClick={() => setSelected(new Set())}>{t('dashboard.drama.clearSelection')}</button>
                  </div>
                </div>
              </div>

              <div className="drama-eps" role="group" aria-label={t('dashboard.drama.detailTitle')}>
                {(detail.episodes ?? []).map(episode => {
                  const index = Number(episode.vid_index);
                  const locked = episode.locked === true;
                  const picked = selected.has(index);
                  const statusText = episodeStatusText(episode);
                  return (
                    <button
                      key={index}
                      type="button"
                      disabled={locked}
                      aria-pressed={picked}
                      title={locked ? t('dashboard.drama.epLocked') : episode.title || t('dashboard.drama.episodes', { count: index })}
                      className={`drama-ep ${episode.status === 'completed' ? 'drama-ep-done' : ''} ${picked ? 'drama-ep-picked' : ''}`}
                      onClick={() => {
                        const next = new Set(selected);
                        if (picked) next.delete(index); else next.add(index);
                        setSelected(next);
                      }}
                    >
                      <span>{index}</span>
                      {locked ? <Lock size={10} aria-hidden="true" /> : null}
                      {episode.status === 'completed' ? <span className="drama-ep-dot" aria-hidden="true" /> : null}
                      {statusText !== undefined && episode.status === 'downloading'
                        ? <small>{Math.round(episode.progress ?? 0)}%</small>
                        : null}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="drama-drawer-foot">
              {props.downloadsRoot === undefined ? null : (
                <span className="drama-foot-note">{t('dashboard.drama.downloadsNote', { path: props.downloadsRoot })}</span>
              )}
              <button
                type="button"
                className="drama-btn drama-btn-primary"
                disabled={submitting || selected.size === 0}
                onClick={() => void downloadSelected()}
              >
                {submitting ? <LoaderCircle className="drama-spin" size={15} aria-hidden="true" /> : <Download size={15} aria-hidden="true" />}
                {t('dashboard.drama.downloadSelected', { count: selected.size })}
              </button>
            </div>
          </>
        ) : null}

        {notice !== '' ? <div className="drama-toast" role="status" onClick={() => setNotice('')}>{notice}</div> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Khám phá phim
// ---------------------------------------------------------------------------

export function DramaBrowsePane(props: DramaPaneProps) {
  const { t, language } = useAppLanguage();
  const { service, phase, failure, downloadsRoot, probe } = useDramaBackend(props.runtimeDependencies);
  const [sources, setSources] = useState<HongguoDramaSource[]>(dramaPreload.sources ?? []);
  const [source, setSource] = useState('hongguo');
  const [categories, setCategories] = useState<HongguoDramaCategory[]>(dramaPreload.categories ?? []);
  const [category, setCategory] = useState('real-drama');
  const [genre, setGenre] = useState('');
  const [page, setPage] = useState(1);
  const [completion, setCompletion] = useState<'all' | 'completed' | 'ongoing'>('all');
  // Dữ liệu đã tải trước lúc app khởi động: hiển thị ngay, không quay lại vòng xoay.
  const preloaded = useRef(dramaPreload.browse.get(dramaListKey(DRAMA_BROWSE_DEFAULT))).current;
  const [results, setResults] = useState<HongguoDramaItem[]>(preloaded?.results ?? []);
  const [total, setTotal] = useState(preloaded?.total ?? preloaded?.meta?.total ?? 0);
  const [totalPages, setTotalPages] = useState(preloaded?.totalPages ?? preloaded?.meta?.totalPages ?? 0);
  const [genres, setGenres] = useState<HongguoDramaGenre[]>(preloaded?.genres ?? preloaded?.meta?.genres ?? []);
  const [hasMore, setHasMore] = useState(preloaded?.hasMore === true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [unsupported, setUnsupported] = useState(false);
  const [keyword, setKeyword] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const listRequest = useRef(0);
  const timeoutTimer = useRef<ReturnType<typeof setTimeout>>();
  const translateTitle = useDramaTitleTranslations(
    service,
    useMemo(() => results.map(item => item.series_title), [results])
  );

  useEffect(() => {
    if (service === null) return;
    void probe();
    void service.getDramaCategories()
      .then(response => { dramaPreload.categories = response.categories ?? []; setCategories(dramaPreload.categories); })
      .catch(() => undefined);
    void service.getDramaMediaSources()
      .then(response => { if (response.success) { dramaPreload.sources = response.sources ?? []; setSources(dramaPreload.sources); } })
      .catch(() => undefined);
  }, [probe, service]);

  const loadBrowse = useCallback(async (forceRefresh: boolean) => {
    if (service === null) return;
    const cacheKey = dramaListKey({ source, category, genre, page });
    const request = ++listRequest.current;
    clearTimeout(timeoutTimer.current);
    setError('');
    setUnsupported(false);
    // Có dữ liệu tải trước thì làm mới nền, không nháy vòng xoay.
    setLoading(dramaPreload.browse.get(cacheKey) === undefined);
    timeoutTimer.current = setTimeout(() => {
      if (request !== listRequest.current) return;
      listRequest.current++;
      setLoading(false);
      setError(t('dashboard.drama.loadFailed'));
    }, 45_000);
    try {
      const response = await service.browseDrama({ source, category, genre, page, forceRefresh });
      if (request !== listRequest.current) return;
      if (!response.success) {
        setResults([]);
        setError(response.error || t('dashboard.drama.loadFailed'));
        return;
      }
      dramaPreload.browse.set(cacheKey, response);
      const items = response.results ?? [];
      setResults(items);
      setTotal(response.total ?? response.meta?.total ?? 0);
      setTotalPages(response.totalPages ?? response.meta?.totalPages ?? 0);
      setGenres(response.genres ?? response.meta?.genres ?? []);
      setHasMore(response.hasMore === true);
      if (items.length === 0) {
        setUnsupported(response.unsupported === true);
        setError(response.emptyMessage || t('dashboard.drama.empty'));
      }
    } catch (cause) {
      if (request !== listRequest.current) return;
      setError(`${t('dashboard.drama.loadFailed')}: ${messageOf(cause)}`);
    } finally {
      if (request === listRequest.current) {
        clearTimeout(timeoutTimer.current);
        setLoading(false);
      }
    }
  }, [category, genre, page, service, source, t]);

  useEffect(() => {
    if (phase === 'ready') void loadBrowse(false);
  }, [loadBrowse, phase]);

  const runSearch = async () => {
    if (service === null) return;
    const kw = keyword.trim();
    if (kw === '') return;
    setSearchLoading(true);
    setError('');
    try {
      const response = await service.searchDrama(kw, { source });
      if (!response.success) {
        setError(response.error || t('dashboard.drama.loadFailed'));
        return;
      }
      setResults(response.results ?? []);
      setSearchActive(true);
    } catch (cause) {
      setError(`${t('dashboard.drama.loadFailed')}: ${messageOf(cause)}`);
    } finally {
      setSearchLoading(false);
    }
  };

  const clearSearch = () => {
    setSearchActive(false);
    setKeyword('');
    void loadBrowse(false);
  };

  const visibleResults = completion === 'all'
    ? results
    : results.filter(item => item.completion_status === completion);
  const browseCategories = categories.filter(item => !item.slug.startsWith('hot-'));

  return (
    <BackendGate phase={phase} failure={failure} onRetry={() => void probe()} {...(props.onOpenRuntimeComponents === undefined ? {} : { onOpenRuntimeComponents: props.onOpenRuntimeComponents })}>
      <section className="drama-pane" aria-label={t('dashboard.drama.title')}>
        <div className="drama-pane-head">
          <div>
            <h2>{t('dashboard.drama.title')}</h2>
            <p className="drama-subtitle">{t('dashboard.drama.subtitle')}</p>
          </div>
          <div className="drama-pane-actions">
            {sources.length > 1 ? (
              <label className="drama-field">
                <span>{t('dashboard.drama.sourceLabel')}</span>
                <select
                  className="drama-input"
                  value={source}
                  aria-label={t('dashboard.drama.sourceLabel')}
                  onChange={event => {
                    setSource(event.target.value);
                    setCategory('real-drama');
                    setGenre('');
                    setPage(1);
                    setSearchActive(false);
                    // Sources such as Hà Mã / Tây Phạn do not report completion
                    // status, so keep the filter from hiding every card.
                    setCompletion('all');
                  }}
                >
                  {sources.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
                </select>
              </label>
            ) : null}
            <div className="drama-search-row">
              <input
                type="search"
                className="drama-input"
                value={keyword}
                placeholder={t('dashboard.drama.searchPlaceholder')}
                aria-label={t('dashboard.drama.search')}
                onChange={event => setKeyword(event.target.value)}
                onKeyDown={event => { if (event.key === 'Enter') void runSearch(); }}
              />
              <button type="button" className="drama-btn" disabled={searchLoading} onClick={() => void runSearch()}>
                {searchLoading ? <LoaderCircle className="drama-spin" size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
                {t('dashboard.drama.search')}
              </button>
              {searchActive ? (
                <button type="button" className="drama-btn drama-btn-ghost" onClick={clearSearch}>{t('dashboard.drama.clearSearch')}</button>
              ) : null}
            </div>
            <button type="button" className="drama-btn" disabled={loading} onClick={() => void loadBrowse(true)}>
              <RefreshCw size={14} aria-hidden="true" />
              {t('dashboard.drama.refresh')}
            </button>
          </div>
        </div>

        {searchActive ? (
          <p className="drama-list-note" role="status">{t('dashboard.drama.searchResults')} · {results.length}</p>
        ) : (
          <>
            <div className="drama-cats" role="group" aria-label={t('dashboard.drama.categories')}>
              {(browseCategories.length > 0 ? browseCategories : [{ slug: 'real-drama', label: t('dashboard.drama.categories') } as HongguoDramaCategory]).map(item => (
                <button
                  key={item.slug}
                  type="button"
                  className={`drama-cat ${category === item.slug ? 'drama-cat-active' : ''}`}
                  aria-pressed={category === item.slug}
                  onClick={() => { setCategory(item.slug); setGenre(''); setPage(1); }}
                >
                  {localizeDramaLabel(item.label, language)}
                </button>
              ))}
            </div>
            {genres.length > 0 ? (
              <div className="drama-genres" role="group" aria-label={t('dashboard.drama.categories')}>
                <button type="button" className={`drama-chip ${genre === '' ? 'drama-chip-active' : ''}`} onClick={() => { setGenre(''); setPage(1); }}>
                  {t('dashboard.drama.all')}
                </button>
                {genres.map(item => (
                  <button
                    key={item.slug}
                    type="button"
                    className={`drama-chip ${genre === item.slug ? 'drama-chip-active' : ''}`}
                    onClick={() => { setGenre(item.slug); setPage(1); }}
                  >
                    {localizeDramaLabel(item.label, language)}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="drama-completion">
              <label htmlFor="drama-completion-filter">{t('dashboard.drama.completionFilter')}</label>
              <select
                id="drama-completion-filter"
                className="drama-input"
                value={completion}
                onChange={event => setCompletion(event.target.value as 'all' | 'completed' | 'ongoing')}
              >
                <option value="all">{t('dashboard.drama.completionAll')}</option>
                <option value="completed">{t('dashboard.drama.completionCompleted')}</option>
                <option value="ongoing">{t('dashboard.drama.completionOngoing')}</option>
              </select>
              {total > 0 ? <span className="drama-stat">{t('dashboard.drama.total', { count: total })}</span> : null}
            </div>
          </>
        )}

        {loading ? <DramaSpinner label={t('dashboard.drama.loading')} /> : null}
        {!loading && error !== '' ? (
          <DramaNotice
            tone={unsupported ? 'info' : 'error'}
            title={unsupported ? t('dashboard.drama.unsupportedTitle') : t('dashboard.drama.loadFailed')}
            hint={error}
            actionLabel={t('dashboard.drama.retry')}
            onAction={() => (searchActive ? void runSearch() : void loadBrowse(true))}
          />
        ) : null}

        {!loading && error === '' && visibleResults.length === 0 && searchActive ? (
          <DramaNotice title={t('dashboard.drama.empty')} hint={t('dashboard.drama.searchPlaceholder')} />
        ) : null}

        <div className="drama-grid">
          {visibleResults.map(item => (
            <button
              key={item.series_id}
              type="button"
              className="drama-card"
              title={translateTitle(item.series_title)}
              onClick={() => setDetailId(String(item.series_id))}
            >
              <div className="drama-cover">
                {typeof item.rank === 'number' && item.rank > 0
                  ? <span className="drama-rank">{t('dashboard.drama.rank', { rank: item.rank })}</span>
                  : null}
                {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="drama-cover-ph"><Film size={20} aria-hidden="true" /></div>}
                {item.episode_label !== undefined && item.episode_label !== ''
                  ? <span className="drama-ep-badge">{item.episode_label}</span>
                  : typeof item.episode_count === 'number' && item.episode_count > 0
                    ? <span className="drama-ep-badge">{t('dashboard.drama.episodes', { count: item.episode_count })}</span>
                    : null}
              </div>
              <div className="drama-card-title">{translateTitle(item.series_title)}</div>
              {item.completion_status === 'completed' ? <div className="drama-card-flag">{t('dashboard.drama.completionCompleted')}</div> : null}
              {item.completion_status === 'ongoing' ? <div className="drama-card-flag">{t('dashboard.drama.completionOngoing')}</div> : null}
              {item.heat !== undefined ? <div className="drama-card-heat">{item.heat}</div> : null}
              {(item.tags ?? []).length > 0 ? (
                <div className="drama-card-tags">
                  {(item.tags ?? []).slice(0, 2).map(tag => <span key={tag} className="drama-tag">{localizeDramaLabel(tag, language)}</span>)}
                </div>
              ) : null}
            </button>
          ))}
        </div>

        {!searchActive && (totalPages > 1 || hasMore) ? (
          <div className="drama-pager">
            <button type="button" className="drama-pager-btn" disabled={page <= 1 || loading} onClick={() => setPage(Math.max(1, page - 1))}>
              {t('dashboard.drama.prevPage')}
            </button>
            <span className="drama-pager-info">{totalPages > 1 ? `${page} / ${totalPages}` : `${page}`}</span>
            <button
              type="button"
              className="drama-pager-btn"
              disabled={loading || (!hasMore && page >= totalPages)}
              onClick={() => setPage(page + 1)}
            >
              {t('dashboard.drama.nextPage')}
            </button>
          </div>
        ) : null}

        {detailId !== null && service !== null ? (
          <DramaDetailDrawer
            service={service}
            seriesId={detailId}
            {...(downloadsRoot === undefined ? {} : { downloadsRoot })}
            onClose={() => setDetailId(null)}
          />
        ) : null}
      </section>
    </BackendGate>
  );
}

// ---------------------------------------------------------------------------
// Hàng đợi tải (tác vụ tải tập do Hồng Quả thực thi)
// ---------------------------------------------------------------------------

function formatBytes(value: number | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
  const rounded = unit === 0 ? String(Math.round(size)) : size.toFixed(size >= 100 ? 0 : 1);
  return `${rounded} ${units[unit]}`;
}

function queueStatusKey(status: string | undefined): 'pending' | 'downloading' | 'completed' | 'failed' | 'stopped' {
  switch (status) {
    case 'downloading': return 'downloading';
    case 'completed': return 'completed';
    case 'failed': return 'failed';
    case 'stopped': return 'stopped';
    default: return 'pending';
  }
}

// ---------------------------------------------------------------------------
// Hàng đợi tải (tác vụ tải tập do Hồng Quả thực thi)
// ---------------------------------------------------------------------------

/** Khóa gom nhóm một tác vụ tải theo bộ phim: ưu tiên series Hồng Qua, sau đó trích từ tiêu đề. */
function seriesKeyOfTask(task: HongguoDramaTask): { key: string; name: string } {
  const raw = (task.title ?? task.videoInfo?.title ?? task.filename ?? '').trim();
  const seriesId = task.hongguoInfo?.series_id;
  const seriesTitle = (task.hongguoInfo?.series_title ?? '').trim();
  if (seriesId !== undefined && String(seriesId).trim() !== '') {
    return { key: `honggua:${String(seriesId)}`, name: seriesTitle !== '' ? seriesTitle : raw };
  }
  // 《Tên phim》 Tập 12 — phim Hồng Qua thường dùng khối 《》.
  const bracket = raw.match(/《(.+?)》/);
  if (bracket !== null) return { key: `title:${bracket[1] ?? ''}`, name: bracket[1] ?? raw };
  // “Tên phim - Tập 12” / “… EP03” / đuôi số.
  const prefix = raw.replace(/\s*[-—]?\s*(?:Tập|Tap|Tạp|EP\.?|E\d*|Phần)?\s*\d{1,4}\s*$/i, '').trim();
  if (prefix !== '' && prefix !== raw) return { key: `title:${prefix}`, name: prefix };
  return { key: `solo:${task.id ?? raw}`, name: raw };
}

export function DramaQueuePane(props: DramaPaneProps) {
  const { t } = useAppLanguage();
  const { service, phase, failure, downloadsRoot, probe } = useDramaBackend(props.runtimeDependencies);
  const [tasks, setTasks] = useState<HongguoDramaTask[]>([]);
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const translateTitle = useDramaTitleTranslations(
    service,
    useMemo(
      () => tasks.map(task => task.title ?? task.videoInfo?.title ?? task.filename),
      [tasks]
    )
  );

  const load = useCallback(async (showSpinner: boolean): Promise<void> => {
    if (service === null) return;
    if (showSpinner) setLoading(true);
    try {
      const response = await service.getDramaDownloadTasks();
      setTasks(response.tasks ?? []);
      setError('');
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      if (showSpinner) setLoading(false);
    }
  }, [service]);

  useEffect(() => {
    if (service === null) return;
    void probe();
  }, [probe]);

  useEffect(() => {
    if (phase === 'ready') void load(true);
  }, [load, phase]);

  // Còn tác vụ đang chạy: làm mới hàng đợi mỗi 2 giây (giống poll trạng thái tập).
  const active = tasks.some(task => task.status === 'downloading' || task.status === 'pending');
  useEffect(() => {
    if (phase !== 'ready' || !active) return;
    const timer = setInterval(() => { void load(false); }, 2000);
    return () => clearInterval(timer);
  }, [active, load, phase]);

  const summary = useMemo(() => tasks.reduce(
    (acc, task) => {
      const key = queueStatusKey(task.status);
      if (key === 'completed') acc.done += 1;
      else if (key === 'failed' || key === 'stopped') acc.failed += 1;
      else acc.active += 1;
      return acc;
    },
    { active: 0, done: 0, failed: 0 }
  ), [tasks]);

  const statusLabel = useCallback((status: string | undefined): string => {
    switch (queueStatusKey(status)) {
      case 'downloading': return t('dashboard.drama.statusDownloading');
      case 'completed': return t('dashboard.drama.statusCompleted');
      case 'failed': return t('dashboard.drama.queueStatusFailed');
      case 'stopped': return t('dashboard.drama.queueStatusStopped');
      default: return t('dashboard.drama.statusPending');
    }
  }, [t]);

  const openInTranslation = useCallback((task: HongguoDramaTask, title: string) => {
    const path = task.savePath;
    if (path === undefined || path === '') return;
    const seriesTitle = task.hongguoInfo?.series_title ?? seriesKeyOfTask(task).name;
    setPendingTranslationSource({
      path,
      title,
      ...(seriesTitle !== '' ? { series: { title: seriesTitle } } : {})
    });
    window.location.hash = '#/workbench?tool=video-translation';
  }, []);

  const openInSocial = useCallback((task: HongguoDramaTask, title: string) => {
    const path = task.savePath;
    if (path === undefined || path === '') return;
    setPendingSocialHandoffSource({ path, title });
    window.location.hash = '#/workbench?tool=social-channels';
  }, []);

        /** Nhóm tác vụ theo bộ phim (danh sách giữ thứ tự xuất hiện). */
  const groups = useMemo(() => {
    const list: Array<{ key: string; name: string; tasks: HongguoDramaTask[] }> = [];
    const byKey = new Map<string, { key: string; name: string; tasks: HongguoDramaTask[] }>();
    for (const task of tasks) {
      const series = seriesKeyOfTask(task);
      let group = byKey.get(series.key);
      if (group === undefined) {
        group = { key: series.key, name: series.name, tasks: [] };
        byKey.set(series.key, group);
        list.push(group);
      }
      group.tasks.push(task);
    }
    return list;
  }, [tasks]);

  const toggleGroup = useCallback((key: string) => {
    setExpandedGroups(previous => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /** Nút "Thêm cả bộ vào dịch": chỉ hiện khi toàn bộ tập của nhóm đã tải xong. */
  const openSeriesInTranslation = useCallback((group: { name: string; tasks: HongguoDramaTask[] }) => {
    const firstDone = group.tasks.find(task => queueStatusKey(task.status) === 'completed' && (task.savePath ?? '') !== '');
    const path = firstDone?.savePath;
    if (path === undefined || path === '') return;
    setPendingTranslationSource({
      path,
      title: group.name,
      ...(group.name !== '' ? { series: { title: group.name } } : {})
    });
    window.location.hash = '#/workbench?tool=video-translation';
  }, []);

  /** Một dòng tác vụ — dùng lại cho cả bản nhóm (compact) và bản đơn. */
  const renderTaskRow = useCallback((task: HongguoDramaTask, index: number, compact: boolean) => {
    const key = queueStatusKey(task.status);
    const percent = Math.max(0, Math.min(100, Math.round(Number(task.progress) || 0)));
    const cover = task.videoInfo?.cover ?? '';
    const rawTitle = task.title ?? task.videoInfo?.title ?? task.filename;
    const title = rawTitle === undefined || rawTitle === ''
      ? t('dashboard.drama.queueUntitled')
      : translateTitle(rawTitle);
    const size = task.receivedBytes !== undefined && task.totalBytes !== undefined && task.totalBytes > 0
      ? `${formatBytes(task.receivedBytes)} / ${formatBytes(task.totalBytes)}`
      : '';
    const meta = [
      task.downloadQuality !== undefined && task.downloadQuality !== ''
        ? t('dashboard.drama.queueQuality', { quality: task.downloadQuality })
        : undefined,
      size
    ].filter(Boolean).join(' · ');
    return (
      <li className={`drama-queue-item${compact ? ' drama-queue-child' : ''}`} key={task.id ?? `${title}-${index}`}>
        <div className="drama-queue-cover">
          {cover !== ''
            ? <img src={cover} alt="" loading="lazy" />
            : <div className="drama-cover-ph"><Film size={16} aria-hidden="true" /></div>}
        </div>
        <div className="drama-queue-body">
          <p className="drama-queue-title" title={title}>{title}</p>
          {meta !== '' ? <p className="drama-queue-meta">{meta}</p> : null}
          <div
            className={`drama-queue-bar drama-queue-bar-${key}`}
            role="progressbar"
            aria-label={title}
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
          {key === 'failed' && task.error !== undefined && task.error !== '' ? (
            <p className="drama-queue-error">{task.error}</p>
          ) : null}
          {key === 'completed' && task.savePath !== undefined && task.savePath !== '' ? (
            <div className="drama-queue-actions">
              <button
                type="button"
                className="drama-btn drama-btn-sm drama-queue-translate"
                onClick={() => openInTranslation(task, title)}
              >
                <Languages size={14} aria-hidden="true" />
                {t('dashboard.drama.queueTranslate')}
              </button>
              <button
                type="button"
                className="drama-btn drama-btn-sm"
                onClick={() => openInSocial(task, title)}
              >
                <Send size={14} aria-hidden="true" />
                {t('dashboard.social.handoff')}
              </button>
            </div>
          ) : null}
        </div>
        <div className="drama-queue-side">
          <span className={`drama-queue-status drama-queue-status-${key}`}>{statusLabel(task.status)}</span>
          {key === 'downloading' || key === 'pending' ? <span className="drama-queue-percent">{percent}%</span> : null}
        </div>
      </li>
    );
  }, [t, translateTitle, openInTranslation, openInSocial, statusLabel]);

  return (
    <BackendGate phase={phase} failure={failure} onRetry={() => void probe()} {...(props.onOpenRuntimeComponents === undefined ? {} : { onOpenRuntimeComponents: props.onOpenRuntimeComponents })}>
      <section className="drama-pane" aria-label={t('dashboard.drama.queueTitle')}>
        <div className="drama-pane-head">
          <div>
            <h2>{t('dashboard.drama.queueTitle')}</h2>
            <p className="drama-subtitle">{t('dashboard.drama.queueSubtitle')}</p>
          </div>
          <div className="drama-pane-actions">
            <button type="button" className="drama-btn" disabled={loading} onClick={() => void load(true)}>
              <RefreshCw size={14} aria-hidden="true" />
              {t('dashboard.drama.refresh')}
            </button>
          </div>
        </div>

        {tasks.length > 0 ? (
          <p className="drama-queue-summary" aria-live="polite">
            {t('dashboard.drama.queueSummary', { total: tasks.length, active: summary.active, done: summary.done })}
          </p>
        ) : null}

        {loading && tasks.length === 0 ? <DramaSpinner label={t('dashboard.drama.loading')} /> : null}

        {!loading && error !== '' ? (
          <DramaNotice
            tone="error"
            title={t('dashboard.drama.queueLoadFailed')}
            hint={error}
            actionLabel={t('dashboard.drama.retry')}
            onAction={() => void load(true)}
          />
        ) : null}

        {!loading && error === '' && tasks.length === 0 ? (
          <DramaNotice
            tone="info"
            title={t('dashboard.drama.queueEmpty')}
            hint={t('dashboard.drama.queueEmptyHint')}
          />
        ) : null}


  {tasks.length > 0 ? (
    <div className="drama-queue-groups">
      {groups.map(group => {
        const groupCover = group.tasks[0]!.videoInfo?.cover ?? '';
        const allDone = group.tasks.every(task => queueStatusKey(task.status) === 'completed');
        return group.tasks.length > 1 ? (
        <section className="drama-queue-group" key={group.key}>
          <div className="drama-queue-group-row">
            <button
              type="button"
              className="drama-queue-group-toggle"
              aria-expanded={expandedGroups.has(group.key)}
              onClick={() => toggleGroup(group.key)}
            >
              <span className="drama-queue-cover drama-queue-group-cover" aria-hidden="true">
                {groupCover !== ''
                  ? <img src={groupCover} alt="" loading="lazy" />
                  : <span className="drama-cover-ph"><Film size={15} aria-hidden="true" /></span>}
              </span>
              <span className="drama-queue-group-info">
                <span className="drama-queue-group-name" title={group.name}>
                  {group.name !== '' ? group.name : t('dashboard.drama.queueUntitled')}
                </span>
                <span className="drama-queue-group-summary">{group.tasks.length} {t('dashboard.drama.queueEpisodes')}</span>
              </span>
              <ChevronDown size={15} className={`drama-queue-chevron${expandedGroups.has(group.key) ? ' is-open' : ''}`} aria-hidden="true" />
            </button>
            {allDone ? (
              <button
                type="button"
                className="drama-btn drama-btn-sm drama-queue-translate drama-queue-group-translate-all"
                onClick={() => openSeriesInTranslation(group)}
              >
                <Languages size={14} aria-hidden="true" />
                {t('dashboard.drama.queueGroupTranslateAll')}
              </button>
            ) : null}
          </div>
          {expandedGroups.has(group.key) ? (
            <ul className="drama-queue-list drama-queue-children">
              {group.tasks.map((task, index) => renderTaskRow(task, index, true))}
            </ul>
          ) : null}
        </section>
      ) : (
        <ul className="drama-queue-list" key={group.key}>
          {renderTaskRow(group.tasks[0]!, 0, false)}
        </ul>
      );
      })}
    </div>
  ) : null}

        {downloadsRoot !== undefined ? (
          <p className="drama-foot-note">{t('dashboard.drama.downloadsNote', { path: downloadsRoot })}</p>
        ) : null}
      </section>
    </BackendGate>
  );
}

// ---------------------------------------------------------------------------
// Gợi ý hot
// ---------------------------------------------------------------------------

const HOT_FALLBACK = [
  ['hot-drama', 'Bảng xếp hạng hot'],
  ['hot-real-drama', 'Phim ngắn người thật'],
  ['hot-comic-drama', 'Phim hoạt hình'],
  ['hot-ai-drama', 'Phim ngắn AI']
] as const;

/** Mỗi lượt "Tải thêm" chỉ mở thêm số thẻ này để không render vài nghìn node cùng lúc. */
const HOT_VISIBLE_STEP = 60;

/** Gộp mục của trang mới vào danh sách đã có, bỏ trùng giữa các trang. */
function mergeHotItems(previous: HongguoDramaItem[], incoming: HongguoDramaItem[]): { list: HongguoDramaItem[]; added: number } {
  if (incoming.length === 0) return { list: previous, added: 0 };
  const seen = new Set(previous.map(item => String(item.series_id)));
  const fresh: HongguoDramaItem[] = [];
  for (const item of incoming) {
    if (seen.has(String(item.series_id))) continue;
    seen.add(String(item.series_id));
    fresh.push(item);
  }
  return { list: [...previous, ...fresh], added: fresh.length };
}

export function DramaHotPane(props: DramaPaneProps) {
  const { t, language } = useAppLanguage();
  const { service, phase, failure, downloadsRoot, probe } = useDramaBackend(props.runtimeDependencies);
  const [tabs, setTabs] = useState<Array<{ slug: string; label: string }>>(
    HOT_FALLBACK.map(([slug, label]) => ({ slug, label }))
  );
  const [category, setCategory] = useState('hot-drama');
  // Dữ liệu đã tải trước lúc app khởi động: hiển thị ngay thay vì chờ tải lại.
  const preloaded = useRef(dramaPreload.hot.get(dramaListKey(DRAMA_HOT_DEFAULT))).current;
  const [items, setItems] = useState<HongguoDramaItem[]>(filterHotItems(preloaded?.results));
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(preloaded?.totalPages ?? preloaded?.meta?.totalPages ?? 0);
  const [hasMore, setHasMore] = useState(preloaded?.hasMore === true);
  // Cửa sổ render: mỗi lượt chỉ vẽ thêm HOT_VISIBLE_STEP thẻ để danh sách cực dài
  // không phải dựng vài nghìn node cùng lúc.
  const [visibleCount, setVisibleCount] = useState(HOT_VISIBLE_STEP);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const listRequest = useRef(0);

  useEffect(() => {
    if (service === null) return;
    void probe();
    void service.getDramaCategories()
      .then(response => {
        const rankTabs = (response.categories ?? []).filter(item => item.slug.startsWith('hot-'));
        if (rankTabs.length > 0) setTabs(rankTabs.map(item => ({ slug: item.slug, label: item.label })));
      })
      .catch(() => undefined);
  }, [probe, service]);

  /** Đọc meta phân trang của một phản hồi browse (API có trả từng trang hay không). */
  const applyPagination = useCallback((response: HongguoDramaBrowseResponse) => {
    setTotalPages(response.totalPages ?? response.meta?.totalPages ?? 0);
    setHasMore(response.hasMore === true);
  }, []);

  const loadFirst = useCallback(async (forceRefresh: boolean) => {
    if (service === null) return;
    const cacheKey = dramaListKey({ source: 'hongguo', category, page: 1 });
    const request = ++listRequest.current;
    // Lượt mới đè lên mọi lượt "tải thêm" đang treo.
    setLoadingMore(false);
    // Có dữ liệu tải trước thì làm mới nền, không nháy vòng xoay.
    setLoading(dramaPreload.hot.get(cacheKey) === undefined);
    setError('');
    try {
      const response = await service.browseDrama({ source: 'hongguo', category, page: 1, forceRefresh });
      if (request !== listRequest.current) return;
      if (!response.success) {
        setItems([]);
        setPage(1);
        setVisibleCount(HOT_VISIBLE_STEP);
        setTotalPages(0);
        setHasMore(false);
        setError(response.error || t('dashboard.drama.loadFailed'));
        return;
      }
      dramaPreload.hot.set(cacheKey, response);
      setItems(filterHotItems(response.results));
      setPage(1);
      setVisibleCount(HOT_VISIBLE_STEP);
      applyPagination(response);
    } catch (cause) {
      if (request !== listRequest.current) return;
      setError(`${t('dashboard.drama.loadFailed')}: ${messageOf(cause)}`);
    } finally {
      if (request === listRequest.current) setLoading(false);
    }
  }, [applyPagination, category, service, t]);

  useEffect(() => {
    if (phase === 'ready') void loadFirst(false);
  }, [loadFirst, phase]);

  // API có trả trang tiếp theo hay không tự suy từ phản hồi: hasMore hoặc totalPages chưa tới.
  const morePages = hasMore || (totalPages > 0 && page < totalPages);

  const loadMore = useCallback(async () => {
    if (service === null || loadingMore) return;
    // Còn mục đã tải nhưng chưa vẽ: mở rộng cửa sổ render trước, không cần gọi mạng.
    if (visibleCount < items.length) {
      setVisibleCount(count => count + HOT_VISIBLE_STEP);
      return;
    }
    if (!morePages) return;
    const request = ++listRequest.current;
    setLoadingMore(true);
    try {
      const response = await service.browseDrama({ source: 'hongguo', category, page: page + 1 });
      if (request !== listRequest.current) return;
      if (!response.success) {
        setError(response.error || t('dashboard.drama.loadFailed'));
        return;
      }
      const merged = mergeHotItems(items, filterHotItems(response.results));
      setError('');
      setItems(merged.list);
      setPage(page + 1);
      setVisibleCount(count => count + HOT_VISIBLE_STEP);
      applyPagination(response);
      // Trang mới toàn mục trùng (bảng xếp hạng xáo trộn giữa hai lần gọi): ngừng đánh trang.
      if (merged.added === 0) setHasMore(false);
    } catch (cause) {
      if (request !== listRequest.current) return;
      setError(`${t('dashboard.drama.loadFailed')}: ${messageOf(cause)}`);
    } finally {
      if (request === listRequest.current) setLoadingMore(false);
    }
  }, [applyPagination, category, items, loadingMore, morePages, page, service, t, visibleCount]);

  const visibleItems = useMemo(() => items.slice(0, visibleCount), [items, visibleCount]);
  const hiddenLoaded = Math.max(0, items.length - visibleItems.length);
  const translateTitle = useDramaTitleTranslations(
    service,
    // Chỉ dịch tên đang hiển thị để gói dịch không vượt giới hạn 200 tên/lần gọi của daemon.
    useMemo(() => visibleItems.map(item => item.series_title), [visibleItems])
  );

  return (
    <BackendGate phase={phase} failure={failure} onRetry={() => void probe()} {...(props.onOpenRuntimeComponents === undefined ? {} : { onOpenRuntimeComponents: props.onOpenRuntimeComponents })}>
      <section className="drama-pane" aria-label={t('dashboard.drama.hotTitle')}>
        <div className="drama-pane-head">
          <div>
            <h2>{t('dashboard.drama.hotTitle')}</h2>
            <p className="drama-subtitle">{t('dashboard.drama.hotSubtitle')}</p>
          </div>
          <div className="drama-pane-actions">
            <button type="button" className="drama-btn" disabled={loading} onClick={() => void loadFirst(true)}>
              <RefreshCw size={14} aria-hidden="true" />
              {t('dashboard.drama.refresh')}
            </button>
          </div>
        </div>

        <div className="drama-cats" role="group" aria-label={t('dashboard.drama.rankings')}>
          {tabs.map(tab => (
            <button
              key={tab.slug}
              type="button"
              className={`drama-cat ${category === tab.slug ? 'drama-cat-active' : ''}`}
              aria-pressed={category === tab.slug}
              onClick={() => setCategory(tab.slug)}
            >
              {localizeDramaLabel(tab.label, language)}
            </button>
          ))}
        </div>

        {loading ? <DramaSpinner label={t('dashboard.drama.loading')} /> : null}
        {!loading && items.length === 0 ? (
          <DramaNotice
            tone={error === '' ? 'info' : 'error'}
            title={error === '' ? t('dashboard.drama.empty') : t('dashboard.drama.loadFailed')}
            {...(error === '' ? {} : { hint: error })}
            actionLabel={t('dashboard.drama.retry')}
            onAction={() => void loadFirst(true)}
          />
        ) : null}

        {!loading && visibleItems.length > 0 ? (
          <div className="drama-grid">
            {visibleItems.map((item, position) => (
              <button
                key={item.series_id}
                type="button"
                className="drama-card"
                title={translateTitle(item.series_title)}
                onClick={() => setDetailId(String(item.series_id))}
              >
                <div className="drama-cover">
                  <span className="drama-rank">
                    {typeof item.rank === 'number' && item.rank > 0
                      ? t('dashboard.drama.rank', { rank: item.rank })
                      : `#${position + 1}`}
                  </span>
                  {item.cover ? <img src={item.cover} alt="" loading="lazy" /> : <div className="drama-cover-ph"><Film size={20} aria-hidden="true" /></div>}
                  {item.episode_label !== undefined && item.episode_label !== ''
                    ? <span className="drama-ep-badge">{item.episode_label}</span>
                    : typeof item.episode_count === 'number' && item.episode_count > 0
                      ? <span className="drama-ep-badge">{t('dashboard.drama.episodes', { count: item.episode_count })}</span>
                      : null}
                </div>
                <div className="drama-card-title">{translateTitle(item.series_title)}</div>
                {item.completion_status === 'completed' ? <div className="drama-card-flag">{t('dashboard.drama.completionCompleted')}</div> : null}
                {item.completion_status === 'ongoing' ? <div className="drama-card-flag">{t('dashboard.drama.completionOngoing')}</div> : null}
                {item.heat !== undefined ? <div className="drama-card-heat">{item.heat}</div> : null}
                {(item.tags ?? []).length > 0 ? (
                  <div className="drama-card-tags">
                    {(item.tags ?? []).slice(0, 2).map(tag => <span key={tag} className="drama-tag">{localizeDramaLabel(tag, language)}</span>)}
                  </div>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}

        {!loading && error !== '' && visibleItems.length > 0 ? (
          <p className="drama-inline-error" role="alert">{error}</p>
        ) : null}

        {!loading && visibleItems.length > 0 ? (
          <div className="drama-pager">
            {hiddenLoaded > 0 || (visibleItems.length > 0 && morePages) ? (
              <button type="button" className="drama-pager-btn" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? <LoaderCircle className="drama-spin" size={14} aria-hidden="true" /> : null}
                {loadingMore ? t('dashboard.drama.hotLoadingMore') : t('dashboard.drama.hotLoadMore')}
              </button>
            ) : null}
            <span className="drama-pager-info" aria-live="polite">
              {t('dashboard.drama.hotShown', { shown: visibleItems.length, total: items.length })}{morePages ? '+' : ''}
            </span>
          </div>
        ) : null}

        {detailId !== null && service !== null ? (
          <DramaDetailDrawer
            service={service}
            seriesId={detailId}
            {...(downloadsRoot === undefined ? {} : { downloadsRoot })}
            onClose={() => setDetailId(null)}
          />
        ) : null}
      </section>
    </BackendGate>
  );
}
