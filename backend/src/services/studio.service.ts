import { Prisma } from '../../generated/prisma/client';
import { prisma } from '../config/db';
import { signImage } from '../lib/signImage';
import { fillDailySeries, toPage } from '../lib/videoWhere';
import { ApiError } from '../middleware/errorHandler';
import { softDeleteCommentTree } from './comment-ops';

const requireCreator = async (clerkUserId: string) => {
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    include: { creatorProfile: true },
  });
  if (!user) throw new ApiError(404, 'User not found');
  if (!user.creatorProfile)
    throw new ApiError(403, 'Creator Studio is for creators only');
  return user.creatorProfile;
};

/** Start (00:00 UTC) of the oldest day in a `days`-day window ending today. */
const windowStart = (days: number) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - (days - 1) * 86_400_000);
};
// in overview() and videoAnalytics():  const since = windowStart(days);

/**
 * A "view" is an account's FIRST watch of a video: the same rule that moves the public counter (playback.service),
 * so the numbers for a period can never add up to more than the lifetime total. Replays are not views.
 * Returns each (account, video) pair with the time of its first watch.
 */
const firstWatches = (creatorId: string, videoId?: string) => Prisma.sql`
  SELECT MIN(h."watchedAt") AS first_at
  FROM watch_history h
  JOIN videos v ON v.id = h."videoId"
  WHERE v."creatorId" = ${creatorId}
    AND v."deletedAt" IS NULL
    ${videoId ? Prisma.sql`AND h."videoId" = ${videoId}` : Prisma.empty}
  GROUP BY h."userId", h."videoId"
`;

/** Views per UTC day (first watches only). */
const viewsByDay = async (creatorId: string, since: Date, videoId?: string) => {
  const rows = await prisma.$queryRaw<
    Array<{ day: Date; count: bigint }>
  >(Prisma.sql`
    SELECT date_trunc('day', f.first_at AT TIME ZONE 'UTC') AS day, COUNT(*)::bigint AS count
    FROM (${firstWatches(creatorId, videoId)}) f
    WHERE f.first_at >= ${since}
    GROUP BY 1
    ORDER BY 1
  `);
  return rows.map((r) => ({ day: new Date(r.day), count: Number(r.count) }));
};

