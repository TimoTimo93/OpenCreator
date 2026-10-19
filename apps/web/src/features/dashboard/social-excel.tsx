import { useMemo, useRef, useState } from 'react';
import { FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react';
import type { Translate } from '../../i18n/LanguageProvider.js';
import type { SocialClusterSummary, SocialEnqueueItem } from '../../services/social-service.js';
import './social-workspace.css';

/**
 * GĐ3 — Nhập video hàng loạt từ Excel (.xlsx) hoặc CSV vào hàng đợi đa kênh.
 * Parse hoàn toàn phía web; chỉ gửi SocialEnqueueItem đã hợp lệ lên daemon.
 */

export type SocialExcelRow = {
  cluster: string;
  path: string;
  title: string;
  description: string;
  scheduledAt: string;
  thumbnailPath: string;
};

type ColumnAlias = { cluster: string[]; path: string[]; title: string[]; description: string[]; scheduledAt: string[]; thumbnailPath: string[] };

const COLUMN_ALIASES: ColumnAlias = {
  cluster: ['cluster', 'cum', 'cụm', 'clusterName', 'cluster_name', 'nhom', 'nhóm'],
  path: ['path', 'video', 'file', 'videoPath', 'video_path'],
  title: ['title', 'tieu de', 'tiêu đề', 'jobTitle'],
  description: ['description', 'mo ta', 'mô tả', 'desc'],
  scheduledAt: ['scheduledat', 'scheduled_at', 'time', 'hẹn', 'hen', 'gio', 'giờ', 'scheduledAt'],
  thumbnailPath: ['thumbnail', 'thumbnailpath', 'thumbnail_path', 'anh', 'ảnh']
};

/** Hàng lệnh theo tên cột chấp nhận dấu/không dấu/VI-EN. */
function aliasOf(header: string): keyof ColumnAlias | null {
  const normalized = header.trim().toLowerCase().replace(/[_\s-]+/g, '_');
  for (const [key, aliases] of Object.entries(COLUMN_ALIASES) as Array<[keyof ColumnAlias, string[]]>) {
    for (const alias of aliases) {
      const aliasNormalized = alias.toLowerCase().replace(/[_\s-]+/g, '_').replace(/à|á|ả|ã|ạ/g, 'a').replace(/è|é|ẻ|ẽ|ẹ/g, 'e').replace(/ì|í|ỉ|ĩ|ị/g, 'i').replace(/ò|ó|ỏ|õ|ọ/g, 'o').replace(/ù|ú|ủ|ũ|ụ/g, 'u');
      if (normalized === aliasNormalized || normalized === alias.toLowerCase()) return key;
    }
  }
  return null;
}

/** Lấy tên cột theo index từ dòng header. */
function headerIndexes(headerRow: unknown[]): Array<keyof ColumnAlias | null> {
  return headerRow.map(cell => typeof cell === 'string' ? aliasOf(cell) : null);
}

function cellText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value.trim();
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

export function rowsToSocialItems(headerRow: unknown[], dataRows: unknown[][]): { rows: SocialExcelRow[]; invalid: number } {
  const keys = headerIndexes(headerRow);
  const rows: SocialExcelRow[] = [];
  let invalid = 0;
  for (const raw of dataRows) {
    const row: SocialExcelRow = { cluster: '', path: '', title: '', description: '', scheduledAt: '', thumbnailPath: '' };
    raw.forEach((cell, index) => {
      const key = keys[index] ?? null;
      if (key === null) return;
      row[key] = key === 'scheduledAt' ? formatExcelDate(cell) : cellText(cell);
    });
    if (row.path === '' || row.cluster === '') {
      invalid += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, invalid };
}

/** Excel có thể trả ngày dạng Date/hàng số "dd/MM HH:mm" — chuẩn hoá ISO nhẹ nhàng. */
function formatExcelDate(cell: unknown): string {
  const text = cellText(cell);
  if (text === '') return '';
  // dd/MM/yyyy (hoặc dd/MM) + HH:mm → ISO cục bộ.
  const match = text.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?\s+(\d{1,2}):(\d{2})$/);
  if (match !== null) {
    const day = match[1]!.padStart(2, '0');
    const month = match[2]!.padStart(2, '0');
    const year = match[3] ?? String(new Date().getFullYear());
    return `${year}-${month}-${day}T${match[4]!.padStart(2, '0')}:${match[5]}:00`;
  }
  return text;
}

/** CSV có dấu phẩy trong ngoặc kép — viết parser nhỏ cho gọn. */
export function parseCsvToRows(raw: string): unknown[][] {
  const rows: unknown[][] = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  const text = raw.replace(/^\uFEFF/, '');
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (inQuotes) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index += 1; }
        else inQuotes = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') { inQuotes = true; continue; }
    if (char === ',') { row.push(cell); cell = ''; continue; }
    if (char === '\n') { row.push(cell); cell = ''; rows.push(row); row = []; continue; }
    if (char === '\r') continue;
    cell += char;
  }
  if (cell !== '' || row.length > 0) { row.push(cell); rows.push(row); }
  return rows.filter(entry => entry.some(value => String(value ?? '').trim() !== ''));
}

