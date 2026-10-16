import { BloomFilter } from '../lib/bloomFilter';
import { prisma } from '../config/db';

/**
 * Answers "is this username probably taken?" from memory, so the sign-up screen's live check does not query the
 * database for every keystroke. A Bloom filter holds every existing username (lower-cased):
 *   - "definitely not in the filter"  -> the name is free, with no database call;
 *   - "maybe in the filter"           -> the database decides (a rare extra lookup).
 * The database stays the authority: saving a username still checks the table and its unique constraint, so a stale
 * answer here can only make the live hint wrong for a moment, never let two people share a name.
 * The filter is rebuilt from the table every few minutes, which also picks up names created by another API replica
 * and drops names that were released when an account was deleted (a Bloom filter cannot remove items).
 */
const REFRESH_MS = 5 * 60 * 1000;
const FALSE_POSITIVE_RATE = 0.01;
const BATCH = 5_000;

let filter: BloomFilter | null = null;
// Names added while a rebuild is reading the table may be missed by it; they are replayed onto the new filter.
let building = false;
let addedDuringBuild: string[] = [];

const rebuild = async () => {
  building = true;
  addedDuringBuild = [];
  try {
    await build();
  } finally {
    building = false;
    addedDuringBuild = [];
  }
};

const build = async () => {
  const count = await prisma.profile.count();
  // Room to grow between rebuilds without the false-positive rate climbing.
  const next = new BloomFilter(Math.max(50_000, count * 2), FALSE_POSITIVE_RATE);
  let cursor: string | undefined;
  for (;;) {
    const rows = await prisma.profile.findMany({
      select: { id: true, username: true },
      orderBy: { id: 'asc' },
      take: BATCH,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;
    for (const r of rows) next.add(r.username.toLowerCase());
    cursor = rows[rows.length - 1]!.id;
  }
  for (const name of addedDuringBuild) next.add(name);
  filter = next;
  console.log(`[username-filter] loaded ${next.size} usernames`);
};

export const UsernameFilter = {
  /** True when the name might be taken (ask the database); false when it is certainly free. */
  mightBeTaken: (username: string): boolean => (filter ? filter.mightContain(username.toLowerCase()) : true),

  /** Record a username that was just created or chosen. */
  add: (username: string) => {
    const name = username.toLowerCase();
    filter?.add(name);
    if (building) addedDuringBuild.push(name);
  },

  /** Build the filter now and keep it fresh. Until the first build finishes every check goes to the database. */
  start: () => {
    const run = () => rebuild().catch((e) => console.warn('[username-filter] rebuild failed:', e?.message ?? e));
    void run();
    setInterval(run, REFRESH_MS).unref();
  },
};
