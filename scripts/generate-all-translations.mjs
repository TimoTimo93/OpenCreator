import fs from 'node:fs';
import path from 'node:path';

const presetTranslations = {
  // --- 1 to 20 ---
  "images-go-hard-thumbnail": {
    title: "Thumbnail phim hành động chuẩn điện ảnh",
    description: "Tạo ảnh thu nhỏ YouTube đậm chất điện ảnh với bến thuyền hoàng hôn, hai nhân vật hành động và dòng chữ ba hàng nổi bật."
  },
  "acrylic-hand-painted-split-poster": {
    title: "Áp phích sơn acrylic vẽ tay ghép đôi",
    description: "Chia ảnh tải lên thành nửa trên ảnh chụp thực tế và nửa dưới tranh vẽ acrylic tối giản tỉ lệ 3:4."
  },
  "animated-campus-world-reference-board": {
    title: "Bảng tham chiếu thế giới học đường anime",
    description: "Tạo bảng tham chiếu anime 4 khung hình với nhân vật đồng nhất, ngoại cảnh trường học và phòng học."
  },
  "architecture-photo-concept-sketch-diptych": {
    title: "Áp phích đôi ảnh kiến trúc và bản phác thảo",
    description: "Ghép ảnh chụp công trình kiến trúc thực tế với bản vẽ phác thảo ý niệm tương ứng."
  },
  "bento-food-packaging-concept": {
    title: "Ý tưởng bao bì thực phẩm phong cách hộp Bento",
    description: "Thiết kế lại bao bì thực phẩm hoặc sản phẩm theo phong cách các ngăn bento tinh tế, gọn gàng."
  },
  "berry-smoothie-commercial-photo": {
    title: "Ảnh thương mại sinh tố quả mọng",
    description: "Chụp ảnh đồ uống sinh tố quả mọng với ánh sáng trau chuốt và chi tiết quảng cáo ẩm thực chân thực."
  },
  "beverage-food-marketing-hero": {
    title: "Hình ảnh chủ đạo tiếp thị thực phẩm & đồ uống",
    description: "Thiết kế hình ảnh quảng cáo thương mại bắt mắt cho đồ uống, thực phẩm đóng gói hoặc món đông lạnh."
  },
  "blue-white-dunhuang-embroidery-quadriptych": {
    title: "Áp phích tứ bình gốm lam, Đôn Hoàng & thêu tay",
    description: "Thể hiện một chủ thể qua 4 bức tranh lấy cảm hứng từ gốm hoa lam, bích họa Đôn Hoàng và thêu dệt truyền thống."
  },
  "botanical-plate": {
    title: "Tranh minh họa tiêu bản thực vật cổ điển",
    description: "Vẽ tranh minh họa thực vật cổ điển với các chi tiết phân loại hoa lá và chú thích khoa học."
  },
  "botanical-soda": {
    title: "Nhiếp ảnh tĩnh vật soda thảo mộc",
    description: "Tạo ảnh chụp sản phẩm soda thảo mộc tươi mát với giọt nước đọng sảng khoái và ánh sáng tự nhiên."
  },
  "boutique-ecommerce-product-flatlay-grid": {
    title: "Lưới chụp flatlay sản phẩm thương mại điện tử cao cấp",
    description: "Sắp xếp sản phẩm thời trang, phụ kiện thành lưới flatlay ngay ngắn, chuyên nghiệp cho sàn TMĐT."
  },
  "chinese-luxury-beauty-poster": {
    title: "Áp phích mỹ phẩm phong cách vương triều phương Đông",
    description: "Thiết kế áp phích làm đẹp cao cấp kết hợp yếu tố mỹ thuật phương Đông thanh nhã và ánh sáng sang trọng."
  },
  "cinematic-action-rpg-screenshot": {
    title: "Ảnh chụp màn hình game nhập vai hành động chuẩn điện ảnh",
    description: "Tạo ảnh chụp gameplay RPG hành động kịch tính với hiệu ứng ánh sáng, kỹ năng chiến đấu và góc máy hoành tráng."
  },
  "city-corner-3d-billboard-photography": {
    title: "Nhiếp ảnh biển quảng cáo 3D góc phố",
    description: "Mô phỏng biển quảng cáo LED 3D ngoài trời sống động ở góc phố sầm uất với hiệu ứng nổi chân thực."
  },
  "coastal-poster": {
    title: "Áp phích du lịch bờ biển mộng mơ",
    description: "Thiết kế áp phích du lịch phong cảnh biển với màu sắc thanh mát, bố cục thoáng đãng và gợi cảm hứng."
  },
  "concept-sofa-development-board": {
    title: "Bảng phát triển ý tưởng thiết kế sofa",
    description: "Trưng bày quá trình thiết kế ghế sofa từ bản phác thảo hình khối, vật liệu vải đến phối cảnh nội thất 3D."
  },
  "consistent-interior-multiview-grid": {
    title: "Lưới phối cảnh đa góc nhìn nội thất đồng nhất",
    description: "Tạo lưới hiển thị cùng một không gian nội thất từ nhiều góc máy khác nhau với phong cách ánh sáng đồng bộ."
  },
  "cooking-sketch-illustration-story": {
    title: "Truyện tranh phác thảo quy trình nấu ăn",
    description: "Kể câu chuyện chế biến món ăn qua chuỗi hình vẽ phác thảo ấm áp, sinh động và đầy cảm hứng."
  },
  "croissant-baking-storyboard": {
    title: "Phân cảnh quy trình nướng bánh sừng bò",
    description: "Phân cảnh chi tiết từng công đoạn nhào bột, cán bơ, tạo hình và nướng vàng rộm bánh croissant giòn xốp."
  },
  "deep-sea-freediving-adventure-photo": {
    title: "Ảnh phiêu lưu lặn tự do dưới đáy biển sâu",
    description: "Ghi lại khoảnh khắc thợ lặn tự do giữa đại dương sâu thẳm cùng đàn sinh vật biển và luồng sáng huyền ảo."
  },

  // --- 21 to 40 ---
  "desert-car-wash-documentary-photo": {
    title: "Ảnh tư liệu rửa xe giữa sa mạc",
    description: "Bức ảnh tư liệu giàu cảm xúc về trạm rửa xe giữa sa mạc hoang sơ với ánh nắng gắt và bụi cát."
  },
  "duotone-studio-commercial-portrait": {
    title: "Chân dung studio thương mại hai tông màu (Duotone)",
    description: "Chụp ảnh chân dung studio phong cách tương phản duotone ấn tượng, hiện đại cho tạp chí hoặc bìa album."
  },
  "exploded-food-infographic": {
    title: "Đồ họa phân rã cấu tạo món ăn",
    description: "Minh họa phân tách từng tầng nguyên liệu của món ăn bay lơ lửng trong không gian kèm nhãn chú thích khoa học."
  },
  "faithful-vintage-portrait-restoration": {
    title: "Phục chế chân dung ảnh cũ trung thực",
    description: "Phục chế và làm nét ảnh chân dung cổ điển, tái tạo màu da tự nhiên và chi tiết trang phục sắc nét."
  },
  "felt-country-miniature-world": {
    title: "Thế giới thu nhỏ bằng vải dạ nỉ thủ công",
    description: "Tạo thế giới tí hon ấm áp với nhà cửa, cây cối và muông thú được làm hoàn toàn từ chất liệu dạ nỉ thủ công."
  },
  "fifteen-step-photorealistic-recipe": {
    title: "Bộ công thức nấu ăn 15 bước chân thực",
    description: "Bộ ảnh hướng dẫn nấu ăn 15 bước chi tiết, rõ ràng từng thao tác với độ sắc nét và ánh sáng ẩm thực chuẩn mực."
  },
  "five-panel-cafe-character-collage": {
    title: "Ghép ảnh 5 khung nhân vật quán cà phê",
    description: "Tổ hợp 5 góc chụp nhân vật thư giãn tại quán cà phê với biểu cảm tự nhiên và tông màu ấm áp."
  },
  "food-splash-freeze-frame": {
    title: "Khoảnh khắc đóng băng giọt bắn món ăn",
    description: "Ghi lại khoảnh khắc tốc độ cao khi sốt, nước ngọt hoặc gia vị bắn tung tóe quanh món ăn đầy năng lượng."
  },
  "football-player-stats-doodle-poster": {
    title: "Áp phích cầu thủ bóng đá phong cách vẽ tay & chỉ số",
    description: "Thiết kế áp phích thể thao năng động kết hợp hình ảnh cầu thủ, nét vẽ graffiti và thông số trận đấu."
  },
  "four-city-minimal-travel-poster-series": {
    title: "Bộ áp phích du lịch tối giản bốn thành phố",
    description: "Bộ 4 áp phích du lịch phong cách tối giản tái hiện biểu tượng kiến trúc của các thành phố nổi tiếng."
  },
  "four-panel-milkshake-recipe": {
    title: "Công thức pha chế trà sữa / sinh tố 4 khung",
    description: "Minh họa 4 bước chuẩn bị nguyên liệu, xay trộn, rót ly và trang trí ly sinh tố thơm ngon."
  },
  "french-new-wave-torn-paper-poster": {
    title: "Áp phích xé giấy làn sóng mới điện ảnh Pháp",
    description: "Phong cách áp phích nghệ thuật Nouvelle Vague Pháp với hiệu ứng xé giấy, typography cổ điển và tông màu hoài niệm."
  },
  "futuristic-biophilic-atrium": {
    title: "Giếng trời sinh thái tương lai kết hợp thiên nhiên",
    description: "Phối cảnh 3D không gian giếng trời kiến trúc viễn tưởng tích hợp vườn treo sinh thái xanh mướt."
  },
  "graded-english-magazine-reading-page": {
    title: "Trang tạp chí đọc tiếng Anh phân cấp",
    description: "Thiết kế trang tạp chí học tiếng Anh chuẩn mực với bài đọc hấp dẫn, từ vựng và hình minh họa phong phú."
  },
  "grimm-fairy-tale-woodcut-poster": {
    title: "Áp phích khắc gỗ truyện cổ tích Grimm",
    description: "Tranh minh họa khắc gỗ thủ công mang đậm màu sắc huyền bí, cổ kính của thế giới cổ tích Grimm."
  },
  "half-photo-half-crayon-memory-card": {
    title: "Thẻ ký ức nửa ảnh chụp nửa tranh sáp màu",
    description: "Kết hợp độc đáo giữa ảnh chụp thực tế và nét vẽ nguệch ngoạc sáp màu trẻ thơ gợi nhắc kỷ niệm."
  },
  "hand-torn-paper-poster": {
    title: "Áp phích phong cách giấy xé thủ công",
    description: "Thiết kế áp phích sáng tạo với mép giấy xé tự nhiên, các lớp layer xếp chồng và bóng đổ chân thực."
  },
  "handwritten-photo-annotations": {
    title: "Ảnh chụp ghi chú chữ viết tay trang trí",
    description: "Thêm những nét vẽ tay, hình dán doodle và dòng chữ nhật ký mộc mạc lên bức ảnh đời sống hằng ngày."
  },
  "haute-couture-fashion-magazine-cover": {
    title: "Bìa tạp chí thời trang Haute Couture cao cấp",
    description: "Tạo bìa tạp chí thời trang đẳng cấp với người mẫu sang trọng, trang phục thiết kế tinh xảo và typography sắc nét."
  },
  "ink-double-exposure-portrait-poster": {
    title: "Áp phích chân dung thủy mặc phơi sáng kép",
    description: "Hòa quyện chân dung nghệ thuật với nét cọ thủy mặc mềm mại và phong cảnh thiên nhiên qua kỹ thuật phơi sáng kép."
  },

  // --- 41 to 60 ---
  "inplace-landmark-travel-sticker": {
    title: "Hình dán du lịch lồng ghép danh thắng",
    description: "Tạo nhãn dán sticker phong cách minh họa độc đáo lồng ghép trực tiếp vào ảnh chụp địa danh thực tế."
  },
  "inside-box-farm-ad-poster": {
    title: "Áp phích góc nhìn từ trong thùng nông sản nông trại",
    description: "Góc máy góc rộng nhìn từ đáy thùng gỗ hướng lên người nông dân đang thu hoạch hoa quả tươi dưới ánh nắng sớm."
  },
  "inside-cup-fisheye-summer-drink-ad": {
    title: "Quảng cáo đồ uống mùa hè góc mắt cá từ lòng cốc",
    description: "Góc nhìn mắt cá sáng tạo từ bên trong ly nước đá hướng lên bầu trời mùa hè và nụ cười rạng rỡ."
  },
  "isometric-miniature-kitchen": {
    title: "Căn bếp thu nhỏ trục đo đẳng cự (Isometric)",
    description: "Mô hình 3D căn bếp ấm cúng theo góc nhìn đẳng cự với đầy đủ dụng cụ nấu nướng và chi tiết tỉ mỉ."
  },
  "luxury-mechanical-watch-technical-guide": {
    title: "Bản vẽ kỹ thuật đồng hồ cơ xa xỉ",
    description: "Minh họa chi tiết các bánh răng, con lắc và cơ chế cơ khí phức tạp của chiếc đồng hồ đeo tay cao cấp."
  },
  "miniature-city-map-travel-poster": {
    title: "Áp phích bản đồ thành phố thu nhỏ du lịch",
    description: "Bản đồ minh họa 3D thu nhỏ các tuyến phố, địa danh nổi tiếng và phương tiện giao thông của thành phố du lịch."
  },
  "minimal-abstract-geometric-deconstruction-poster": {
    title: "Áp phích giải cấu trúc hình học trừu tượng tối giản",
    description: "Tác phẩm đồ họa trừu tượng kết hợp các mảng màu cân đối, đường nét thanh mảnh và tỷ lệ vàng hiện đại."
  },
  "minimal-conceptual-line-art-poster": {
    title: "Áp phích nghệ thuật vẽ nét ý niệm tối giản",
    description: "Tranh vẽ nét đơn tuyến tinh tế thể hiện thần thái nhân vật hoặc hình tượng ý niệm với phong cách Bauhaus."
  },
  "modern-art-event-flyer": {
    title: "Tờ rơi sự kiện nghệ thuật đương đại",
    description: "Thiết kế poster/flyer triển lãm nghệ thuật hiện đại với bố cục táo bạo, màu sắc tương phản và phong cách avant-garde."
  },
  "object-word-doodle-overlay": {
    title: "Lồng ghép chữ nghệ thuật thay thế vật thể",
    description: "Kỹ thuật sáng tạo thay thế đường nét của đồ vật bằng các từ ngữ typo hoặc hình vẽ doodle vui nhộn."
  },
  "paper-relief-neighborhood-grid": {
    title: "Lưới khu phố phù điêu cắt giấy nghệ thuật",
    description: "Tái hiện một khu phố nhộn nhịp dưới dạng phù điêu cắt giấy nhiều lớp với bóng đổ và chiều sâu tinh tế."
  },
  "pear-tart-storyboard": {
    title: "Phân cảnh bốn khung hình bánh tart lê",
    description: "Bốn khung hình quảng cáo bánh ngọt cao cấp ghi lại cận cảnh gọt lê, nướng bánh và rắc đường bột hấp dẫn."
  },
  "playful-ceramic-ecommerce-hero": {
    title: "Ảnh chủ đạo thương mại điện tử gốm sứ vui tươi",
    description: "Bộ ảnh sản phẩm đồ gốm sứ thủ công ngộ nghĩnh trên nền pastel tươi sáng thu hút người mua sắm online."
  },
  "polaroid-clay-travel-portrait": {
    title: "Ảnh du lịch Polaroid nhân vật đất sét",
    description: "Bức ảnh phong cách Polaroid chụp lại chú rối đất sét đáng yêu đang check-in tại các địa điểm du lịch."
  },
  "portrait-lighting-scheme-grid": {
    title: "Lưới sơ đồ bố trí ánh sáng chân dung nhiếp ảnh",
    description: "Bảng tổng hợp các kiểu ánh sáng chân dung kinh điển (Rembrandt, Butterfly, Split, Rim light) trực quan và chuẩn mực."
  },
  "premium-food-commercial-storyboard": {
    title: "Phân cảnh quảng cáo ẩm thực thương mại cao cấp",
    description: "Bảng phân cảnh TVC chuyên nghiệp ghi lại khoảnh khắc chế biến và trình bày món ăn đạt chuẩn sao Michelin."
  },
  "real-person-die-cut-sticker-poster": {
    title: "Áp phích hình dán sticker người thật bế khuôn",
    description: "Biến ảnh chân dung thành những nhãn dán sticker viền trắng bế khuôn nổi bật trên nền áp phích rực rỡ."
  },
  "reflective-ski-gear-landing-page": {
    title: "Trang đích đồ trượt tuyết phản quang cao cấp",
    description: "Thiết kế giao diện landing page thể thao mùa đông hiện đại tôn vinh trang phục và kính trượt tuyết phản quang."
  },
  "retro-halftone-illustration": {
    title: "Tranh minh họa hiệu ứng hạt Halftone cổ điển",
    description: "Chuyển đổi hình ảnh sang phong cách in ấn chấm hạt halftone cổ điển như trên các trang báo truyện tranh xưa."
  },
  "retro-scrapbook-poster": {
    title: "Bố cục áp phích sổ lưu niệm Scrapbook cổ điển",
    description: "Ghép nối những mẩu ảnh lưu niệm, vé tàu xe, hoa khô và băng dính washi theo phong cách sổ tay vintage."
  },

  // --- 61 to 80 ---
  "rio-travel-ticket-paper-diorama-poster": {
    title: "Áp phích mô hình giấy vé du lịch Rio de Janeiro",
    description: "Mô hình giấy 3D sống động của thành phố Rio với tượng Chúa Cứu Thế, bãi biển Copacabana và vé máy bay cổ điển."
  },
  "rubber-stamp-travel-field-notes": {
    title: "Nhật ký hành trình dấu mộc cao su du lịch",
    description: "Trang nhật ký khám phá với các con dấu bưu điện, dấu thị thực du lịch cổ và ghi chép hiện trường mộc mạc."
  },
  "same-face-twelve-hairstyles": {
    title: "Bộ sưu tập 12 kiểu tóc trên cùng một gương mặt",
    description: "Minh họa 12 phong cách tạo mẫu tóc khác nhau trên cùng một nhân vật giúp khách hàng dễ dàng lựa chọn kiểu tóc ưng ý."
  },
  "six-panel-miniature-beverage-ad": {
    title: "Quảng cáo đồ uống thế giới tí hon 6 khung hình",
    description: "Bộ 6 bức ảnh sáng tạo kết hợp lon nước giải khát với các nhân vật tí hon đang làm việc và vui chơi xung quanh."
  },
  "social-media-giveaway-banner": {
    title: "Banner sự kiện tặng quà mạng xã hội",
    description: "Thiết kế banner mini-game / give-away hấp dẫn, màu sắc bắt mắt kích thích tương tác trên Facebook, Instagram."
  },
  "solar-terms-editorial-visual": {
    title: "Thiết kế thị giác 24 tiết khí truyền thống",
    description: "Bộ minh họa nghệ thuật thể hiện vẻ đẹp biến chuyển của trời đất và phong tục qua 24 tiết khí trong năm."
  },
  "split-canvas-editorial-art-poster": {
    title: "Áp phích nghệ thuật phân tách khung tranh",
    description: "Bố cục nghệ thuật chia nhỏ bức tranh thành các mảng hình học độc đáo tạo trải nghiệm thị giác mới lạ."
  },
  "street-scroll-backdrop-fashion-editorial": {
    title: "Bộ ảnh thời trang phông nền cuộn tranh đường phố",
    description: "Người mẫu thời trang tạo dáng trước phông nền cuộn tranh phong cảnh đường phố độc đáo, giàu tính nghệ thuật."
  },
  "tech-product-review-thumbnail": {
    title: "Ảnh thu nhỏ đánh giá sản phẩm công nghệ",
    description: "Tạo thumbnail YouTube chuẩn chuyên nghiệp cho video mở hộp và đánh giá điện thoại, laptop, phụ kiện hi-tech."
  },
  "travel-souvenir-enamel-pin": {
    title: "Huy hiệu men lưu niệm du lịch tinh xảo",
    description: "Thiết kế huy hiệu cài áo tráng men kim loại cao cấp mang biểu tượng đặc trưng của vùng đất du lịch."
  },
  "vintage-city-travel-collage-portrait": {
    title: "Chân dung cắt dán du lịch thành phố hoài cổ",
    description: "Tác phẩm cắt dán nghệ thuật hòa trộn chân dung người lữ hành với các danh lam thắng cảnh và bản đồ cổ điển."
  },
  "vintage-scientific-botanical-poster": {
    title: "Áp phích thực vật học khoa học cổ điển thế kỷ 19",
    description: "Bản vẽ nghiên cứu thực vật chi tiết với rễ, thân, lá và hoa theo phong cách bản khắc kim loại thế kỷ 19."
  },
  "vr-headset-exploded-interface-diagram": {
    title: "Sơ đồ bóc tách kỹ thuật kính thực tế ảo VR",
    description: "Bản vẽ kỹ thuật bóc tách từng thấu kính, cảm biến, bo mạch và giao diện không gian 3D của thiết bị VR headset."
  },
  "watercolor-editorial-illustration-poster": {
    title: "Áp phích minh họa biên tập phong cách màu nước",
    description: "Tranh minh họa màu nước loang mềm mại, giàu cảm xúc thích hợp cho bìa sách báo và ấn phẩm văn hóa nghệ thuật."
  },
  "watercolor-travel-postcard": {
    title: "Bưu thiếp du lịch màu nước thủ công",
    description: "Thiết kế bưu thiếp lưu niệm vẽ tay bằng màu nước tái hiện khung cảnh phố cổ mộng mơ và lãng mạn."
  },
  "weekly-outfit-infographic": {
    title: "Đồ họa thông tin phối đồ thời trang cả tuần",
    description: "Bảng phối trang phục thời trang từ thứ Hai đến Chủ Nhật với gợi ý phụ kiện và phong cách thời thượng."
  },
  "wuhan-breakfast-food-map-infographic": {
    title: "Bản đồ ẩm thực ăn sáng Vũ Hán",
    description: "Bản đồ minh họa sinh động các món ăn sáng trứ danh như mì khô nóng, đậu bì và các quán ngon nổi tiếng."
  },
  "wuhan-vintage-map-poster": {
    title: "Áp phích bản đồ cổ thành phố Vũ Hán",
    description: "Tái hiện bản đồ sông nước và cầu đường Vũ Hán với phong cách hoài niệm cổ điển, viền trang trí tao nhã."
  },
  "y2k-streetwear-mobile-landing-page": {
    title: "Giao diện di động thời trang đường phố Y2K",
    description: "Thiết kế trang đích mua sắm trên điện thoại phong cách Y2K nổi loạn với gam màu neon, kim loại và đồ họa retro."
  },
  "y2k-virtual-try-on-game-ui": {
    title: "Giao diện game thử đồ ảo phong cách Y2K",
    description: "Giao diện trò chơi phối đồ thời trang ảo mang hơi hướng máy chơi game thập niên 2000 đầy hoài niệm."
  },

  // --- 81 to 108 (Video Presets) ---
  "aerial-pullback-rise-reveal": {
    title: "Cú máy flycam lùi xa bay cao hé lộ toàn cảnh",
    description: "Chuyển động camera flycam từ cận cảnh một chủ thể rồi lùi dần ra xa và bay vút lên cao hé mở cảnh quan kỳ vĩ."
  },
  "anime-skateboard-chase-nyc": {
    title: "Cuộc rượt đuổi trượt ván phong cách anime tại New York",
    description: "Cảnh phim hoạt hình anime tốc độ cao với nhân vật trượt ván lượn lách qua các góc phố sôi động của New York."
  },
  "beach-stone-stop-motion": {
    title: "Hoạt hình tĩnh vật cát đá bãi biển Stop-Motion",
    description: "Hoạt hình stop-motion mộc mạc với những viên sỏi bãi biển tự dịch chuyển và xếp thành những hình thù kỳ diệu."
  },
  "bedroom-falling-book-catch": {
    title: "Khoảnh khắc bắt cuốn sách rơi trong phòng ngủ",
    description: "Thước phim chuyển động chậm ghi lại khoảnh khắc nhân vật giơ tay đón lấy cuốn sách đang rơi trong phòng ngủ yên bình."
  },
  "bioluminescent-lighthouse-keeper": {
    title: "Người canh giữ ngọn hải đăng phát quang sinh học",
    description: "Thước phim điện ảnh kỳ ảo về ngọn hải đăng tỏa sáng huyền diệu giữa làn sóng biển phát quang sinh học ban đêm."
  },
  "brutalist-courtyard-martial-arts": {
    title: "Màn biểu diễn võ thuật trong sân kiến trúc Brutalism",
    description: "Động tác võ thuật dứt khoát, uyển chuyển giữa không gian sân bê tông khối hộp thô mộc chuẩn phong cách điện ảnh."
  },
  "cinematic-roller-skating-action": {
    title: "Màn trượt patin hành động chuẩn điện ảnh",
    description: "Chuỗi chuyển động trượt patin tốc độ cao đầy năng lượng với góc quay bám sát bánh xe và vệt sáng thành phố."
  },
  "cinematic-shaolin-action": {
    title: "Thước phim hành động võ tăng Thiếu Lâm",
    description: "Cảnh quay điện ảnh ghi lại bài quyền Thiếu Lâm dũng mãnh giữa khói sương mờ ảo nơi ngôi chùa cổ kính."
  },
  "cliffside-roller-skating": {
    title: "Màn trượt patin mạo hiểm bên bờ vực biển",
    description: "Cú máy ngoạn mục theo chân vận động viên trượt patin lướt trên con đường uốn lượn sát mép vực biển bao la."
  },
  "dolly-zoom-space-warp": {
    title: "Hiệu ứng Dolly Zoom bóp méo không gian (Vertigo)",
    description: "Kỹ thuật quay Vertigo huyền thoại: vừa tiến lại gần chủ thể vừa thu hẹp góc máy tạo cảm giác không gian biến dạng chóng mặt."
  },
  "drone-orbit-subject": {
    title: "Flycam bay lượn vòng tròn quanh chủ thể",
    description: "Cú máy drone mượt mà xoay 360 độ quanh nhân vật đứng trên đỉnh đồi hé lộ toàn cảnh thiên nhiên hùng vĩ."
  },
  "first-person-dragon-rider": {
    title: "Góc nhìn thứ nhất: Cưỡi rồng bay lượn giữa trời mây",
    description: "Trải nghiệm điện ảnh góc nhìn thứ nhất (FPV) cưỡi trên lưng rồng khổng lồ bay xuyên qua biển mây và hẻm núi hiểm trở."
  },
  "fixed-point-pan-right-reveal": {
    title: "Cố định góc máy xoay ngang sang phải mở ra khung cảnh",
    description: "Chuyển động Lia máy (Pan) chuẩn xác từ trái sang phải để dẫn dắt ánh nhìn và hé lộ chi tiết bất ngờ."
  },
  "japanese-influencer-get-ready-ugc": {
    title: "Vlog UGC chuẩn bị ra ngoài của Hot Girl Nhật Bản",
    description: "Video ngắn đời thường chân thực ghi lại các bước trang điểm, chọn đồ và dạo phố ngập tràn hơi thở Tokyo."
  },
  "khachapuri-overhead-cooking": {
    title: "Góc quay từ trên cao làm bánh mì phô mai Khachapuri",
    description: "Cảnh quay Top-Down cận cảnh nhồi bột, thả phô mai béo ngậy và đập lòng đỏ trứng vàng óng vào chiếc bánh nóng hổi."
  },
  "luxury-jewelry-unboxing": {
    title: "Quảng cáo mở hộp trang sức kim hoàn xa xỉ",
    description: "Thước phim thương mại sang trọng với ánh sáng lấp lánh phản chiếu từ hộp nhung và viên kim cương tinh xảo."
  },
  "nyc-parkour-web-swing": {
    title: "Pha bay nhảy parkour và đu dây giữa New York",
    description: "Cảnh hành động mãn nhãn kết hợp kỹ năng parkour trên các tòa nhà chọc trời và màn đu dây lướt gió như siêu anh hùng."
  },
  "rack-focus-foreground-background": {
    title: "Chuyển tiêu điểm Rack Focus tiền cảnh - hậu cảnh",
    description: "Kỹ thuật chuyển đổi độ sắc nét mượt mà từ chi tiết nhỏ ở tiền cảnh sang nhân vật xuất hiện ở hậu cảnh."
  },
  "rainforest-mysterious-light": {
    title: "Nguồn sáng bí ẩn trong rừng mưa nhiệt đới",
    description: "Thước phim khám phá khu rừng nguyên sinh cổ đại với những luồng sáng kỳ ảo chiếu xuyên qua tán cây rậm rạp."
  },
  "real-person-sticker-poster-motion": {
    title: "Chuyển động đồ họa áp phích nhãn dán người thật",
    description: "Hiệu ứng hoạt họa vui nhộn làm các miếng dán sticker người thật bật nảy, xoay vòng và biến đổi trên nền áp phích."
  },
  "recipe-infographic-cooking-sequence": {
    title: "Từ đồ họa công thức đến video nấu ăn thực tế",
    description: "Thước phim chuyển cảnh thông minh từ sơ đồ nguyên liệu đồ họa trực quan sang cảnh bếp lửa nấu ăn chân thực."
  },
  "retro-illustration-micro-motion": {
    title: "Chuyển động vi mô tranh minh họa cổ điển",
    description: "Thêm những chuyển động nhẹ nhàng, tinh tế (khói bay, mắt chớp, lá rơi) vào bức tranh vẽ minh họa phong cách vintage."
  },
  "sci-fi-motorcycle-action": {
    title: "Màn rượt đuổi mô tô phân khối lớn viễn tưởng",
    description: "Cảnh đua xe mô tô công nghệ cao lao vun vút qua thành phố tương lai rực rỡ ánh đèn neon dưới trời mưa đêm."
  },
  "seoul-sunday-dv-home-video": {
    title: "Thước phim gia đình máy quay DV chủ nhật Seoul",
    description: "Đoạn video phong cách băng từ DV cổ điển ghi lại những khoảnh khắc đời thường bình dị, ấm áp tại Seoul."
  },
  "sketch-to-real-stop-motion-cooking": {
    title: "Biến hình từ nét vẽ phác thảo thành món ăn thực tế",
    description: "Hoạt hình stop-motion ma thuật biến từng nét vẽ bút chì của đĩa thức ăn dần biến hóa thành món ăn thật nghi ngút khói."
  },
  "vertical-crane-reveal": {
    title: "Cú máy cẩu nâng thẳng đứng hé lộ không gian",
    description: "Chuyển động cẩu máy quay từ từ nâng lên theo phương thẳng đứng vượt qua chướng ngại vật để mở ra tầm nhìn bao la."
  },
  "watercolor-sketch-parkour-chase": {
    title: "Cuộc rượt đuổi Parkour nét vẽ ký họa màu nước",
    description: "Thước phim hoạt họa độc đáo kết hợp động tác parkour tràn đầy năng lượng với những vệt màu nước loang sống động."
  },
  "wildflower-seasons-macro-timelapse": {
    title: "Video tua nhanh thời gian (Timelapse) hoa dại bốn mùa",
    description: "Góc quay cận cảnh vi mô tuyệt đẹp ghi lại chu trình hoa dại đâm chồi, nở rộ và đón tuyết qua bốn mùa luân chuyển."
  }
};

