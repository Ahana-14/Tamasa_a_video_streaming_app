import { randomUUID } from 'node:crypto';
import { VideoDeleteService } from './video-delete.service';
import { prisma } from '../config/db';
import { ApiError } from '../middleware/errorHandler';
import { AzureStorageService } from './azure-storage.service';
import { JobService } from './job.service';
import { NotificationService } from './notification.service';
import { VIDEO_CARD_INCLUDE } from '../lib/videoWhere';
import { presentVideoCards } from '../lib/videoCard';

/** How long an upload link works. A large video on a slow connection takes a while, so this is generous. */
const UPLOAD_LINK_MINUTES = 180;

const requireCreatorProfile = async (clerkUserId: string) => {
  const user = await prisma.user.findUnique({
    where: { clerkUserId },
    include: { creatorProfile: true },
  });

  if (!user) throw new ApiError(404, 'User not found');
  if (!user.creatorProfile)
    throw new ApiError(403, 'Only creators can upload videos');

  return { user, creatorProfile: user.creatorProfile };
};

interface InitUploadInput {
  title: string;
  description?: string;
  // Optional and NOT trusted: the worker overwrites it from the real file
  // after ffprobe (see classifyVideoFormat). Still accepted so existing
  // frontends/Postman requests that send it don't break.
  type?: 'LONG_FORM' | 'SHORT_FORM';
  visibility?: 'PUBLIC' | 'UNLISTED' | 'PRIVATE';
  categoryId: string;
  fileExtension: string;
  // The YouTube-style upload-time choice: "AUTO" (default — we'll grab a
  // frame from the video) or "CUSTOM" (creator intends to upload their
  // own). Purely a stated intent for the frontend to act on — see the
  // thumbnailSource comment on the Video model for what it does and
  // doesn't change about backend behavior.
  thumbnailSource?: 'AUTO' | 'CUSTOM';
}