/** Views inside the window (first watches only). */
const viewsInPeriod = async (creatorId: string, since: Date, videoId?: string) => {
  const rows = await prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
    SELECT COUNT(*)::bigint AS count FROM (${firstWatches(creatorId, videoId)}) f WHERE f.first_at >= ${since}
  `);
  return Number(rows[0]?.count ?? 0);
};

export const StudioService = {
  overview: async (clerkUserId: string, days: number) => {
    try {
      const creator = await requireCreator(clerkUserId);
      const since = windowStart(days);

      const [
        totals,
        videoCount,
        followerCount,
        newFollowers,
        periodViews,
        series,
        topVideos,
      ] = await Promise.all([
        prisma.video.aggregate({
          where: { creatorId: creator.id, deletedAt: null },
          _sum: {
            viewCount: true,
            likeCount: true,
            commentCount: true,
            shareCount: true,
          },
        }),
        prisma.video.count({
          where: { creatorId: creator.id, deletedAt: null },
        }),
        prisma.follow.count({ where: { creatorId: creator.id } }),
        prisma.follow.count({
          where: { creatorId: creator.id, createdAt: { gte: since } },
        }),
        viewsInPeriod(creator.id, since),
        viewsByDay(creator.id, since),
        prisma.video.findMany({
          where: {
            creatorId: creator.id,
            deletedAt: null,
            // Only videos that are live for everyone. A draft (ready but unpublished) or a private video is not "top
            // performing", however it is doing.
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
          },
          orderBy: [{ viewCount: 'desc' }, { id: 'desc' }],
          take: 5,
          select: {
            id: true,
            title: true,
            type: true,
            viewCount: true,
            likeCount: true,
            commentCount: true,
            thumbnailAsset: true,
          },
        }),
      ]);

      // Never spread the raw thumbnail asset row: it carries the storage path and isn't loadable by the app.
      const top = await Promise.all(
        topVideos.map(async ({ thumbnailAsset, ...v }) => ({
          ...v,
          viewCount: Number(v.viewCount),
          likeCount: Number(v.likeCount),
          commentCount: Number(v.commentCount),
          thumbnailUrl: await signImage(thumbnailAsset?.blobPath),
        })),
      );

      return {
        periodDays: days,
        totals: {
          videos: videoCount,
          followers: followerCount,
          views: Number(totals._sum.viewCount ?? 0),
          likes: Number(totals._sum.likeCount ?? 0),
          comments: Number(totals._sum.commentCount ?? 0),
          shares: Number(totals._sum.shareCount ?? 0),
        },
        period: { views: periodViews, newFollowers },
        viewsByDay: fillDailySeries(series, days),
        topVideos: top,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to load studio overview', error);
    }
  },

  videoAnalytics: async (
    clerkUserId: string,
    videoId: string,
    days: number,
  ) => {
    try {
      const creator = await requireCreator(clerkUserId);
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      if (!video || video.deletedAt) throw new ApiError(404, 'Video not found');
      if (video.creatorId !== creator.id)
        throw new ApiError(403, 'Not your video');
      const since = windowStart(days);

      const [periodViews, progress, completedCount, series] =
        await Promise.all([
          viewsInPeriod(creator.id, since, videoId),
          prisma.watchProgress.aggregate({
            where: { videoId },
            _avg: { completionPercent: true },
            _count: { _all: true },
          }),
          prisma.watchProgress.count({ where: { videoId, completed: true } }),
          viewsByDay(creator.id, since, videoId),
        ]);

      return {
        videoId,
        title: video.title,
        periodDays: days,
        lifetime: {
          views: Number(video.viewCount),
          likes: Number(video.likeCount),
          comments: Number(video.commentCount),
          shares: Number(video.shareCount),
        },
        // views are first watches, so each one is a different account: viewers and views are the same number
        period: { views: periodViews, uniqueViewers: periodViews },
        engagement: {
          watchers: progress._count._all,
          averageCompletionPercent:
            Math.round(Number(progress._avg.completionPercent ?? 0) * 100) /
            100,
          completedCount,
        },
        viewsByDay: fillDailySeries(series, days),
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to load video analytics', error);
    }
  },

  /** Every live comment/reply on the creator's videos, newest first. Optional videoId filter. */
  listComments: async (
    clerkUserId: string,
    limit: number,
    cursor?: string,
    videoId?: string,
  ) => {
    try {
      const creator = await requireCreator(clerkUserId);
      const rows = await prisma.comment.findMany({
        where: {
          deletedAt: null,
          video: {
            creatorId: creator.id,
            deletedAt: null,
            ...(videoId ? { id: videoId } : {}),
          },
        },
        include: {
          video: { select: { id: true, title: true } },
          user: { include: { profile: true } },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      const { items, nextCursor } = toPage(rows, limit);
      return {
        comments: items.map((c) => ({
          id: c.id,
          body: c.body,
          createdAt: c.createdAt,
          isReply: c.parentCommentId != null,
          parentCommentId: c.parentCommentId,
          video: c.video,
          author: {
            userId: c.userId,
            username: c.user.profile?.username ?? null,
            displayName: c.user.profile?.displayName ?? null,
          },
        })),
        nextCursor,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to load comments', error);
    }
  },

  /** Moderation: the video's owner removes any comment on it (plus replies, for a top-level one). */
  removeComment: async (clerkUserId: string, commentId: string) => {
    try {
      const creator = await requireCreator(clerkUserId);
      const comment = await prisma.comment.findUnique({
        where: { id: commentId },
        include: { video: true },
      });
      if (!comment || comment.deletedAt)
        throw new ApiError(404, 'Comment not found');
      if (comment.video.creatorId !== creator.id)
        throw new ApiError(403, 'Not a comment on your video');
      return await softDeleteCommentTree(comment);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to remove comment', error);
    }
  },
};
