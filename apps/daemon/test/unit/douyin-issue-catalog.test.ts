import { describe, expect, it } from 'vitest';
import { classifyDouyinChallenge } from '../../src/creator/download/issue-catalog.js';

describe('classifyDouyinChallenge', () => {
  it('classifies Signature Not Found error', () => {
    const stderr = 'ERROR: [Douyin+opencreator] 123: Douyin request signature is required (HTTP Error 403; Signature Not Found). The current downloader is incompatible with this platform verification; reconnecting cookies alone cannot fix it. Use a local video file.';
    const fact = classifyDouyinChallenge(stderr);
    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_request_signature_required');
    expect(fact?.kind).toBe('unsupported');
    expect(fact?.httpStatus).toBe(403);
    expect(fact?.message).toContain('browser request signature is not supported');
  });

  it('classifies Validate Error', () => {
    const stderr = 'ERROR: [Douyin+opencreator] 123: Douyin browser identity was rejected (HTTP Error 403; Validate Error). Website verification is required. Connect Douyin in Settings > Platform connections to complete verification (no sign-in required).';
    const fact = classifyDouyinChallenge(stderr);
    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_session_required');
    expect(fact?.kind).toBe('unauthorized');
    expect(fact?.httpStatus).toBe(403);
    expect(fact?.message).toContain('anti-bot captcha');
  });

  it('classifies slider captcha error', () => {
    const stderr = 'ERROR: [Douyin+opencreator] 123: Slider captcha triggered during download (HTTP Error 403)';
    const fact = classifyDouyinChallenge(stderr);
    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_session_required');
    expect(fact?.kind).toBe('unauthorized');
    expect(fact?.httpStatus).toBe(403);
    expect(fact?.message).toContain('anti-bot captcha');
  });

  it('classifies Uifid Not Found error', () => {
    const stderr = 'ERROR: [Douyin+opencreator] 123: Douyin browser identity was rejected (HTTP Error 403; Uifid Not Found). Connect Douyin in Settings > Platform connections and retry.';
    const fact = classifyDouyinChallenge(stderr);
    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_session_required');
    expect(fact?.kind).toBe('unauthorized');
    expect(fact?.httpStatus).toBe(403);
    expect(fact?.message).toContain('Settings > Platform connections');
  });

  it('classifies upstream Fresh cookies needed message', () => {
    const stderr = 'ERROR: [Douyin+opencreator] 123: Fresh cookies (not necessarily logged in) are needed';
    const fact = classifyDouyinChallenge(stderr);
    expect(fact).toBeDefined();
    expect(fact?.code).toBe('platform_session_required');
    expect(fact?.kind).toBe('unauthorized');
  });

  it('returns undefined for non-Douyin stderr', () => {
    const stderr = 'ERROR: [youtube] 123: Video unavailable';
    expect(classifyDouyinChallenge(stderr)).toBeUndefined();
  });
});
