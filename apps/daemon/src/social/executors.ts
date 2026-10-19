/**
 *Executors mặc định của Social Automation: mỗi nền tảng một bot thực thi qua
 * trình duyệt Patchright (YT/TikTok) hoặc Graph API (Facebook graph mode).
 */
import { uploadFacebook } from './platforms/facebook.js';
import { uploadTikTokStudio } from './platforms/tiktok.js';
import { uploadYoutubeStudio } from './platforms/youtube.js';
import type { PlatformExecutors } from './worker.js';

export const defaultSocialExecutors: PlatformExecutors = {
  youtube: uploadYoutubeStudio,
  tiktok: uploadTikTokStudio,
  facebook: uploadFacebook
};
