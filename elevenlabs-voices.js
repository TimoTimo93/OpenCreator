const VIETNAMESE_VOICES = {
  Giang: { id: 'f5q6kePPoQAjCPYG6moa', gender: 'female', label: 'Giang (Nữ)', name: 'Giang', genderLabel: 'Nữ', language: 'Vietnamese', description: 'Giang - Giọng đọc nữ, tự nhiên, rõ ràng' },
  Tham: { id: '0ggMuQ1r9f9jqBu50nJn', gender: 'female', label: 'Thắm (Nữ)', name: 'Thắm', genderLabel: 'Nữ', language: 'Vietnamese', description: 'Thắm - Giọng đọc nữ, sâu ấm, phù hợp cho audiobooks, narration' },
  Hiền: { id: 'jdlxsPOZOHdGEfcItXVu', gender: 'female', label: 'Hiền (Nữ)', name: 'Hiền', genderLabel: 'Nữ', language: 'Vietnamese', description: 'Hiền - Giọng đọc nữ, nhẹ nhàng, thân thiện' },
  Duc: { id: 'XBDAUT8ybuJTTCoOLSUj', gender: 'male', label: 'Đức (Nam)', name: 'Đức', genderLabel: 'Nam', language: 'Vietnamese', description: 'Đức - Giọng đọc nam, rõ ràng, phù hợp cho narration, bài thuyết trình' },
  Tung: { id: '3VnrjnYrskPMDsapTr8X', gender: 'male', label: 'Tùng (Nam)', name: 'Tùng', genderLabel: 'Nam', language: 'Vietnamese', description: 'Tùng - Giọng đọc nam, tự nhiên, khỏe khoắn' },
  Ninh: { id: 'aN7cv9yXNrfIR87bDmyD', gender: 'male', label: 'Ninh (Nam)', name: 'Ninh', genderLabel: 'Nam', language: 'Vietnamese', description: 'Ninh - Giọng đọc nam, nghẹn nồng, phù hợp cho storytelling, video' },
};

const VOICE_ID_MAP = {};
for (const [name, voice] of Object.entries(VIETNAMESE_VOICES)) {
  VOICE_ID_MAP[voice.id] = voice;
}

export { VIETNAMESE_VOICES, VOICE_ID_MAP };
