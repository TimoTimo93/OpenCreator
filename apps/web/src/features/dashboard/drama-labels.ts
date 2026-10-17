import type { AppLanguage } from '../../i18n/language.js';

/**
 * Nhãn phân loại / thể loại / tag của các nguồn phim (Hồng Quả, Tây Phạn, Hà Mã)
 * vốn là tiếng Trung. Thành phần Hồng Quả đã Việt hóa phần lớn nhãn ngay tại
 * biên dữ liệu, nhưng vẫn còn sót các nhãn mới của nhà cung cấp. Bảng này là
 * lưới an toàn ở phía web: nhãn nào còn nguyên chữ Hán thì được dịch theo ngôn
 * ngữ giao diện đang chọn.
 */
type DramaLabelCopy = { vi: string; en: string };

export const dramaLabelTranslations: Readonly<Record<string, DramaLabelCopy>> = {
  // Hồng Quả
  惊悚: { vi: 'Giật gân', en: 'Thriller' },
  志怪: { vi: 'Kỳ dị', en: 'Strange tales' },
  剧情: { vi: 'Chính kịch', en: 'Drama' },
  成长: { vi: 'Trưởng thành', en: 'Coming of age' },
  家族: { vi: 'Gia tộc', en: 'Clan' },
  灾难: { vi: 'Thảm họa', en: 'Disaster' },
  动作冒险: { vi: 'Hành động phiêu lưu', en: 'Action adventure' },
  脑洞: { vi: 'Sáng tạo', en: 'Wild ideas' },
  末世: { vi: 'Tận thế', en: 'Post-apocalypse' },
  冒险: { vi: 'Phiêu lưu', en: 'Adventure' },
  综艺: { vi: 'Tạp kỹ', en: 'Variety shows' },
  // Tây Phạn
  打脸虐渣: { vi: 'Vả mặt trừ cặn', en: 'Face-slapping' },
  现代: { vi: 'Hiện đại', en: 'Modern' },
  强者回归: { vi: 'Cường giả trở về', en: 'Strongest returns' },
  亲情: { vi: 'Tình thân', en: 'Family bonds' },
  高手下山: { vi: 'Cao thủ xuống núi', en: 'Master leaves the mountain' },
  破镜重圆: { vi: 'Gương vỡ lại lành', en: 'Second chance love' },
  隐藏大佬: { vi: 'Đại lão ẩn thân', en: 'Hidden tycoon' },
  传承觉醒: { vi: 'Kế thừa thức tỉnh', en: 'Inheritance awakening' },
  追妻: { vi: 'Theo đuổi vợ', en: 'Winning the wife back' },
  反转: { vi: 'Đảo ngược', en: 'Plot twist' },
  先婚后爱: { vi: 'Cưới trước yêu sau', en: 'Marriage first' },
  家庭伦理: { vi: 'Luân lý gia đình', en: 'Family drama' },
  扮猪吃虎: { vi: 'Giả heo ăn hổ', en: 'Underdog rising' },
  小人物: { vi: 'Người nhỏ bé', en: 'Ordinary hero' },
  王妃: { vi: 'Vương phi', en: 'Princess consort' },
  天才: { vi: 'Thiên tài', en: 'Genius' },
  异能: { vi: 'Dị năng', en: 'Superpowers' },
  架空: { vi: 'Hư cấu', en: 'Fictional world' },
  '60集以下': { vi: 'Dưới 60 tập', en: 'Under 60 episodes' },
  '60~100集': { vi: '60–100 tập', en: '60–100 episodes' },
  '100集以上': { vi: 'Trên 100 tập', en: 'Over 100 episodes' },
  // Hà Mã
  女帝: { vi: 'Nữ đế', en: 'Empress' },
  民国: { vi: 'Dân Quốc', en: 'Republic era' },
  超能: { vi: 'Siêu năng', en: 'Superpower' },
  种田: { vi: 'Điền viên', en: 'Slice of life' },
  求生: { vi: 'Sinh tồn', en: 'Survival' },
  '2D漫': { vi: 'Hoạt hình 2D', en: '2D animation' },
  反派: { vi: 'Phản diện', en: 'Villain' },
  寻亲: { vi: 'Tìm người thân', en: 'Finding family' },
  律政: { vi: 'Luật chính', en: 'Legal' },
  宫女: { vi: 'Cung nữ', en: 'Palace maid' },
  权谋: { vi: 'Quyền mưu', en: 'Power struggle' },
  追夫火葬场: { vi: 'Truy phu hỏa táng tràng', en: 'Winning the husband back' },
  青梅竹马: { vi: 'Thanh mai trúc mã', en: 'Childhood sweethearts' },
  神话: { vi: 'Thần thoại', en: 'Mythology' },
  女高手下山: { vi: 'Nữ cao thủ xuống núi', en: 'Heroine leaves the mountain' },
  竞赛: { vi: 'Thi đấu', en: 'Competition' },
  偷听心声: { vi: 'Nghe trộm tiếng lòng', en: 'Mind reading' },
  废柴: { vi: 'Phế sài', en: 'Underdog' },
  公主: { vi: 'Công chúa', en: 'Princess' },
  古穿今: { vi: 'Cổ xuyên kim', en: 'Ancient to modern' },
  亲情剧: { vi: 'Phim tình thân', en: 'Family drama' },
  致富: { vi: 'Làm giàu', en: 'Getting rich' },
  奇幻脑洞: { vi: 'Kỳ ảo sáng tạo', en: 'Fantasy ideas' },
  系统: { vi: 'Hệ thống', en: 'System' },
  毒士: { vi: 'Độc sĩ', en: 'Scheming strategist' },
  追妻火葬场: { vi: 'Truy thê hỏa táng tràng', en: 'Winning the wife back' },
  马甲: { vi: 'Ẩn danh phận', en: 'Hidden identity' },
  无敌: { vi: 'Vô địch', en: 'Invincible' },
  弃少: { vi: 'Thiếu gia bị bỏ', en: 'Abandoned heir' },
  世情: { vi: 'Thế tình', en: 'Social drama' },
  功夫: { vi: 'Công phu', en: 'Kung fu' },
  皇后: { vi: 'Hoàng hậu', en: 'Empress consort' },
  小说漫: { vi: 'Hoạt hình tiểu thuyết', en: 'Novel adaptation' },
  玄学: { vi: 'Huyền học', en: 'Mysticism' },
  玄幻仙侠: { vi: 'Huyền ảo tiên hiệp', en: 'Fantasy cultivation' },
  包租公: { vi: 'Ông chủ cho thuê', en: 'Landlord' },
  庶女: { vi: 'Thứ nữ', en: 'Concubine-born daughter' },
  戏曲歌舞: { vi: 'Hí khúc ca vũ', en: 'Opera and dance' },
  民国剧: { vi: 'Phim Dân Quốc', en: 'Republic-era drama' },
  迪化: { vi: 'Địch hóa', en: 'Overthinking' },
  替身: { vi: 'Thế thân', en: 'Stand-in' },
  原配: { vi: 'Vợ cả', en: 'First wife' },
  神眼: { vi: 'Thần nhãn', en: 'All-seeing eyes' },
  长生: { vi: 'Trường sinh', en: 'Immortality' },
  暗恋: { vi: 'Đơn phương', en: 'Secret crush' },
  换亲: { vi: 'Đổi dâu', en: 'Bride swap' },
  抗战谍战: { vi: 'Kháng chiến điệp chiến', en: 'Wartime espionage' },
  电视剧: { vi: 'Phim truyền hình', en: 'TV series' },
  穿越时空: { vi: 'Xuyên không thời gian', en: 'Time travel' },
  真假千金: { vi: 'Thiên kim thật giả', en: 'Real and fake heiress' },
  中年婚恋: { vi: 'Hôn nhân trung niên', en: 'Midlife romance' },
  空间: { vi: 'Không gian', en: 'Dimensional space' },
  体育: { vi: 'Thể thao', en: 'Sports' },
  嫡女: { vi: 'Đích nữ', en: 'Legitimate daughter' },
  错认: { vi: 'Nhận nhầm', en: 'Mistaken identity' },
  鉴宝: { vi: 'Giám bảo', en: 'Antique appraisal' },
  厨神: { vi: 'Bếp thần', en: 'Master chef' },
  家庭主妇: { vi: 'Nội trợ', en: 'Housewife' },
  女总裁: { vi: 'Nữ tổng tài', en: 'Female CEO' },
  虐渣: { vi: 'Ngược cặn', en: 'Revenge on the wicked' },
  神豪: { vi: 'Thần hào', en: 'Super rich' },
  今古连通: { vi: 'Kim cổ kết nối', en: 'Past meets present' },
  古代言情: { vi: 'Ngôn tình cổ đại', en: 'Ancient romance' },
  师生情: { vi: 'Tình thầy trò', en: 'Teacher and student' },
  千金: { vi: 'Thiên kim', en: 'Heiress' },
  沙雕漫: { vi: 'Hoạt hình hài nhảm', en: 'Comedy animation' },
  婚姻: { vi: 'Hôn nhân', en: 'Marriage' },
  家国情仇: { vi: 'Gia quốc tình thù', en: 'Country and family feud' },
  中年: { vi: 'Trung niên', en: 'Midlife' },
  功夫武打: { vi: 'Công phu võ đả', en: 'Martial arts' },
  团宠: { vi: 'Đoàn sủng', en: 'Group favourite' },
  娱乐圈: { vi: 'Giới giải trí', en: 'Show business' },
  后悔流: { vi: 'Hối hận lưu', en: 'Regret' },
  富二代: { vi: 'Phú nhị đại', en: 'Rich second generation' },
  推文漫剧: { vi: 'Kịch truyện tranh', en: 'Promoted comic drama' },
  都市修仙: { vi: 'Tu tiên đô thị', en: 'Urban cultivation' },
  // Tag bổ sung thu hoạch từ nguồn Hồng Quả / Tây Phạn / Hà Mã
  '00年代': { vi: 'Thập niên 2000', en: '2000s' },
  '80年代': { vi: 'Thập niên 1980', en: '1980s' },
  一见钟情: { vi: 'Yêu từ cái nhìn đầu tiên', en: 'Love at first sight' },
  世子: { vi: 'Thế tử', en: 'Crown prince' },
  业界精英: { vi: 'Tinh anh ngành nghề', en: 'Industry elite' },
  乡村爱情: { vi: 'Tình yêu thôn quê', en: 'Rural romance' },
  偏门传奇: { vi: 'Truyền kỳ nghề lạ', en: 'Niche trade legend' },
  军事: { vi: 'Quân sự', en: 'Military' },
  千术对决: { vi: 'Đấu thuật cờ bạc', en: 'Gambling showdown' },
  友情岁月: { vi: 'Năm tháng tình bạn', en: 'Years of friendship' },
  双重生: { vi: 'Song trùng sinh', en: 'Double rebirth' },
  古装传奇: { vi: 'Truyền kỳ cổ trang', en: 'Costume legend' },
  商业联姻: { vi: 'Liên hôn thương mại', en: 'Business marriage' },
  大叔: { vi: 'Đại thúc', en: 'Older man' },
  奇幻爱情: { vi: 'Tình yêu kỳ ảo', en: 'Fantasy romance' },
  奉命下山: { vi: 'Vâng mệnh xuống núi', en: 'Called down the mountain' },
  女战神: { vi: 'Nữ chiến thần', en: 'Female war god' },
  女扮男装: { vi: 'Nữ giả nam trang', en: 'Girl disguised as boy' },
  姐弟恋: { vi: 'Tình chị em', en: 'Older woman romance' },
  婚姻经营: { vi: 'Vun đắp hôn nhân', en: 'Marriage management' },
  宠妻: { vi: 'Cưng chiều vợ', en: 'Doting husband' },
  家族振兴: { vi: 'Chấn hưng gia tộc', en: 'Family revival' },
  工地: { vi: 'Công trường', en: 'Construction site' },
  当明星: { vi: 'Làm ngôi sao', en: 'Becoming a star' },
  悬疑情感: { vi: 'Tình cảm ly kỳ', en: 'Mystery romance' },
  悬疑推理: { vi: 'Trinh thám ly kỳ', en: 'Mystery thriller' },
  惊悚灵异: { vi: 'Kinh dị tâm linh', en: 'Horror paranormal' },
  擂台比武: { vi: 'Tỷ võ đài', en: 'Arena duel' },
  无厘头: { vi: 'Hài vô lý', en: 'Absurd comedy' },
  日常: { vi: 'Đời thường', en: 'Slice of life' },
  时空之旅: { vi: 'Hành trình xuyên không', en: 'Time-space journey' },
  暴富: { vi: 'Phát tài chớp nhoáng', en: 'Sudden fortune' },
  替身文学: { vi: 'Văn học thế thân', en: 'Stand-in romance' },
  未来: { vi: 'Tương lai', en: 'Future' },
  权臣篡位: { vi: 'Quyền thần soán ngôi', en: 'Usurping minister' },
  治愈: { vi: 'Chữa lành', en: 'Healing' },
  热血: { vi: 'Nhiệt huyết', en: 'Passionate' },
  犯罪: { vi: 'Tội phạm', en: 'Crime' },
  职场员工: { vi: 'Nhân viên công sở', en: 'Office worker' },
  自我救赎: { vi: 'Tự cứu rỗi', en: 'Self-redemption' },
  规则怪谈: { vi: 'Quy tắc kỳ quái', en: 'Rules horror' },
  警匪刑侦: { vi: 'Cảnh sát hình sự', en: 'Police procedural' },
  财产争夺: { vi: 'Tranh đoạt tài sản', en: 'Inheritance battle' },
  轻喜剧: { vi: 'Hài nhẹ nhàng', en: 'Light comedy' },
  轻松搞笑: { vi: 'Hài hước thư giãn', en: 'Feel-good comedy' },
  重生逆袭: { vi: 'Trùng sinh nghịch tập', en: 'Rebirth comeback' },
  错位人生: { vi: 'Cuộc đời lệch nhịp', en: 'Mismatched life' },
  锦鲤: { vi: 'Cá chép may mắn', en: 'Lucky koi' },
  青春成长: { vi: 'Tuổi trẻ trưởng thành', en: 'Youth growth' },
  马甲文: { vi: 'Thân phận ẩn giấu', en: 'Hidden identity' },
  黄昏恋: { vi: 'Tình già', en: 'Twilight romance' },
  AI动漫: { vi: 'Hoạt hình AI', en: 'AI animation' }
};

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/** Nhãn tiếng Anh/tiếng Việt còn sót từ nguồn dữ liệu. */
const nonChineseLabels: Readonly<Record<string, DramaLabelCopy>> = {
  Shows: { vi: 'Tạp kỹ', en: 'Variety shows' },
  shows: { vi: 'Tạp kỹ', en: 'Variety shows' }
};

/**
 * Dịch một nhãn phân loại/thể loại/tag. Nhãn đã được Việt hóa từ thành phần
 * Hồng Quả giữ nguyên; nhãn còn chữ Hán (hoặc vài nhãn tiếng Anh sót lại) được
 * dịch theo ngôn ngữ giao diện.
 */
export function localizeDramaLabel(label: string | undefined, language: AppLanguage): string {
  const text = typeof label === 'string' ? label.trim() : '';
  if (text === '') return '';
  if (language === 'zh-CN') return text;
  const mapped = dramaLabelTranslations[text] ?? nonChineseLabels[text];
  if (mapped === undefined) return text;
  if (language === 'vi-VN') return mapped.vi;
  if (CJK.test(text)) return mapped.en;
  return text;
}

/** Dịch danh sách tag, bỏ trùng lặp và giữ tối đa `limit` phần tử. */
export function localizeDramaTags(tags: readonly string[] | undefined, language: AppLanguage, limit = 4): string[] {
  const out: string[] = [];
  for (const tag of tags ?? []) {
    const text = localizeDramaLabel(tag, language);
    if (text !== '' && !out.includes(text)) out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}
