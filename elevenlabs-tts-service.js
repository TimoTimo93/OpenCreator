const { VIETNAMESE_VOICES, VOICE_ID_MAP } = require('./elevenlabs-voices');

const DEFAULT_MODELS = {
  eleven_v4: { label: 'eleven_v4 (cơ bản)', stable: true },
  eleven_multilingual_v2: { label: 'eleven_multilingual_v2 (quốc tế)', stable: true },
  eleven_turbo_v2: { label: 'eleven_turbo_v2 (tốc độ)', stable: true },
  eleven_turbo_v2_5: { label: 'eleven_turbo_v2_5 (tối ưu)', stable: true },
};

const DEFAULT_OUTPUT_FORMATS = [
  { value: 'mp3_44100_128', label: 'MP3 44.1kHz 128kbps' },
  { value: 'mp3_44100_192', label: 'MP3 44.1kHz 192kbps' },
  { value: 'opus_48000_128', label: 'Opus 48kHz 128kbps' },
];

const ELEVENLABS_API_BASE = 'https://api.elevenlabs.io';
const ELEVENLABS_API_KEY_HEADER = 'xi-api-key';
const QUOTA_ERROR_CODES = [429, 402, 456];
const QUOTA_ERROR_KEYWORDS = ['quota_exceeded', 'rate_limit_exceeded', 'insufficient_quota', 'overloaded_error', 'resource_exhausted', 'rate_limit'];
const KEY_EXHAUST_COOLDOWN_MS = 15 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 120000;

class ElevenLabsTTS {
  constructor(config = {}) {
    this.config = {
      baseUrl: config.baseUrl || ELEVENLABS_API_BASE,
      apiKeys: this.normalizeApiKeys(config.apiKeys || []),
      defaultVoiceId: config.defaultVoiceId || null,
      defaultModel: config.model || 'eleven_multilingual_v2',
      defaultOutputFormat: config.defaultOutputFormat || 'mp3_44100_128',
      outputFormats: config.outputFormats || DEFAULT_OUTPUT_FORMATS,
      voiceSettings: config.voiceSettings || { stability: 0.5, similarityboost: 0.75, style: 0, useSpeakerBoost: true },
      enableLogging: config.enableLogging !== false,
      optimizeStreamingLatency: config.optimizeStreamingLatency ?? null,
      maxRetries: config.maxRetries || 3,
      cooldownTimer: null,
    };
    this.currentKeyIndex = 0;
    this.keyStatuses = new Map();
    this.apiKeys = this.config.apiKeys;
    for (let i = 0; i < this.apiKeys.length; i++) {
      this.keyStatuses.set(i, { status: 'active', expiresAt: 0 });
    }
  }

  normalizeApiKeys(keys) {
    if (!keys || keys.length === 0) return [];
    if (Array.isArray(keys)) {
      return keys.map(k => String(k).trim()).filter(k => k.length > 0);
    }
    return String(keys).split(',').map(k => k.trim()).filter(k => k.length > 0);
  }

  hasValidKeys() {
    for (const [idx, status] of this.keyStatuses.entries()) {
      if (status.status === 'active' && this.apiKeys[idx]) return true;
    }
    return false;
  }

  _getNextActiveKey() {
    if (!this.hasValidKeys()) {
      throw new Error('Không có API key hợp lệ nào để dùng. Vui lòng cấu hình ít nhất 1 API key.');
    }
    const totalKeys = this.apiKeys.length;
    for (let attempt = 0; attempt < totalKeys; attempt++) {
      const idx = (this.currentKeyIndex % totalKeys + attempt) % totalKeys;
      const status = this.keyStatuses.get(idx);
      if (status.status === 'active' && this.apiKeys[idx]) {
        this.currentKeyIndex = idx + 1;
        return { key: this.apiKeys[idx], index: idx };
      }
    }
    throw new Error('Tất cả API keys đều đang bảo trì, vui lòng thử lại sau');
  }

  _isQuotaError(error) {
    if (!error) return false;
    if (error.status && QUOTA_ERROR_CODES.includes(error.status)) return true;
    const message = (error.message || error.code || '').toLowerCase();
    const body = (error.body || '').toLowerCase();
    return QUOTA_ERROR_KEYWORDS.some(kw => message.includes(kw) || body.includes(kw));
  }

