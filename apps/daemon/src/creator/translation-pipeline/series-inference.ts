/**
 * Suy seriesKey từ tiêu đề cho các luồng nạp KHÔNG truyền key cùng lúc nạp
 * (nạp tệp thủ công "Mở tệp video có sẵn trên máy", composer trang web cũ...).
 *
 * Chỉ nhận THẺ 《tên phim》 — dấu này mã hoá chính xác tên bộ nên không chấp
 * trường hợp hiapse nhầm video lẻ có tên kết thúc bằng số (vd "review 1.mp4").
 *
 * Trả về undefined nếu không suy được (m mục lẻ — giữ hành vi cũ: nạp đăng
 * tung tập kii dịch xong, không chờ ghpe.
 */
export function inferSeriesKeyFromTitle(title: string | undefined): string | undefined {
  const cleaned = (title ?? '').trim();
  if (cleaned === '') return undefined;
  const match = cleaned.match(/《(.+?)》/);
  const name = (match?.[1] ?? '').trim();
  if (name === '') return undefined;
  return `title:${name}`;
}
