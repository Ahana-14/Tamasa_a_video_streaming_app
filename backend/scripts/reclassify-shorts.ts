/**
 * Re-files existing videos with the CURRENT Shorts rule (vertical or square, up to 3 minutes). Dry run by default.
 *   bun run scripts/reclassify-shorts.ts            # show what would change
 *   bun run scripts/reclassify-shorts.ts --apply    # do it
 */
import 'dotenv/config';
import { prisma } from '../src/config/db';
import { classifyVideoFormat } from '../src/lib/videoClassification';

const apply = process.argv.includes('--apply');
const videos = await prisma.video.findMany({
  where: { deletedAt: null, durationMs: { not: null }, width: { not: null }, height: { not: null } },
  select: { id: true, title: true, type: true, durationMs: true, width: true, height: true },
});

const changes = videos
  .map((v) => ({ v, next: classifyVideoFormat({ durationMs: Number(v.durationMs), width: v.width!, height: v.height! }) }))
  .filter(({ v, next }) => v.type !== next);

for (const { v, next } of changes) {
  console.log(`${v.type} -> ${next}  ${v.title}  (${v.width}x${v.height}, ${Math.round(Number(v.durationMs) / 1000)}s)`);
}
console.log(`${videos.length} videos checked, ${changes.length} would change`);
if (apply && changes.length > 0) {
  for (const { v, next } of changes) await prisma.video.update({ where: { id: v.id }, data: { type: next } });
  console.log('applied');
} else if (!apply) {
  console.log('(dry run: pass --apply to change them)');
}
process.exit(0);
