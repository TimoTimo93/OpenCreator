/**
 * Hand-off một lần dùng cho nút "Đăng đa kênh" từ hàng đợi tải phim: lưu đường
 * dẫn video đã tải xong rồi điều hướng sang workspace social-channels; màn
 * hình này tiêu thụ trên mount (take) để mở hộp thoại xếp hẹn đăng.
 */
export type PendingSocialHandoffSource = {
  /** Đường dẫn tuyệt đối của file media trên đĩa. */
  path: string;
  /** Tiêu đề hiển thị của task tải, dùng làm mặc định khi xếp hẹn. */
  title?: string;
};

let pending: PendingSocialHandoffSource | undefined;

export function setPendingSocialHandoffSource(value: PendingSocialHandoffSource): void {
  pending = value;
}

export function takePendingSocialHandoffSource(): PendingSocialHandoffSource | undefined {
  const value = pending;
  pending = undefined;
  return value;
}

export function peekPendingSocialHandoffSource(): PendingSocialHandoffSource | undefined {
  return pending;
}