export async function parseExcelFile(file: File): Promise<{ rows: SocialExcelRow[]; invalid: number }> {
  if (/\.(csv|txt)$/i.test(file.name)) {
    const text = await file.text();
    const table = parseCsvToRows(text);
    if (table.length === 0) return { rows: [], invalid: 0 };
    return rowsToSocialItems(table[0]!, table.slice(1));
  }
  // .xlsx — SheetJS: dynamic import để trì hoãn tải bundle.
  const buffer = await file.arrayBuffer();
  const xlsxModule = await import('xlsx');
  const workbook = xlsxModule.read(buffer, { type: 'array' });
  const sheet = workbook.Sheets[workbook.SheetNames[0]!];
  if (sheet === undefined) return { rows: [], invalid: 0 };
  const table = xlsxModule.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: false, defval: '' });
  if (table.length === 0) return { rows: [], invalid: 0 };
  return rowsToSocialItems(table[0]!, table.slice(1));
}

export function matchClusterByName(clusters: SocialClusterSummary[], name: string): SocialClusterSummary | null {
  const needle = name.trim().toLowerCase();
  const found = clusters.find(candidate =>
    candidate.seriesName.trim().toLowerCase() === needle || candidate.name.trim().toLowerCase() === needle);
  return found ?? null;
}

export const SOCIAL_EXCEL_TEMPLATE_CSV = [
  'cluster,path,title,description,hẹn,thumbnail',
  'Web Phim Hay,"D:/videos/tap-1.mp4",Tập 1,Giới thiệu bộ phim,20/10 19:30,',
  'Web Phim Hay,"D:/videos/tap-2.mp4",Tập 2,,21/10 19:30,'
].join('\n');