const writingTemplateTranslations = {
  "community.sun-style-writing": {
    name: "Kỹ năng viết phong cách Sun-style",
    description: "Tự sự mật độ cao, nhịp điệu dồn dập, cộng hưởng cảm xúc mãnh liệt và khả năng quan sát sắc sảo."
  },
  "community.khazix-writer": {
    name: "Viết bài chuyên sâu phong cách Khazix",
    description: "Phân tích có chiều sâu, cấu trúc câu chuyện chặt chẽ, giọng văn đàm thoại chuyên nghiệp và lôi cuốn."
  },
  "community.research-paper-writing": {
    name: "Viết bài nghiên cứu học thuật",
    description: "Văn phong học thuật chuẩn mực, tổng hợp tài liệu phong phú, giải thích phương pháp luận và lập luận vững chắc."
  },
  "insight": {
    name: "Góc nhìn chuyên sâu",
    description: "Khám phá các xu hướng đầu ngành, đột phá công nghệ và bước chuyển chiến lược với tư duy sâu sắc."
  },
  "story": {
    name: "Kể chuyện & Tự sự",
    description: "Hành trình cá nhân truyền cảm hứng, câu chuyện nhà sáng lập và các bài học tình huống giàu cảm xúc."
  },
  "tutorial": {
    name: "Hướng dẫn thực hành",
    description: "Cẩm nang từng bước, kinh nghiệm thực chiến và quy trình làm việc cụ thể giúp áp dụng ngay."
  },
  "news-analysis": {
    name: "Phân tích tin tức nóng hổi",
    description: "Bình luận sắc bén, kịp thời về các sự kiện thời sự, biến động thị trường và các điểm nóng văn hóa."
  }
};

