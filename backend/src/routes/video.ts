import { verifyToken } from '@clerk/backend';
import { cached, CACHE_TTL } from '../cache/cache.service';
import { cacheKeys } from '../cache/cache.keys';
import { Router } from 'express';
import { z } from 'zod';
import { sendSuccessResponse } from '../lib/apiResponse';
import { asyncHandler } from '../lib/asyncHandler';
import {
  type AuthenticatedRequest,
  authenticateUser,
  optionalAuth,
} from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { VideoService } from '../services/video.service';
import { env } from '../config/env';
import { FeedService } from '../services/feed.service';
import { ViewerService } from '../services/viewer.service';
import { prisma } from '../config/db';
import { presentVideoCards } from '../lib/videoCard';

export const videosRouter = Router();

const parseVideoId = (rawVideoId: unknown): string => {
  const parsed = z.uuid().safeParse(rawVideoId);
  if (!parsed.success) {
    throw new ApiError(404, 'Video not found');
  }
  return parsed.data;
};

const initVideoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  // Optional hint only — the server classifies short vs long from the real
  // file (duration + aspect ratio) and overwrites this after processing.
  type: z.enum(['LONG_FORM', 'SHORT_FORM']).optional(),
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']).optional(),
  categoryId: z.uuid({
    message: 'Category is required - see GET/api/categories',
  }),
  fileExtension: z
    .string()
    .regex(/^[a-zA-Z0-9]{1,10}$/, 'Invalid file extension (letters/digits only, no dot)'),
  mimeType: z.string().min(1).optional(),
  // YouTube-style upload choice: "AUTO" (default) grabs a frame from the
  // video; "CUSTOM" signals the creator intends to upload their own via
  // POST /videos/:videoId/thumbnail right after this. Either way, the
  // auto-generated one still happens as a fallback — see the schema
  // comment on Video.thumbnailSource.
  thumbnailSource: z.enum(['AUTO', 'CUSTOM']).optional(),
});

/** POST  /api/videos/init
 * creator-only endpoint to initialize a video upload. It creates a pending media asset and a draft video row, and returns a short-lived SAS URL for the client to upload the raw file directly to Azure Blob Storage.
 */

videosRouter.post(
  '/videos/init',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const parsedBody = initVideoSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ApiError(
        400,
        'Invalid request body',
        z.treeifyError(parsedBody.error).properties,
      );
    }

    const result = await VideoService.initUpload(clerkUserId, parsedBody.data);
    sendSuccessResponse(res, result);
  }),
);

/** POST /api/videos/:videoId/upload-url
 * A fresh signed upload link for an unfinished upload, used to resume after the connection dropped.
 */
videosRouter.post(
  '/videos/:videoId/upload-url',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) throw new ApiError(401, 'Unauthorized: No user ID found in request');
    const result = await VideoService.refreshUploadUrl(clerkUserId, parseVideoId(req.params.videoId));
    sendSuccessResponse(res, result);
  }),
);

/** POST /api/videos/:videoId/complete
 * verifies the raw video file has been uploaded to Azure Blob Storage, and then triggers the video processing pipeline (transcoding, thumbnail generation, etc.). This endpoint is called by the client after the raw video upload is complete.
 */

videosRouter.post(
  '/videos/:videoId/complete',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);

    const result = await VideoService.completeUpload(clerkUserId, videoId);
    sendSuccessResponse(res, result);
  }),
);

/** GET /api/videos/mine
 * Lists all videos belonging to the authenticated creator. Must be registered
 * before /videos/:videoId, otherwise Express matches "mine" as a :videoId
 * and it never reaches this handler.
 */

videosRouter.get(
  '/videos/mine',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videos = await VideoService.listMine(clerkUserId);
    sendSuccessResponse(res, { videos });
  }),
);

/** GET /api/videos/:videoId
 * Public unless private, in which case only the owning creator can access it. Returns the video metadata and the processed media assets (transcoded videos, thumbnails, etc.) if available.
 */