export const VideoService = {
  initUpload: async (clerkUserId: string, input: InitUploadInput) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);

      const category = await prisma.category.findUnique({
        where: { id: input.categoryId },
      });
      if (!category) {
        throw new ApiError(
          400,
          'Invalid categoryId — see GET /api/categories for valid options',
        );
      }

      const blobPath = `${creatorProfile.id}/${randomUUID()}.${input.fileExtension}`;

      const asset = await prisma.mediaAsset.create({
        data: {
          type: 'ORIGINAL_VIDEO',
          storageProvider: 'AZURE_BLOB',
          container: 'originals',
          blobPath,
          status: 'PENDING',
        },
      });

      const video = await prisma.video.create({
        data: {
          creatorId: creatorProfile.id,
          // Provisional placeholder only — the worker sets the real value
          // from the actual file (duration + aspect ratio) before READY.
          type: input.type ?? 'LONG_FORM',
          title: input.title,
          description: input.description,
          // Nothing is actually public until the creator explicitly calls
          // publish() below — this stays PRIVATE no matter what the
          // request asked for, all the way through UPLOADING/PROCESSING
          // and even through READY (480p/720p watchable). What they asked
          // for is only remembered on requestedVisibility, to pre-fill
          // the publish dialog once it's their call to make.
          visibility: 'PRIVATE',
          requestedVisibility: input.visibility ?? 'PUBLIC',
          thumbnailSource: input.thumbnailSource ?? 'AUTO',
          status: 'UPLOADING',
          categoryId: input.categoryId,
          originalAssetId: asset.id,
        },
      });

      const uploadUrl = await AzureStorageService.generateUploadSasUrl(
        'originals',
        blobPath,
        UPLOAD_LINK_MINUTES,
      );

      return {
        videoId: video.id,
        assetId: asset.id,
        uploadUrl,
        blobPath,
        container: 'originals' as const,
      };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to initialize video upload', error);
    }
  },

  /**
   * A fresh upload link for a video whose upload has not finished, so an interrupted upload can carry on where it
   * stopped (the blocks Azure already holds stay valid for a week) instead of starting again.
   */
  refreshUploadUrl: async (clerkUserId: string, videoId: string) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);
      const video = await prisma.video.findUnique({
        where: { id: videoId },
        include: { originalAsset: true },
      });
      if (!video || video.deletedAt) throw new ApiError(404, 'Video not found');
      if (video.creatorId !== creatorProfile.id) throw new ApiError(403, 'Not your video');
      if (video.status !== 'UPLOADING' || !video.originalAsset)
        throw new ApiError(409, 'This upload is already finished');
      const uploadUrl = await AzureStorageService.generateUploadSasUrl(
        'originals',
        video.originalAsset.blobPath,
        UPLOAD_LINK_MINUTES,
      );
      return { uploadUrl };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to refresh the upload link', error);
    }
  },

  completeUpload: async (clerkUserId: string, videoId: string) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);

      const video = await prisma.video.findUnique({
        where: { id: videoId },
        include: { originalAsset: true },
      });
      if (!video) throw new ApiError(404, 'Video not found');
      if (video.creatorId !== creatorProfile.id)
        throw new ApiError(403, 'Not your video');
      if (!video.originalAsset)
        throw new ApiError(400, 'Video has no associated upload');

      const exists = await AzureStorageService.blobExists(
        'originals',
        video.originalAsset.blobPath,
      );
      if (!exists)
        throw new ApiError(
          400,
          'Uploaded file not found in storage — upload may have failed',
        );

      await prisma.mediaAsset.update({
        where: { id: video.originalAsset.id },
        data: { status: 'UPLOADED' },
      });

      const updated = await prisma.video.update({
        where: { id: videoId },
        data: { status: 'PROCESSING' },
      });

      // Hand off to the worker (Phase 7) — it'll flip status to READY/FAILED.
      await JobService.enqueueProcessingJobs(videoId);

      return updated;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to complete video upload', error);
    }
  },

  getById: async (videoId: string, clerkUserId?: string) => {
    try {
      const video = await prisma.video.findUnique({
        where: { id: videoId },
        include: {
          creator: { include: { user: true } },
          originalAsset: true,
          thumbnailAsset: true,
          hlsManifestAsset: true,
          variants: true,
        },
      });

      if (!video || video.deletedAt) throw new ApiError(404, 'Video not found');

      const isOwner =
        clerkUserId != null && video.creator.user.clerkUserId === clerkUserId;
      if (!isOwner && video.visibility !== 'PUBLIC') {
        throw new ApiError(404, 'Video not found');
      }

      return video;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to load video', error);
    }
  },

  listMine: async (clerkUserId: string) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);

      // An upload still in progress shows up; one that never finished (app closed, cancelled, a retry that made a
      // second video) is abandoned after 10 minutes and no longer clutters the Content tab.
      const abandonedBefore = new Date(Date.now() - 10 * 60 * 1000);
      const rows = await prisma.video.findMany({
        where: {
          creatorId: creatorProfile.id,
          deletedAt: null,
          NOT: { status: 'UPLOADING', createdAt: { lt: abandonedBefore } },
        },
        orderBy: { createdAt: 'desc' },
        include: VIDEO_CARD_INCLUDE,
      });
      const cards = await presentVideoCards(rows);

      // Explicit pick: no asset rows or blob paths go to the client.
      return cards.map((c) => ({
        id: c.id,
        title: c.title,
        description: c.description,
        type: c.type,
        status: c.status,
        visibility: c.visibility,
        requestedVisibility: c.requestedVisibility,
        categoryId: c.categoryId,
        durationMs: c.durationMs != null ? Number(c.durationMs) : null,
        hdReady: c.hdReady,
        createdAt: c.createdAt,
        publishedAt: c.publishedAt,
        thumbnailUrl: c.thumbnailUrl,
      }));
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to list videos', error);
    }
  },

  updateMetadata: async (
    clerkUserId: string,
    videoId: string,
    // visibility is deliberately excluded — it only changes via publish().
    updates: Partial<{
      title: string;
      description: string;
      categoryId: string;
    }>,
  ) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      if (!video || video.creatorId !== creatorProfile.id) {
        throw new ApiError(404, 'Video not found');
      }

      return await prisma.video.update({
        where: { id: videoId },
        data: updates,
      });
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to update video metadata', error);
    }
  },

  /**
   * The explicit "go live" action — separate from upload/processing on
   * purpose. A video sits PRIVATE from the moment it's created through
   * READY (480p/720p watchable); it only actually becomes visible to
   * anyone else once the owning creator calls this.
   *
   * DESIGN DECISION (matches real YouTube behavior): PUBLIC is allowed as
   * soon as the video is READY (480p/720p done) — it does NOT wait for
   * hdReady. Publishing early just means early viewers get a 480p/720p
   * ceiling; once the HD job finishes later, MediaProcessingService
   * .transcodeHdRung() has already amended the live master.m3u8 in place,
   * so the higher rung(s) are simply there for any player that (re)reads
   * the manifest afterward — no second publish call needed. The creator
   * gets ONE "HD is ready" notification when the first/minimum HD rung
   * (1080p) finishes (see the worker's processTranscode1080pJob) — if the
   * source also qualifies for 1440p, that's added later completely
   * silently, with no second notification (see processTranscode1440pJob).
   */
  publish: async (
    clerkUserId: string,
    videoId: string,
    visibility: 'PUBLIC' | 'UNLISTED' | 'PRIVATE',
  ) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);

      const video = await prisma.video.findUnique({ where: { id: videoId } });
      if (!video || video.deletedAt) throw new ApiError(404, 'Video not found');
      if (video.creatorId !== creatorProfile.id)
        throw new ApiError(403, 'Not your video');

      if (video.status !== 'READY' && video.status !== 'PUBLISHED') {
        throw new ApiError(
          400,
          `Video isn't watchable yet (status: ${video.status}) — wait for processing to finish`,
        );
      }

      const updated = await prisma.video.update({
        where: { id: videoId },
        data: { visibility, status: 'PUBLISHED', publishedAt: new Date() },
      });

      if (visibility === 'PUBLIC') {
        await NotificationService.notifyFollowersOfNewVideo(
          updated.creatorId,
          updated.id,
          updated.title,
        );
      }

      return updated;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to publish video', error);
    }
  },

  /**
   * Signed, time-limited download link. Reuses the same visibility check as
   * getById — a PRIVATE video still can't be downloaded by a stranger just
   * because they have a direct link. Points at the original upload (a
   * single real file) rather than the HLS output (segmented, not meant to
   * be downloaded as one playable file).
   */

  generateDownloadUrl: async (videoId: string, clerkUserId?: string) => {
    try {
      const video = await VideoService.getById(videoId, clerkUserId);
      if (!video.originalAsset || video.originalAsset.status !== 'UPLOADED') {
        throw new ApiError(404, 'No downloadable file for this video');
      }

      try {
        const downloadUrl = await AzureStorageService.generateReadSasUrl(
          'originals',
          video.originalAsset.blobPath,
          30, // minutes until the signed URL expires
        );
        return {
          downloadUrl,
          filename: `${video.title.replace(/[^a-z0-9]/gi, '_')}.mp4`,
        };
      } catch (error) {
        throw new ApiError(404, 'Failed to generate download URL', error);
      }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to generate download URL', error);
    }
  },
  /**
   * Custom thumbnail upload — same two-step SAS-URL pattern as avatar/banner:
   * 1. Client asks for a signed upload URL and uploads the image directly to
   *    Azure Blob.
   * 2. Client calls confirmThumbnailUpload() once the upload finishes, which
   *    verifies the blob landed and points the video at the new MediaAsset.
   * This overwrites whatever thumbnail the processing worker auto-generated
   * from the video itself — a creator-supplied thumbnail takes precedence.
   */
  generateThumbnailUploadUrl: async (
    clerkUserId: string,
    videoId: string,
    fileExtension: string,
  ) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      if (!video || video.creatorId !== creatorProfile.id) {
        throw new ApiError(404, 'Video not found');
      }

      const blobName = `thumbnails/${video.id}/${randomUUID()}.${fileExtension.replace(/^\./, '')}`;
      const uploadUrl = await AzureStorageService.generateUploadSasUrl(
        'thumbnails',
        blobName,
      );

      return { uploadUrl, blobName, container: 'thumbnails' as const };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to generate thumbnail upload URL', error);
    }
  },

  confirmThumbnailUpload: async (
    clerkUserId: string,
    videoId: string,
    blobName: string,
  ) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);
      const video = await prisma.video.findUnique({ where: { id: videoId } });
      if (!video || video.creatorId !== creatorProfile.id) {
        throw new ApiError(404, 'Video not found');
      }

      const exists = await AzureStorageService.blobExists(
        'thumbnails',
        blobName,
      );
      if (!exists) {
        throw new ApiError(
          400,
          'Uploaded thumbnail not found in storage — upload may have failed',
        );
      }

      let asset;
      try {
        asset = await prisma.mediaAsset.create({
          data: {
            type: 'THUMBNAIL',
            storageProvider: 'AZURE_BLOB',
            container: 'thumbnails',
            blobPath: blobName,
            status: 'READY',
          },
        });
      } catch (error: any) {
        if (error.code === 'P2002') {
          throw new ApiError(
            409,
            'This thumbnail upload has already been confirmed',
          );
        }
        throw error;
      }

      // Replacing an existing thumbnail (worker-generated or a prior custom
      // upload): the old MediaAsset row is orphaned, same tradeoff the
      // avatar/banner flows already make.
      const updated = await prisma.video.update({
        where: { id: videoId },
        data: { thumbnailAssetId: asset.id, thumbnailIsCustom: true },
        include: { thumbnailAsset: true },
      });

      return updated;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to confirm thumbnail upload', error);
    }
  },

  /**
   * Owner-only PERMANENT delete. The video, its likes, comments, shares, saves, history, notifications, versions and
   * encode jobs are removed from the database at once (so it disappears from the feed, channel page and studio), and
   * its stored files are removed right after. A worker that is still encoding it stops. See VideoDeleteService.
   */
  deleteVideo: async (clerkUserId: string, videoId: string) => {
    try {
      const { creatorProfile } = await requireCreatorProfile(clerkUserId);
      const video = await prisma.video.findUnique({ where: { id: videoId }, select: { id: true, creatorId: true } });
      if (!video || video.creatorId !== creatorProfile.id) {
        throw new ApiError(404, 'Video not found');
      }

      await VideoDeleteService.hardDelete(videoId, { background: true });
      return { deleted: true, videoId };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to delete video', error);
    }
  },

  /** bumps the share counter - called once per "sahre" tap in the client */
  incrementShareCount: async (videoId: string) => {
    try {
      const existing = await prisma.video.findUnique({
        where: { id: videoId },
      });
      if (!existing || existing.deletedAt || existing.visibility !== 'PUBLIC') {
        throw new ApiError(404, 'Video not found');
      }

      const video = await prisma.video.update({
        where: { id: videoId },
        data: { shareCount: { increment: 1 } },
      });
      return { shareCount: video.shareCount };
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, 'Failed to increment share count', error);
    }
  },
};