// Generate creator-preset-vi.ts
const code = `// Automatically generated Vietnamese translations for Creator Presets and Writing Templates
import type { CreatorPresetSummary } from '@opencreator/protocol';
import type { AppLanguage } from '../../i18n/language.js';

export interface LocalizedPresetInfo {
  title: string;
  description: string;
}

export const presetViMap: Readonly<Record<string, LocalizedPresetInfo>> = ${JSON.stringify(presetTranslations, null, 2)};

export const writingTemplateViMap: Readonly<Record<string, { name: string; description: string }>> = ${JSON.stringify(writingTemplateTranslations, null, 2)};

// Also map English titles directly for instant title-based lookup
export const presetEnglishTitleToViMap: Readonly<Record<string, string>> = {
${Object.entries(presetTranslations).map(([id, t]) => `  ${JSON.stringify(id)}: ${JSON.stringify(t.title)},`).join('\n')}
};

export function getLocalizedPresetTitle(
  preset: Pick<CreatorPresetSummary, 'id' | 'title'>,
  language: AppLanguage
): string {
  if (language !== 'vi-VN') return preset.title;
  const match = presetViMap[preset.id];
  if (match) return match.title;
  return preset.title;
}

export function getLocalizedPresetDescription(
  preset: Pick<CreatorPresetSummary, 'id' | 'description'>,
  language: AppLanguage
): string {
  if (language !== 'vi-VN') return preset.description;
  const match = presetViMap[preset.id];
  if (match) return match.description;
  return preset.description;
}

export function getLocalizedWritingTemplate(
  id: string,
  language: AppLanguage,
  fallback: { name: string; description: string }
): { name: string; description: string } {
  if (language !== 'vi-VN') return fallback;
  const match = writingTemplateViMap[id];
  if (match) return match;
  return fallback;
}
`;

