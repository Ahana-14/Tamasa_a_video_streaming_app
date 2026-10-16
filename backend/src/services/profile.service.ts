import { randomUUID } from "node:crypto";
import { prisma } from "../config/db";
import { UsernameFilter } from "./username-filter.service";
import { AzureStorageService } from "./azure-storage.service";
import { assertImageBlob } from "../lib/assertImageBlob";
import { ApiError } from "../middleware/errorHandler";
import { AccountStatus } from "../../generated/prisma/enums";

export const ProfileService = {
    getByUserName: async (username: string) => {
        try {
            const profile = await prisma.profile.findUnique({
              where: { username },
              include: {
                user: {
                  select: {
                    role: true,
                    accountStatus: true,
                    createdAt: true,
                    creatorProfile: {
                      select: {
                        id: true,
                        channelName: true,
                        aboutText: true,
                        verificationStatus: true,
                        bannerAsset: { select: { blobPath: true } },
                      },
                    },
                  },
                },
                avatarAsset: true,
              },
            });
            if (!profile || profile.user.accountStatus !== AccountStatus.ACTIVE) {
                throw new ApiError(404, `No Profile found for username ${username}. Account is blocked.`);
            }
            return profile;
        }
        catch (error) {
            if(error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, "Failed to get profile by username", error);
        }
    },

    updateOwnProfile: async (clerkUserId: string, updates: { displayName?: string; username?: string; biography?: string; }) => {
        try {
            const user = await prisma.user.findUnique({
                where: { clerkUserId },
                include: { profile: true },
            });
            if(! user || !user.profile) {
                throw new ApiError(404, "user not found or profile not found for the user");
            }
            // The username is permanent: a creator's channel is named after it. It can only be SET once, while it is still
            // the placeholder created at sign-up (the Clerk id); after that it never changes.
            if (updates.username !== undefined && updates.username !== user.profile.username) {
                if (user.profile.username !== clerkUserId) {
                    throw new ApiError(403, "Usernames can't be changed");
                }
                // Usernames are unique regardless of capitals ("Jane" and "jane" are the same person to everyone).
                const taken = await prisma.profile.findFirst({
                    where: { username: { equals: updates.username, mode: 'insensitive' }, NOT: { userId: user.id } },
                    select: { id: true },
                });
                if (taken) throw new ApiError(409, "That username is already taken");
            }
            try {
                const saved = await prisma.profile.update({
                    where: { userId: user.id },
                    data: updates,
                });
                if (updates.username) UsernameFilter.add(updates.username);
                return saved;
            } catch (error: any) {
                if (error?.code === 'P2002') throw new ApiError(409, "That username is already taken");
                throw error;
            }
        } catch (error) {
            if(error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, "Failed to update own profile", error);
        }
    },

    generateAvatarUploadUrl: async (clerkUserId: string, fileExtension: string) => {
        try {
            const user = await prisma.user.findUnique({
                where: { clerkUserId },
                include: { profile: true },
            });
            if(! user || !user.profile) {
                throw new ApiError(404, "user not found or profile not found for the user");
            }
            const blobName = `avatars/${user.id}/${randomUUID()}.${fileExtension.replace(/^\./, '')}`;
            const uploadUrl = await AzureStorageService.generateUploadSasUrl("thumbnails", blobName);
            return { uploadUrl, blobName, container: "thumbnails" as const };
        } catch (error) {
            if(error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, "Failed to generate avatar upload URL", error);
        }
    },

    confirmAvatarUpload: async (clerkUserId: string, blobName: string) => {
        try {
           const user = await prisma.user.findUnique({
                where: { clerkUserId },
                include: { profile: true },
            });
            if(! user || !user.profile) {
                throw new ApiError(404, "user not found or profile not found for the user");
            }
            const exists = await AzureStorageService.blobExists("thumbnails", blobName);
            if(!exists) {
                throw new ApiError(400, "Uploaded avatar file does not exist in storage-upload may have failed or been deleted");
            }

            await assertImageBlob("thumbnails", blobName);

            let asset;
            try {
                asset = await prisma.mediaAsset.create({
                    data: {
                        type: "AVATAR",
                        storageProvider: "AZURE_BLOB",
                        container: "thumbnails",
                        blobPath: blobName,
                        status: "READY",
                    },
                });
            } catch (error: any) {
                if (error.code === 'P2002') {
                    throw new ApiError(409, "This avatar upload has already been confirmed");
                }
                throw error;
            }
           const profile = await prisma.profile.update({
                where: { userId: user.id },
                data: { avatarAssetId: asset.id },
            });
            return profile;
        }catch (error) {
            if(error instanceof ApiError) {
                throw error;
            }
            throw new ApiError(500, "Failed to confirm avatar upload", error);
        }
    }
}