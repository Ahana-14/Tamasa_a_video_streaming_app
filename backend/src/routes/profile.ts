import { Router } from 'express';
import { z } from 'zod';
import { UsernameFilter } from '../services/username-filter.service';
import { sendSuccessResponse } from '../lib/apiResponse';
import { asyncHandler } from '../lib/asyncHandler';
import { ProfileService } from '../services/profile.service';
import { optionalAuth, authenticateUser, type AuthenticatedRequest } from '../middleware/auth';
import { ApiError } from '../middleware/errorHandler';
import { ViewerService } from '../services/viewer.service';
import { signImage } from '../lib/signImage';
import { cached, CACHE_TTL } from '../cache/cache.service';
import { cacheKeys } from '../cache/cache.keys';
import { prisma } from '../config/db';

export const profileRouter = Router();

profileRouter.get(
    '/users/:username',
    optionalAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
      const username = z.string().min(1).max(64).safeParse(req.params.username);
      if (!username.success) throw new ApiError(400, 'Invalid username');
      // Shared, viewer-independent part of the page: cached. Follow state is added per request below.
      const pub = await cached(cacheKeys.creatorProfile(username.data), CACHE_TTL.creatorProfile, async () => {
        const profile = await ProfileService.getByUserName(username.data);
        const creator = profile.user.creatorProfile;
        const [avatarUrl, bannerUrl] = await Promise.all([
          signImage(profile.avatarAsset?.blobPath),
          signImage(creator?.bannerAsset?.blobPath),
        ]);
        return {
          creatorId: creator?.id ?? null,
          profile: {
            displayName: profile.displayName,
            username: profile.username,
            biography: profile.biography,
            avatarUrl,
            createdAt: profile.createdAt,
            creator: creator
              ? {
                  id: creator.id,
                  channelName: creator.channelName,
                  aboutText: creator.aboutText,
                  verificationStatus: creator.verificationStatus,
                  bannerUrl,
                }
              : null,
          },
        };
      });
      // followerCount is live and viewer.isFollowing / isOwnChannel are personal, so they are never cached.
      const channel = pub.creatorId ? await ViewerService.getCreatorState(req.auth?.userId, pub.creatorId) : null;

      sendSuccessResponse(res, {
        profile: pub.profile,
        followerCount: channel?.followerCount ?? 0,
        viewer: channel?.viewer ?? null,
      });
  }),
);

/** GET /api/username-available?username=jane_doe
 * Live check for the sign-up popup. Case-insensitive; the caller's own current username counts as available. */
profileRouter.get(
    '/username-available',
    optionalAuth,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
        const username = z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/).safeParse(req.query.username);
        if (!username.success) {
            return sendSuccessResponse(res, { available: false, reason: 'invalid' });
        }
        // Most names people try are free: the in-memory filter answers those without touching the database.
        if (!UsernameFilter.mightBeTaken(username.data)) {
            return sendSuccessResponse(res, { available: true, reason: null });
        }
        // "Maybe taken" (or filter not built yet): the database decides.
        const taken = await prisma.profile.findFirst({
            where: {
                username: { equals: username.data, mode: 'insensitive' },
                ...(req.auth?.userId ? { NOT: { user: { clerkUserId: req.auth.userId } } } : {}),
            },
            select: { id: true },
        });
        sendSuccessResponse(res, { available: !taken, reason: taken ? 'taken' : null });
    }),
);

const updateProfileSchema = z.object({
    displayName: z.string().trim().min(1).max(80).optional(),
    username: z.string().trim().toLowerCase().regex(/^[a-z0-9_]{3,30}$/, "Handle must be 3-30 characters: letters, numbers or underscores").optional(),
    biography: z.string().max(500).optional(),
}).refine((data) => Object.keys(data).length > 0, {
    message: "At least one field must be provided",
});

profileRouter.patch(
    "/profile",
    authenticateUser,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
        const clerkUserId = req.auth?.userId;
        if (!clerkUserId) throw new ApiError(401, "Unauthorized");

        const parsed = updateProfileSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new ApiError(400, "Invalid profile update", z.treeifyError(parsed.error).properties);
        }

        const profile = await ProfileService.updateOwnProfile(clerkUserId, parsed.data);
        sendSuccessResponse(res, { profile });
    }),
);

const avatarUploadSchema = z.object({
    fileExtension: z.string().regex(/^\.\w+$/, "Invalid file extension"),
});

profileRouter.post(
    "/profile/avatar",
    authenticateUser,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
        const clerkUserId = req.auth?.userId;
        if (!clerkUserId) throw new ApiError(401, "Unauthorized");

        const parsed = avatarUploadSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new ApiError(400, "Invalid avatar upload request", z.treeifyError(parsed.error).properties);
        }

        const result = await ProfileService.generateAvatarUploadUrl(clerkUserId, parsed.data.fileExtension);
        sendSuccessResponse(res, result);
    })
);

const confirmAvatarSchema = z.object({
    blobName: z.string().min(1),
});

profileRouter.post(
    "/profile/avatar/confirm",
    authenticateUser,
    asyncHandler(async (req: AuthenticatedRequest, res) => {
        const clerkUserId = req.auth?.userId;
        if (!clerkUserId) throw new ApiError(401, "Unauthorized");

        const parsed = confirmAvatarSchema.safeParse(req.body);
        if (!parsed.success) {
            throw new ApiError(400, "Invalid avatar confirmation request", z.treeifyError(parsed.error).properties);
        }

        const result = await ProfileService.confirmAvatarUpload(clerkUserId, parsed.data.blobName);
        sendSuccessResponse(res, result);
    })
);