fs.writeFileSync(
  path.resolve('apps/web/src/features/conversation/creator-preset-vi.ts'),
  code,
  'utf8'
);
console.log('Successfully generated apps/web/src/features/conversation/creator-preset-vi.ts');

// Also update vi-VN.json with preset titles, descriptions, and writing templates so translateEnglishCopy works everywhere
const viJsonPath = path.resolve('apps/web/src/i18n/locales/vi-VN.json');
const viJson = JSON.parse(fs.readFileSync(viJsonPath, 'utf8'));

// Read presets dump to link English titles and descriptions
const presetsDump = JSON.parse(fs.readFileSync('scripts/presets-dump.json', 'utf8'));
for (const p of presetsDump) {
  const trans = presetTranslations[p.id];
  if (trans) {
    if (p.titleEn && !viJson[p.titleEn]) {
      viJson[p.titleEn] = trans.title;
    }
    if (p.descEn && !viJson[p.descEn]) {
      viJson[p.descEn] = trans.description;
    }
  }
}

// Add writing templates
for (const [id, t] of Object.entries(writingTemplateTranslations)) {
  if (id === 'insight') viJson['Deep Insight'] = t.name;
  if (id === 'story') viJson['Narrative Storytelling'] = t.name;
  if (id === 'tutorial') viJson['Practical Tutorial'] = t.name;
  if (id === 'news-analysis') viJson['News Analysis'] = t.name;
  if (id === 'community.sun-style-writing') viJson['Sun-style Writing Skill'] = t.name;
  if (id === 'community.khazix-writer') viJson['Khazix Long-form WeChat Writing'] = t.name;
  if (id === 'community.research-paper-writing') viJson['Research Paper Writing'] = t.name;
}