export function ExcelImportButton(props: {
  clusters: SocialClusterSummary[];
  t: Translate;
  onEnqueueMany(items: SocialEnqueueItem[], summaryEnqueued: string): void;
  onError(message: string): void;
}) {
  const { t } = props;
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    fileName: string;
    rows: SocialExcelRow[];
    invalid: number;
    resolved: Array<{ item: SocialEnqueueItem | null; clusterLabel: string }>;
  } | null>(null);

  const resolvedPreview = useMemo(() => {
    if (preview === null) return [];
    return preview.rows.map(row => {
      const cluster = matchClusterByName(props.clusters, row.cluster);
      if (cluster === null) {
        return { item: null, clusterLabel: row.cluster };
      }
      return {
        item: {
          clusterId: cluster.id,
          path: row.path,
          ...(row.title !== '' ? { title: row.title } : {}),
          ...(row.description !== '' ? { description: row.description } : {}),
          ...(row.scheduledAt !== '' ? { scheduledAt: row.scheduledAt } : {}),
          ...(row.thumbnailPath !== '' ? { thumbnailPath: row.thumbnailPath } : {})
        } as SocialEnqueueItem,
        clusterLabel: cluster.seriesName !== '' ? cluster.seriesName : cluster.name
      };
    });
  }, [preview, props.clusters]);

  async function handleFile(file: File): Promise<void> {
    setBusy(true);
    try {
      const parsed = await parseExcelFile(file);
      setPreview({ fileName: file.name, rows: parsed.rows, invalid: parsed.invalid, resolved: [] });
    } catch (cause) {
      props.onError(t('dashboard.social.excelParseFailed', { message: messageOfLocal(cause) }));
    } finally {
      setBusy(false);
    }
  }

  const resolvable = resolvedPreview.filter(entry => entry.item !== null);
  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept=".xlsx,.xls,.csv,.txt"
        style={{ display: 'none' }}
        onClickCapture={event => { (event.target as HTMLInputElement).value = ''; }}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file !== undefined) void handleFile(file);
        }}
      />
      <button
        type="button"
        className="social-btn social-btn-sm"
        disabled={busy || props.clusters.length === 0}
        onClick={() => inputRef.current?.click()}
      >
        {busy ? <LoaderCircle size={12} className="social-spin" aria-hidden="true" /> : <FileSpreadsheet size={12} aria-hidden="true" />}
        {t('dashboard.social.excelImport')}
      </button>
      <button
        type="button"
        className="social-btn social-btn-sm"
        onClick={() => downloadTemplate()}
      >
        <Upload size={12} aria-hidden="true" /> {t('dashboard.social.excelTemplate')}
      </button>
      {preview !== null ? (
        <div className="social-modal-mask" role="dialog" aria-modal="true">
          <div className="social-modal social-modal-wide">
            <h2>{t('dashboard.social.excelPreview', { count: preview.rows.length, file: preview.fileName })}</h2>
            {preview.invalid > 0 ? <p className="social-warn-text">{t('dashboard.social.excelInvalidRows', { count: preview.invalid })}</p> : null}
            <div className="social-excel-preview">
              <table>
                <thead>
                  <tr><th>{t('dashboard.social.excelColCluster')}</th><th>{t('dashboard.social.excelColPath')}</th><th>{t('dashboard.social.excelColTitle')}</th><th>{t('dashboard.social.excelColSchedule')}</th></tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => {
                    const resolved = resolvedPreview[index];
                    return (
                      <tr key={index} className={resolved?.item === null ? 'social-excel-row-invalid' : ''}>
                        <td>{resolved?.clusterLabel ?? row.cluster}</td>
                        <td title={row.path}>{row.path}</td>
                        <td>{row.title}</td>
                        <td>{row.scheduledAt}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="social-modal-actions">
              <button type="button" className="social-btn" onClick={() => setPreview(null)}>{t('dashboard.drama.close')}</button>
              <button
                type="button"
                className="social-btn social-btn-primary"
                disabled={resolvable.length === 0}
                onClick={() => {
                  props.onEnqueueMany(resolvable.map(entry => entry.item!),
                    t('dashboard.social.excelEnqueued', {
                      accepted: resolvable.length,
                      total: preview.rows.length + preview.invalid
                    }));
                  setPreview(null);
                }}
              >
                <Upload size={14} aria-hidden="true" /> {t('dashboard.social.excelConfirm', { count: resolvable.length })}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export function downloadTemplate(): void {
  const blob = new Blob([`\uFEFF${SOCIAL_EXCEL_TEMPLATE_CSV}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = 'opencreator-social-template.csv';
  anchor.click();
  URL.revokeObjectURL(url);
}

function messageOfLocal(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== '') return error.message;
  return String(error ?? 'unknown');
}
