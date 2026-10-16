import { describe, expect, test } from 'bun:test';
import { BloomFilter } from './bloomFilter';

describe('BloomFilter', () => {
  test('never forgets an added item', () => {
    const f = new BloomFilter(10_000, 0.01);
    const names = Array.from({ length: 10_000 }, (_, i) => `user_${i}`);
    for (const n of names) f.add(n);
    expect(names.every((n) => f.mightContain(n))).toBe(true);
  });

  test('false positives stay near the configured rate', () => {
    const f = new BloomFilter(10_000, 0.01);
    for (let i = 0; i < 10_000; i++) f.add(`user_${i}`);
    let wrong = 0;
    for (let i = 0; i < 20_000; i++) if (f.mightContain(`never_added_${i}`)) wrong++;
    expect(wrong / 20_000).toBeLessThan(0.02);
  });

  test('an empty filter says no to everything', () => {
    const f = new BloomFilter(100);
    expect(f.mightContain('anyone')).toBe(false);
  });
});
