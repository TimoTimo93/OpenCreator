import { fireEvent, render, screen } from '@testing-library/react';
import {
  type CreatorArtifact,
  type CreatorJob,
  type CreatorJson,
  type CreatorResultSnapshot,
} from '@opencreator/protocol';
import { describe, expect, it, vi } from 'vitest';
import { LanguageProvider } from '../../i18n/LanguageProvider.js';
import { CreatorSessionProvider } from './creator-session-store.js';
import VideoTranslationWorkspace, {
  resultVersionsFromArtifacts,
} from './VideoTranslationWorkspace.js';

describe('VideoTranslationWorkspace Adversarial & Empirical Stress Suite (Milestone 2 - Requirement R2)', () => {
  // =========================================================================
  // 1. Initial Render of Empty Job State
  // =========================================================================
  it('adversarial test 1: initial render of completely empty job state contains all 7 R2 defaults', () => {
    const emptyJob: CreatorJob = {
      id: 'job_adv_empty',
      projectId: 'project_adv',
      templateId: 'video-translation',
      templateVersion: 2,
      status: 'draft',
      revision: 0,
      presetOrigin: null,
      state: {},
      agentThreadId: null,
      providerRequests: [],
      activities: [],
      artifacts: [],
      stages: [],
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    };

    render(
      <LanguageProvider initialPreference="zh-CN">
        <CreatorSessionProvider
          initialJob={emptyJob}
          service={{ applyAction: vi.fn(), runAgentTurn: vi.fn() } as never}
        >
          <VideoTranslationWorkspace onBack={vi.fn()} />
        </CreatorSessionProvider>
      </LanguageProvider>
    );

    // Initial step is Step 0: two explicit source choices, link input shown first
    expect(screen.getByRole('tab', { name: '选择最近下载的视频' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText('视频链接')).toBeInTheDocument();

    // Input URL to advance through wizard
    fireEvent.change(screen.getByLabelText('视频链接'), {
      target: { value: 'https://www.youtube.com/watch?v=adv_empty_1' },
    });

    // Advance to Step 1: 翻译设置
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('heading', { name: '设置翻译语言' })).toBeInTheDocument();

    // Verify Defaults 1 - 3:
    // 1. Source Language: zh_cn (Tiếng Trung)
    expect(screen.getByLabelText('源语言')).toHaveValue('zh_cn');
    // 2. Target Language: vi (Tiếng Việt)
    expect(screen.getByLabelText('翻译为')).toHaveValue('vi');
    // 3. Bilingual: false (Off)
    expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'false');

    // Advance to Step 2: 视频与字幕
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('heading', { name: '视频与字幕' })).toBeInTheDocument();

    // Verify Defaults 4 - 7:
    // 4. Compose Video with Subtitles: true (On)
    expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true');
    // 5. Subtitle Font: serif
    expect(screen.getByLabelText('字幕字体')).toHaveValue('serif');
    // 6. Subtitle Weight: medium
    expect(screen.getByLabelText('字幕字重')).toHaveValue('medium');
    // 7. Subtitle Size: medium
    expect(screen.getByLabelText('字幕大小')).toHaveValue('medium');
  });

  // =========================================================================
  // 2. Stress Test Source Switching
  // =========================================================================
  it('adversarial test 2: switching sources (URL -> File -> New URL -> Replacement File) retains defaults and customizations without clobbering', () => {
    const freshJob: CreatorJob = {
      id: 'job_adv_switch',
      projectId: 'project_adv',
      templateId: 'video-translation',
      templateVersion: 2,
      status: 'draft',
      revision: 0,
      presetOrigin: null,
      state: {},
      agentThreadId: null,
      providerRequests: [],
      activities: [],
      artifacts: [],
      stages: [],
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:00.000Z',
    };

    render(
      <LanguageProvider initialPreference="zh-CN">
        <CreatorSessionProvider
          initialJob={freshJob}
          service={{ applyAction: vi.fn(), runAgentTurn: vi.fn() } as never}
        >
          <VideoTranslationWorkspace onBack={vi.fn()} />
        </CreatorSessionProvider>
      </LanguageProvider>
    );

    // Step 0: Input URL
    fireEvent.change(screen.getByLabelText('视频链接'), {
      target: { value: 'https://www.youtube.com/watch?v=initial_url' },
    });

    // Step 1: Customize to non-defaults
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    fireEvent.change(screen.getByLabelText('源语言'), { target: { value: 'en' } });
    fireEvent.change(screen.getByLabelText('翻译为'), { target: { value: 'ja' } });
    fireEvent.click(screen.getByRole('switch', { name: '双语字幕' })); // toggle to true
    expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'true');

    // Step 2: Customize styles while composeVideo is true
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.change(screen.getByLabelText('字幕字体'), { target: { value: 'sans' } });
    fireEvent.change(screen.getByLabelText('字幕字重'), { target: { value: 'bold' } });
    fireEvent.change(screen.getByLabelText('字幕大小'), { target: { value: 'large' } });

    // Return to Step 0: switch source to local file
    fireEvent.click(screen.getByRole('button', { name: /添加视频/ }));
    const file1 = new File(['dummy binary 1'], 'clip1.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('上传本地视频'), { target: { files: [file1] } });

    // Navigate to Step 1: verify custom settings are preserved
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByLabelText('源语言')).toHaveValue('en');
    expect(screen.getByLabelText('翻译为')).toHaveValue('ja');
    expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'true');

    // Navigate to Step 2: verify custom settings are preserved
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('字幕字体')).toHaveValue('sans');
    expect(screen.getByLabelText('字幕字重')).toHaveValue('bold');
    expect(screen.getByLabelText('字幕大小')).toHaveValue('large');

    // Return to Step 0: clear the current file source and switch back to a new URL
    fireEvent.click(screen.getByRole('button', { name: /添加视频/ }));
    fireEvent.click(screen.getByRole('button', { name: '清除当前视频来源' }));

    // Now URL input is visible again
    fireEvent.change(screen.getByLabelText('视频链接'), {
      target: { value: 'https://www.youtube.com/watch?v=second_url' },
    });

    // Navigate to Step 1 & 2: verify custom settings remain intact across file-to-url transition
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByLabelText('源语言')).toHaveValue('en');
    expect(screen.getByLabelText('翻译为')).toHaveValue('ja');
    expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('字幕字体')).toHaveValue('sans');
    expect(screen.getByLabelText('字幕字重')).toHaveValue('bold');
    expect(screen.getByLabelText('字幕大小')).toHaveValue('large');

    // Return to Step 0: upload a replacement file
    fireEvent.click(screen.getByRole('button', { name: /添加视频/ }));
    const file2 = new File(['dummy binary 2'], 'clip2.mp4', { type: 'video/mp4' });
    fireEvent.change(screen.getByLabelText('上传本地视频'), { target: { files: [file2] } });

    // Navigate and check again
    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByLabelText('源语言')).toHaveValue('en');
    expect(screen.getByLabelText('翻译为')).toHaveValue('ja');
    expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(screen.getByRole('button', { name: '继续' }));
    expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByLabelText('字幕字体')).toHaveValue('sans');
    expect(screen.getByLabelText('字幕字重')).toHaveValue('bold');
    expect(screen.getByLabelText('字幕大小')).toHaveValue('large');
  });

  // =========================================================================
  // 3. Stress Test Partial Snapshot Loading
  // =========================================================================
  describe('adversarial test 3: partial snapshot loading fallback behavior', () => {
    const mockSubtitleArtifact: CreatorArtifact = {
      id: 'target_sub_1',
      jobId: 'job_partial',
      kind: 'target_subtitle',
      version: 1,
      status: 'completed',
      path: '/tmp/target.srt',
      scopeKey: null,
      inputFingerprint: null,
      sha256: null,
      sourceArtifactIds: [],
      metadata: {
        resultVersion: 1,
        fileName: 'target.srt',
        cues: [{ id: 1, start: '00:00:00,000', end: '00:00:02,000', text: 'Chào mừng' }],
      },
      createdAt: '2026-10-15T00:00:00.000Z',
    };

    it('3A: snapshot providing ONLY 2 settings (sourceLanguage + targetLanguage) falls back other 5 to R2 defaults', () => {
      const snapshot: CreatorResultSnapshot = {
        version: 1,
        createdAt: '2026-10-15T00:00:00.000Z',
        action: 'create-result',
        stageId: 'subtitle',
        description: 'V1 snapshot',
        artifactRefs: {
          target_subtitle: ['target_sub_1'],
        },
        changedArtifactIds: ['target_sub_1'],
        staleArtifactIds: [],
        state: {
          sourceLanguage: 'fr',
          targetLanguage: 'de',
          // bilingual, composeVideo, subtitleFont, subtitleWeight, subtitleSize are completely omitted
        },
      };

      const fallbackState: Record<string, CreatorJson> = {
        resultSnapshots: [snapshot as unknown as CreatorJson],
      };

      const versions = resultVersionsFromArtifacts([mockSubtitleArtifact], fallbackState);
      expect(versions).toHaveLength(1);
      const version = versions[0]!;

      // Explicitly provided:
      expect(version.settings.sourceLanguage).toBe('fr');
      expect(version.settings.targetLanguage).toBe('de');

      // The other 5 must fall back to R2 defaults:
      expect(version.settings.bilingual).toBe(false);
      expect(version.settings.composeVideo).toBe(true);
      expect(version.settings.subtitleFont).toBe('serif');
      expect(version.settings.subtitleWeight).toBe('medium');
      expect(version.settings.subtitleSize).toBe('medium');
    });

    it('3B: snapshot providing ONLY bilingual=true and composeVideo=false falls back remaining 5 to R2 defaults', () => {
      const snapshot: CreatorResultSnapshot = {
        version: 1,
        createdAt: '2026-10-15T00:00:00.000Z',
        action: 'create-result',
        stageId: 'subtitle',
        description: 'V1 snapshot',
        artifactRefs: {
          target_subtitle: ['target_sub_1'],
        },
        changedArtifactIds: ['target_sub_1'],
        staleArtifactIds: [],
        state: {
          bilingual: true,
          composeVideo: false,
          // sourceLanguage, targetLanguage, subtitleFont, subtitleWeight, subtitleSize are omitted
        },
      };

      const fallbackState: Record<string, CreatorJson> = {
        resultSnapshots: [snapshot as unknown as CreatorJson],
      };

      const versions = resultVersionsFromArtifacts([mockSubtitleArtifact], fallbackState);
      expect(versions).toHaveLength(1);
      const version = versions[0]!;

      // Explicitly provided:
      expect(version.settings.bilingual).toBe(true);
      expect(version.settings.composeVideo).toBe(false);

      // The other 5 must fall back to R2 defaults:
      expect(version.settings.sourceLanguage).toBe('zh_cn');
      expect(version.settings.targetLanguage).toBe('vi');
      expect(version.settings.subtitleFont).toBe('serif');
      expect(version.settings.subtitleWeight).toBe('medium');
      expect(version.settings.subtitleSize).toBe('medium');
    });

    it('3C: snapshot providing ONLY subtitleStyle.fontPreset=rounded falls back remaining settings to R2 defaults', () => {
      const snapshot: CreatorResultSnapshot = {
        version: 1,
        createdAt: '2026-10-15T00:00:00.000Z',
        action: 'create-result',
        stageId: 'subtitle',
        description: 'V1 snapshot',
        artifactRefs: {
          target_subtitle: ['target_sub_1'],
        },
        changedArtifactIds: ['target_sub_1'],
        staleArtifactIds: [],
        state: {
          subtitleStyle: {
            fontPreset: 'rounded',
          },
        },
      };

      const fallbackState: Record<string, CreatorJson> = {
        resultSnapshots: [snapshot as unknown as CreatorJson],
      };

      const versions = resultVersionsFromArtifacts([mockSubtitleArtifact], fallbackState);
      expect(versions).toHaveLength(1);
      const version = versions[0]!;

      expect(version.settings.subtitleFont).toBe('rounded');
      expect(version.settings.subtitleWeight).toBe('medium'); // R2 default
      expect(version.settings.subtitleSize).toBe('medium');   // R2 default
      expect(version.settings.sourceLanguage).toBe('zh_cn'); // R2 default
      expect(version.settings.targetLanguage).toBe('vi');    // R2 default
      expect(version.settings.bilingual).toBe(false);        // R2 default
      expect(version.settings.composeVideo).toBe(true);      // R2 default
    });

    it('3D: snapshot with totally empty state falls back all 7 parameters to R2 defaults', () => {
      const snapshot: CreatorResultSnapshot = {
        version: 1,
        createdAt: '2026-10-15T00:00:00.000Z',
        action: 'create-result',
        stageId: 'subtitle',
        description: 'V1 empty snapshot',
        artifactRefs: {
          target_subtitle: ['target_sub_1'],
        },
        changedArtifactIds: ['target_sub_1'],
        staleArtifactIds: [],
        state: {},
      };

      const fallbackState: Record<string, CreatorJson> = {
        resultSnapshots: [snapshot as unknown as CreatorJson],
      };

      const versions = resultVersionsFromArtifacts([mockSubtitleArtifact], fallbackState);
      expect(versions).toHaveLength(1);
      const version = versions[0]!;

      expect(version.settings.sourceLanguage).toBe('zh_cn');
      expect(version.settings.targetLanguage).toBe('vi');
      expect(version.settings.bilingual).toBe(false);
      expect(version.settings.composeVideo).toBe(true);
      expect(version.settings.subtitleFont).toBe('serif');
      expect(version.settings.subtitleWeight).toBe('medium');
      expect(version.settings.subtitleSize).toBe('medium');
    });

    it('3E: legacy artifacts without snapshot fall back all 7 parameters to R2 defaults', () => {
      const legacySubtitleArtifact: CreatorArtifact = {
        id: 'target_sub_legacy',
        jobId: 'job_legacy',
        kind: 'target_subtitle',
        version: 1,
        status: 'completed',
        path: '/tmp/legacy.srt',
        scopeKey: null,
        inputFingerprint: null,
        sha256: null,
        sourceArtifactIds: [],
        metadata: {
          resultVersion: 1,
          fileName: 'legacy.srt',
          cues: [{ id: 1, start: '00:00:00,000', end: '00:00:01,000', text: 'Hello' }],
        },
        createdAt: '2026-10-15T00:00:00.000Z',
      };

      const versions = resultVersionsFromArtifacts([legacySubtitleArtifact], {});
      expect(versions).toHaveLength(1);
      const version = versions[0]!;

      expect(version.settings.sourceLanguage).toBe('zh_cn');
      expect(version.settings.targetLanguage).toBe('vi');
      expect(version.settings.bilingual).toBe(false);
      expect(version.settings.composeVideo).toBe(true);
      expect(version.settings.subtitleFont).toBe('serif');
      expect(version.settings.subtitleWeight).toBe('medium');
      expect(version.settings.subtitleSize).toBe('medium');
    });

    it('3F: session store hydration with partial state renders supplied fields and falls back the rest to R2 defaults', () => {
      const partialJob: CreatorJob = {
        id: 'job_partial_hydration',
        projectId: 'project_adv',
        templateId: 'video-translation',
        templateVersion: 2,
        status: 'draft',
        revision: 1,
        presetOrigin: null,
        state: {
          sourceUrl: 'https://www.youtube.com/watch?v=partial_hydration',
          sourceLanguage: 'es', // Only sourceLanguage provided
          currentStep: 1,
          furthestStep: 1,
        },
        agentThreadId: null,
        providerRequests: [],
        activities: [],
        artifacts: [],
        stages: [],
        createdAt: '2026-10-15T00:00:00.000Z',
        updatedAt: '2026-10-15T00:00:00.000Z',
      };

      render(
        <LanguageProvider initialPreference="zh-CN">
          <CreatorSessionProvider
            initialJob={partialJob}
            service={{ applyAction: vi.fn(), runAgentTurn: vi.fn() } as never}
          >
            <VideoTranslationWorkspace onBack={vi.fn()} />
          </CreatorSessionProvider>
        </LanguageProvider>
      );

      // Verify Step 1:
      expect(screen.getByLabelText('源语言')).toHaveValue('es'); // Supplied
      expect(screen.getByLabelText('翻译为')).toHaveValue('vi');  // Fallback to R2 default
      expect(screen.getByRole('switch', { name: '双语字幕' })).toHaveAttribute('aria-checked', 'false'); // Fallback to R2 default

      // Navigate to Step 2:
      fireEvent.click(screen.getByRole('button', { name: '继续' }));
      expect(screen.getByRole('switch', { name: '合成字幕视频' })).toHaveAttribute('aria-checked', 'true'); // Fallback to R2 default
      expect(screen.getByLabelText('字幕字体')).toHaveValue('serif');   // Fallback to R2 default
      expect(screen.getByLabelText('字幕字重')).toHaveValue('medium');  // Fallback to R2 default
      expect(screen.getByLabelText('字幕大小')).toHaveValue('medium');  // Fallback to R2 default
    });
  });
});