// Ensure key category filters exist
viJson['All templates'] = 'Tất cả mẫu';
viJson['All'] = 'Tất cả';
viJson['Recent'] = 'Gần đây';
viJson['Recommended'] = 'Được đề xuất';
viJson['Video Creation'] = 'Sáng tạo video';
viJson['Image Design'] = 'Thiết kế hình ảnh';
viJson['Featured Templates'] = 'Mẫu tạo sẵn nổi bật';
viJson['Analysis'] = 'Quan điểm chuyên sâu';
viJson['Stories'] = 'Câu chuyện & Nhân vật';
viJson['Practical'] = 'Hướng dẫn thực tế';
viJson['News'] = 'Phân tích tin tức';
viJson['Popular'] = 'Phổ biến';
viJson['Community'] = 'Cộng đồng';
viJson['Technology'] = 'Công nghệ';
viJson['Finance'] = 'Tài chính';
viJson['Relationships'] = 'Tình cảm';
viJson['Workplace'] = 'Nơi làm việc';
viJson['Education'] = 'Giáo dục';
viJson['Research'] = 'Nghiên cứu';
viJson['Lifestyle'] = 'Đời sống';

fs.writeFileSync(viJsonPath, JSON.stringify(viJson, null, 2), 'utf8');
console.log('Successfully updated apps/web/src/i18n/locales/vi-VN.json with preset and template keys.');
