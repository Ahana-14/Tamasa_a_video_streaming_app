import { prisma } from "../config/db";
import { UsernameFilter } from "./username-filter.service";
import { purgeDeletedVideos } from "./purge.service";
import { clerkClient } from "../config/clerk";
import { ApiError } from "../middleware/errorHandler";

interface CLerkUserData {
    id: string;
    username?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    [key : string]: unknown;
}

const buildFallbackUsername = (userData: CLerkUserData) => {
    const username = userData.username ?? userData.id;
    const displayName = [userData.first_name, userData.last_name].filter(Boolean).join(" ").trim() || username;
    return { username, displayName };
    
}

/**
 * A deleted account must free its username and channel name (both are unique) so the person, or anyone else, can use
 * them again. They are replaced with a throw-away value derived from the user id, which can't clash.
 */
const releasedName = (userId: string) => `deleted_${userId.replace(/-/g, "").slice(0, 12)}`;

const releaseIdentity = (userId: string, hasChannel: boolean) => [
    prisma.profile.updateMany({
        where: { userId },
        data: { username: releasedName(userId), displayName: "Deleted user", biography: null },
    }),
    ...(hasChannel
        ? [prisma.creatorProfile.updateMany({ where: { userId }, data: { channelName: releasedName(userId), aboutText: null } })]
        : []),
];

export const UserService = {
    ensureUserWithProfile: async (data: CLerkUserData) => {
        try {
            const existing = await prisma.user.findUnique({
                where: { clerkUserId: data.id },
            });

            if (existing) {
                return existing;
            }

            const { username, displayName } = buildFallbackUsername(data);

            const user = await prisma.user.create({
                data: {
                    clerkUserId: data.id,
                    profile: { create: { username, displayName } },
                    settings: { create: {} },
                
                },
            });
            UsernameFilter.add(username);
            return user;
        } catch (error) {
            throw new Error(
              `Failed to create user/profile for Clerk id "${data.id}": ${error}`,
            );
        }
    },

    /**
     * The signed-in user deletes their own account. The account is deactivated and a creator's channel is suspended; the
     * creator's videos are hidden at once and then deleted for good, with their files (see purge.service), then the Clerk login itself is
     * deleted so the account can't sign in again. Safe to repeat: every step is idempotent, so a retry after a
     * partial failure just finishes the job.
     */
    deleteAccount: async (clerkUserId: string) => {
        const user = await prisma.user.findUnique({
            where: { clerkUserId },
            include: { creatorProfile: true },
        });
        if (user) {
            const now = new Date();
            await prisma.$transaction([
                prisma.user.update({
                    where: { id: user.id },
                    data: { accountStatus: "DEACTIVATED", deletedAt: now },
                }),
                ...releaseIdentity(user.id, Boolean(user.creatorProfile)),
                ...(user.creatorProfile
                    ? [
                          prisma.video.updateMany({
                              where: { creatorId: user.creatorProfile.id, deletedAt: null },
                              data: { deletedAt: now, status: "DELETED" },
                          }),
                          prisma.creatorProfile.update({
                              where: { id: user.creatorProfile.id },
                              data: { status: "SUSPENDED" },
                          }),
                      ]
                    : []),
            ]);
        }
        // The creator's videos were only hidden by the transaction above: remove them (and their files) for good, now.
        void purgeDeletedVideos().catch(() => {});
        try {
            await clerkClient.users.deleteUser(clerkUserId);
        } catch (error: any) {
            // Already gone from Clerk (a retry, or the webhook got there first): that is the outcome we wanted.
            if (error?.status !== 404) throw new ApiError(502, "Could not delete the login. Please try again.", error);
        }
    },

    deactivateUser: async (clerkUserId: string) => {
        try {
            const user = await prisma.user.update({
                where: { clerkUserId },
                data: { accountStatus: "DEACTIVATED", deletedAt: new Date() },
                include: { creatorProfile: { select: { id: true } } },
            });
            await prisma.$transaction(releaseIdentity(user.id, Boolean(user.creatorProfile)));
            return user;
        } catch (error) {
            throw new Error(
              `Failed to deactivate user for Clerk id "${clerkUserId}": ${error}`,
            );
        }
    }
}