videosRouter.get(
  '/videos/:videoId',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    //No require authentication for public videos, but if the video is private, we will check if the user is authenticated and is the owner of the video.
    const authHeader = req.headers.authorization;
    let viewerClerkUserId: string | undefined;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length);
      try {
        const verifiedToken = await verifyToken(token, {
          secretKey: env.CLERK_SECRET_KEY,
        });
        viewerClerkUserId = verifiedToken.sub;
      } catch (error) {
        console.error('Error verifying token:', error);
        // We won't throw an error here, because we want to allow public access to public videos.
      }
    }
    const videoId = parseVideoId(req.params.videoId);
    const video = await VideoService.getById(videoId, viewerClerkUserId);
    // Independent lookups run together: each is a round trip to the (remote) database, and doing them one
    // after another made opening a video take several seconds.
    // `viewer` = the caller's own button state; null when anonymous.
    // Profile + avatar for the creator row are fetched here (not in getById) because getById runs on every HLS segment request.
    const [viewer, profile, creatorState] = await Promise.all([
      ViewerService.getVideoState(viewerClerkUserId, video),
      prisma.profile.findUnique({
        where: { userId: video.creator.userId },
        include: { avatarAsset: true },
      }),
      ViewerService.getCreatorState(undefined, video.creatorId),
    ]);
    const { followerCount } = creatorState;
    const [card] = await presentVideoCards([
      { ...video, creator: { ...video.creator, user: { profile } } },
    ]);
    if (!card) throw new ApiError(404, 'Video not found');

    // Never expose storage paths or the raw user row. The app only needs to know "can I stream / download it".
    // shareCount is private: only the video's owner may see it.
    const { originalAsset, hlsManifestAsset, variants, shareCount, ...safe } = card;
    sendSuccessResponse(res, {
      video: {
        ...safe,
        ...(viewer?.isOwner ? { shareCount } : {}),
        hasStream: hlsManifestAsset != null,
        canDownload: originalAsset?.status === 'UPLOADED',
        variants: variants.map((v) => ({
          label: v.label,
          width: v.width,
          height: v.height,
          status: v.status,
        })),
        creatorInfo: card.creatorInfo ? { ...card.creatorInfo, followerCount } : null,
      },
      viewer,
    });
  }),
);

const updateVideoSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).optional(),
  categoryId: z.uuid().optional(),
});

const relatedQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(30).default(12),
});

/** GET /api/videos/:videoId/related
 * Returns a list of related videos based on the video's category and tags.
 */ 

videosRouter.get(
  '/videos/:videoId/related',
  optionalAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const videoId = parseVideoId(req.params.videoId);
    const parsedQuery = relatedQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      throw new ApiError(
        400,
        'Invalid query parameters',
        z.treeifyError(parsedQuery.error).properties,
      );
    }
    const { limit } = parsedQuery.data;
    // For a public video the list is the same for everyone, so it is shared through the cache.
    let related: { videos: unknown[] };
    try {
      related = await cached(cacheKeys.related(videoId, limit), CACHE_TTL.related, () =>
        FeedService.getRelatedVideos(videoId, limit),
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode !== 404) throw error;
      // The video isn't public: only its owner may see it, so the owner gets a list (not cached, since it depends on who
      // is asking) and everyone else gets an empty one instead of a "not found" in the middle of the watch page.
      related = req.auth?.userId
        ? await FeedService.getRelatedVideos(videoId, limit, req.auth.userId).catch(() => ({ videos: [] }))
        : { videos: [] };
    }
    // The service returns { videos: [...] }; send the array itself under both names the app accepts.
    sendSuccessResponse(res, { relatedVideos: related.videos, videos: related.videos });
  }));

/** PATCH /api/videos/:videoId
 * Updates the metadata of a video. Only the creator of the video can update it.
 * Visibility is deliberately NOT settable here — it only ever changes via
 * POST /videos/:videoId/publish, which enforces the video is actually
 * READY before anything can go live and fires the "new video" notification
 * fan-out. Allowing visibility here would let a creator skip that gate
 * entirely.
 */

videosRouter.patch(
  '/videos/:videoId',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);
    const parsedBody = updateVideoSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ApiError(
        400,
        'Invalid video request',
        z.treeifyError(parsedBody.error).properties,
      );
    }

    const updatedVideo = await VideoService.updateMetadata(
      clerkUserId,
      videoId,
      parsedBody.data,
    );
    sendSuccessResponse(res, { video: updatedVideo });
  }),
);

