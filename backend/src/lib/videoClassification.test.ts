import { describe, expect, test } from 'bun:test';
import { classifyVideoFormat, SHORT_MAX_DURATION } from './videoClassification';

const clip = (durationSec: number, width: number, height: number) =>
  classifyVideoFormat({ durationMs: durationSec * 1000, width, height });

describe('classifyVideoFormat', () => {
  test('the Shorts limit is 3 minutes', () => {
    expect(SHORT_MAX_DURATION).toBe(180_000);
  });
  test('a vertical video up to 3 minutes is a Short (including between 60 s and 180 s)', () => {
    expect(clip(45, 1080, 1920)).toBe('SHORT_FORM');
    expect(clip(120, 1080, 1920)).toBe('SHORT_FORM');
    expect(clip(180, 1080, 1920)).toBe('SHORT_FORM');
  });
  test('a vertical video longer than 3 minutes is a normal video', () => {
    expect(clip(181.5, 1080, 1920)).toBe('LONG_FORM');
    expect(clip(600, 1080, 1920)).toBe('LONG_FORM');
  });
  test('square counts, widescreen never does, however short', () => {
    expect(clip(100, 1080, 1080)).toBe('SHORT_FORM');
    expect(clip(30, 1920, 1080)).toBe('LONG_FORM');
  });
  test('unknown values fall back to a normal video', () => {
    expect(clip(0, 1080, 1920)).toBe('LONG_FORM');
    expect(clip(60, 0, 0)).toBe('LONG_FORM');
  });
});