  async _handleQuotaError(error, currentKeyIndex) {
    if (!this._isQuotaError(error)) return;
    const idx = currentKeyIndex;
    const status = this.keyStatuses.get(idx);
    if (status && status.status === 'active') {
      status.status = 'exhausted';
      status.expiresAt = Date.now() + KEY_EXHAUST_COOLDOWN_MS;
      if (this.config.cooldownTimer) clearTimeout(this.config.cooldownTimer);
      this.config.cooldownTimer = setTimeout(() => {
        const s = this.keyStatuses.get(idx);
        if (s && s.status === 'exhausted') s.status = 'active';
      }, KEY_EXHAUST_COOLDOWN_MS);
      console.warn([ElevenLabsTTS] API key # quota exhausted, resting for ms);
    }
    throw error;
  }

  _buildRequestUrl(voiceId) {
    const url = new URL('/' + voiceId, this.config.baseUrl);
    url.searchParams.append('output_format', this.config.defaultOutputFormat);
    url.searchParams.append('enable_logging', String(this.config.enableLogging));
    if (this.config.optimizeStreamingLatency !== null) {
      url.searchParams.append('optimize_streaming_latency', String(this.config.optimizeStreamingLatency));
    }
    return url.toString();
  }

  _buildRequestBody(text, options = {}) {
    const body = {
      text: text || '',
      model_id: options.model || this.config.defaultModel,
    };
    if (options.voiceSettings && Object.keys(options.voiceSettings).length > 0) {
      body.voice_settings = options.voiceSettings;
    } else if (this.config.voiceSettings && Object.keys(this.config.voiceSettings).length > 0) {
      body.voice_settings = this.config.voiceSettings;
    }
    if (options.languageCode) body.language_code = options.languageCode;
    return body;
  }

  async _fetchAudio(voiceId, requestBody, options = {}) {
    const url = this._buildRequestUrl(voiceId);
    const { key, index } = this._getNextActiveKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), options.timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', [ELEVENLABS_API_KEY_HEADER]: key },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const errorBody = await response.text().catch(() => null);
        const error = new Error('HTTP ' + response.status + ': ' + (errorBody || response.statusText));
        error.status = response.status;
        if (errorBody) error.body = errorBody;
        await this._handleQuotaError(error, index);
        throw error;
      }
      return response;
    } catch (error) {
      clearTimeout(timeout);
      if (!error.name || error.name !== 'AbortError') {
        await this._handleQuotaError(error, index);
      }
      throw error;
    }
  }

  async generate(text, options = {}) {
    const {
      voiceId, model = this.config.defaultModel, voiceSettings = this.config.voiceSettings,
      languageCode = null, outputFormat = this.config.defaultOutputFormat, timeoutMs = DEFAULT_TIMEOUT_MS,
    } = options;
    const resolvedVoiceId = voiceId || this.config.defaultVoiceId || null;
    if (!resolvedVoiceId) {
      throw new Error('Không có voiceId được cấu hình. Vui lòng cung cấp voiceId hoặc cấu hình defaultVoiceId.');
    }
    if (!VOICE_ID_MAP[resolvedVoiceId]) {
      throw new Error('Voice ID không hợp lệ: ' + resolvedVoiceId);
    }
    const requestBody = this._buildRequestBody(text, { model, voiceSettings, languageCode });
    const response = await this._fetchAudio(resolvedVoiceId, requestBody, { timeoutMs, outputFormat });
    return response.arrayBuffer();
  }

  async generateBase64(text, options = {}) {
    const arrayBuffer = await this.generate(text, options);
    return Buffer.from(arrayBuffer).toString('base64');
  }

  async generateToFile(text, outputPath, options = {}) {
    const arrayBuffer = await this.generate(text, options);
    const fs = require('fs');
    fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));
    return outputPath;
  }

  async generateUrl(text, options = {}) {
    const base64 = await this.generateBase64(text, options);
    return 'data:audio/mpeg;base64,' + base64;
  }

  async fetchAvailableVoices() {
    const url = new URL('/voices', this.config.baseUrl);
    const { key, index } = this._getNextActiveKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), 15000);
    try {
      const response = await fetch(url.toString(), { method: 'GET', headers: { [ELEVENLABS_API_KEY_HEADER]: key }, signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  async fetchAvailableModels() {
    const url = new URL('/models', this.config.baseUrl);
    const { key, index } = this._getNextActiveKey();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Request timeout')), 15000);
    try {
      const response = await fetch(url.toString(), { method: 'GET', headers: { [ELEVENLABS_API_KEY_HEADER]: key }, signal: controller.signal });
      clearTimeout(timeout);
      if (!response.ok) {
        const error = new Error('HTTP ' + response.status);
        error.status = response.status;
        throw error;
      }
      return response.json();
    } catch (error) {
      clearTimeout(timeout);
      throw error;
    }
  }

  // Vietnamese voice management methods
  searchVietnameseVoices(query = '') {
    const normalizedQuery = query.toLowerCase().trim();
    const results = [];
    for (const voice of Object.values(VIETNAMESE_VOICES)) {
      const nameMatch = voice.name.toLowerCase().includes(normalizedQuery);
      const labelMatch = voice.label.toLowerCase().includes(normalizedQuery);
      const descMatch = (voice.description || '').toLowerCase().includes(normalizedQuery);
      if (nameMatch || labelMatch || descMatch) results.push(voice);
    }
    return results;
  }

  getVietnameseVoice(voiceIdOrName) {
    const normalized = voiceIdOrName.trim();
    if (VOICE_ID_MAP[normalized]) return VOICE_ID_MAP[normalized];
    for (const voice of Object.values(VIETNAMESE_VOICES)) {
      if (voice.name === normalized || voice.label === normalized) return voice;
    }
    return null;
  }

  getAllVietnameseVoices() {
    return Object.values(VIETNAMESE_VOICES);
  }

  updateApiKeys(newKeys) {
    this.apiKeys = this.normalizeApiKeys(newKeys);
    this.currentKeyIndex = 0;
    this.keyStatuses = new Map();
    for (let i = 0; i < this.apiKeys.length; i++) {
      this.keyStatuses.set(i, { status: 'active', expiresAt: 0 });
    }
    if (this.config.cooldownTimer) {
      clearTimeout(this.config.cooldownTimer);
      this.config.cooldownTimer = null;
    }
  }

  getKeyUsage() {
    const active = Array.from(this.keyStatuses.entries()).filter(([_, s]) => s.status === 'active').map(([idx]) => idx);
    const exhausted = Array.from(this.keyStatuses.entries()).filter(([_, s]) => s.status === 'exhausted').map(([idx]) => ({ index: idx, expiresAt: s.expiresAt }));
    return {
      totalKeys: this.apiKeys.length,
      activeKeys: active.length,
      activeIndices: active,
      exhaustedKeys: exhausted,
      rotationIndex: this.currentKeyIndex,
      vietnameseVoices: Object.values(VIETNAMESE_VOICES),
      totalVietnameseVoices: Object.keys(VIETNAMESE_VOICES).length,
    };
  }

  destroy() {
    if (this.config.cooldownTimer) {
      clearTimeout(this.config.cooldownTimer);
      this.config.cooldownTimer = null;
    }
  }
}

ElevenLabsTTS.VIETNAMESE_VOICES = VIETNAMESE_VOICES;
ElevenLabsTTS.VOICE_ID_MAP = VOICE_ID_MAP;
ElevenLabsTTS.DEFAULT_MODELS = DEFAULT_MODELS;
ElevenLabsTTS.DEFAULT_OUTPUT_FORMATS = DEFAULT_OUTPUT_FORMATS;

let instance = null;
function getElevenLabsTTS(config) {
  if (!instance) instance = new ElevenLabsTTS(config);
  return instance;
}

export { ElevenLabsTTS, getElevenLabsTTS, VIETNAMESE_VOICES, VOICE_ID_MAP, DEFAULT_MODELS, DEFAULT_OUTPUT_FORMATS, ELEVENLABS_API_BASE, ELEVENLABS_API_KEY_HEADER };
