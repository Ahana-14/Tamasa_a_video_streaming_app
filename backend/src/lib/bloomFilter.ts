/**
 * A Bloom filter: a compact set that answers "definitely not in the set" or "maybe in the set".
 * It never forgets an added item (no false negatives); it sometimes says "maybe" for an item that was never added
 * (a false positive, at the rate it was sized for). It cannot remove items.
 */
export class BloomFilter {
  private readonly bits: Uint8Array;
  readonly bitCount: number;
  readonly hashCount: number;
  private added = 0;

  /** Sized for `expectedItems` with a false-positive rate near `falsePositiveRate`. */
  constructor(expectedItems: number, falsePositiveRate = 0.01) {
    const n = Math.max(1, Math.floor(expectedItems));
    // Standard formulas: m = -n ln p / (ln 2)^2 bits, k = (m / n) ln 2 hashes.
    this.bitCount = Math.max(64, Math.ceil((-n * Math.log(falsePositiveRate)) / Math.LN2 ** 2));
    this.hashCount = Math.max(1, Math.round((this.bitCount / n) * Math.LN2));
    this.bits = new Uint8Array(Math.ceil(this.bitCount / 8));
  }

  get size() {
    return this.added;
  }

  add(item: string) {
    const [h1, h2] = hashes(item);
    for (let i = 0; i < this.hashCount; i++) {
      const bit = position(h1, h2, i, this.bitCount);
      this.bits[bit >>> 3]! |= 1 << (bit & 7);
    }
    this.added++;
  }

  /** false = certainly never added; true = probably added. */
  mightContain(item: string): boolean {
    const [h1, h2] = hashes(item);
    for (let i = 0; i < this.hashCount; i++) {
      const bit = position(h1, h2, i, this.bitCount);
      if ((this.bits[bit >>> 3]! & (1 << (bit & 7))) === 0) return false;
    }
    return true;
  }
}

// Two independent 32-bit hashes (FNV-1a and a murmur-style mix); the k probe positions are derived from them
// (Kirsch-Mitzenmacher double hashing), which is as good as k separate hashes for a Bloom filter.
const hashes = (item: string): [number, number] => {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < item.length; i++) {
    const c = item.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
    b >>>= 0;
  }
  return [a, (b | 1) >>> 0]; // odd, so the steps cover the whole table
};

const position = (h1: number, h2: number, i: number, bitCount: number) => ((h1 + Math.imul(i, h2)) >>> 0) % bitCount;
