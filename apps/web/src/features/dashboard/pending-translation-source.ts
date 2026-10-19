/**
 * One-shot hand-off used when the download queue wants the Translate & Dub
 * workspace to open with an already-downloaded video. The queue stores the local
 * path and navigates to the translation workbench; the workspace consumes it on
 * mount and reads the file through the desktop shell.
 */
export type PendingTranslationSource = {
  /** Absolute path of the downloaded media file on the local disk. */
  path: string;
  /** Display title of the queue task, used for notices. */
  title?: string;
  /**
   * Thông tin bộ phim khi tập thuộc một series (tùy chọn). Workspace dùng nó
   * (hoặc tự dò từ hàng đợi tải) để đề nghị "Thêm cả bộ" các tập đã tải.
   */
  series?: {
    id?: string;
    title?: string;
  };
};

let pending: PendingTranslationSource | undefined;

export function setPendingTranslationSource(value: PendingTranslationSource): void {
  pending = value;
}

export function takePendingTranslationSource(): PendingTranslationSource | undefined {
  const value = pending;
  pending = undefined;
  return value;
}

export function peekPendingTranslationSource(): PendingTranslationSource | undefined {
  return pending;
}
