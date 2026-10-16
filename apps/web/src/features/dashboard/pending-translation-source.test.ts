import { describe, expect, it } from 'vitest';
import {
  peekPendingTranslationSource,
  setPendingTranslationSource,
  takePendingTranslationSource
} from './pending-translation-source.js';

describe('pending translation source', () => {
  it('hands a queued download over exactly once', () => {
    takePendingTranslationSource();
    expect(peekPendingTranslationSource()).toBeUndefined();

    setPendingTranslationSource({ path: 'D:\\downloads\\a.mp4', title: 'A' });
    expect(peekPendingTranslationSource()).toEqual({ path: 'D:\\downloads\\a.mp4', title: 'A' });

    expect(takePendingTranslationSource()).toEqual({ path: 'D:\\downloads\\a.mp4', title: 'A' });
    expect(takePendingTranslationSource()).toBeUndefined();
  });
});