const publishVideoSchema = z.object({
  visibility: z.enum(['PUBLIC', 'UNLISTED', 'PRIVATE']),
});

/**
 * POST /api/videos/:videoId/publish
 * Owning creator only. The video must already be READY (480p/720p done).
 * All three visibilities — including PUBLIC — are allowed as soon as it's
 * READY; HD (1080p/1440p) is NOT required. If HD finishes later, it's
 * added to the manifest in place and the creator just gets a notification
 * — no second publish call needed. See VideoService.publish.
 */

videosRouter.post(
  '/videos/:videoId/publish',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);
    const parsedBody = publishVideoSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ApiError(
        400,
        'Invalid publish request',
        z.treeifyError(parsedBody.error).properties,
      );
    }

    const video = await VideoService.publish(
      clerkUserId,
      videoId,
      parsedBody.data.visibility,
    );
    sendSuccessResponse(res, { video });
  }),
);

/**
 * GET /api/videos/:videoId/download
 * Returns a short-lived signed URL to the original uploaded file.
 * Same visibility rules as viewing the video apply.
 */

videosRouter.get(
  '/videos/:videoId/download',
  optionalAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const videoId = parseVideoId(req.params.videoId);
    const result = await VideoService.generateDownloadUrl(
      videoId,
      req.auth?.userId,
    );
    // result is already { downloadUrl, filename }; wrapping it again made downloadUrl an object, not a string.
    sendSuccessResponse(res, result);
  }),
);

const thumbnailUploadSchema = z.object({
  // The app sends the extension with or without the leading dot.
  fileExtension: z.string().regex(/^\.?\w+$/, 'Invalid file extension'),
});

/** POST /api/videos/:videoId/thumbnail
 * Creator-only. Requests a signed upload URL for a custom thumbnail image.
 */

videosRouter.post(
  '/videos/:videoId/thumbnail',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);
    const parsedBody = thumbnailUploadSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ApiError(
        400,
        'Invalid thumbnail upload request',
        z.treeifyError(parsedBody.error).properties,
      );
    }

    const result = await VideoService.generateThumbnailUploadUrl(
      clerkUserId,
      videoId,
      parsedBody.data.fileExtension,
    );
    sendSuccessResponse(res, result);
  }),
);

const confirmThumbnailSchema = z.object({
  blobName: z.string().min(1),
});

/** POST /api/videos/:videoId/thumbnail/confirm
 * Creator-only. Confirms the custom thumbnail upload finished and points
 * the video at it, overwriting the worker-generated one if present.
 */

videosRouter.post(
  '/videos/:videoId/thumbnail/confirm',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);
    const parsedBody = confirmThumbnailSchema.safeParse(req.body);
    if (!parsedBody.success) {
      throw new ApiError(
        400,
        'Invalid thumbnail confirmation request',
        z.treeifyError(parsedBody.error).properties,
      );
    }

    const result = await VideoService.confirmThumbnailUpload(
      clerkUserId,
      videoId,
      parsedBody.data.blobName,
    );
    sendSuccessResponse(res, { video: result });
  }),
);

/**
 * POST /api/videos/:videoId/share
 * Bumps the share counter. No auth required — sharing a public video is a
 * low-stakes action, and requiring login here would just add friction.
 */

videosRouter.post(
  '/videos/:videoId/share',
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const videoId = parseVideoId(req.params.videoId);
    await VideoService.incrementShareCount(videoId);
    // The count itself is private to the owner, so it isn't echoed back.
    sendSuccessResponse(res, { message: 'Share count bumped' });
  }),
);

// Delete a video (owner only). Permanent and immediate: see VideoDeleteService.
videosRouter.delete(
  '/videos/:videoId',
  authenticateUser,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const clerkUserId = req.auth?.userId;
    if (!clerkUserId) {
      throw new ApiError(401, 'Unauthorized: No user ID found in request');
    }

    const videoId = parseVideoId(req.params.videoId);
    await VideoService.deleteVideo(clerkUserId, videoId);
    sendSuccessResponse(res, { message: 'Video deleted successfully' });
  }),
);
