"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.submitCheckin = submitCheckin;
exports.applyShieldToChallenge = applyShieldToChallenge;
exports.toggleVetoVote = toggleVetoVote;
exports.joinChallengeByCode = joinChallengeByCode;
const client_1 = require("@prisma/client");
const db_1 = require("../db");
const telegram_1 = require("../telegram");
const appError_1 = require("../utils/appError");
const timezone_1 = require("../utils/timezone");
async function submitCheckin({ challengeId, userId, timezone, mediaType, telegramFileId, caption, }) {
    const date = (0, timezone_1.getLocalDateString)(new Date(), timezone);
    return db_1.db.$transaction(async (transaction) => {
        const membership = await transaction.challengeMember.findUnique({
            where: { challengeId_userId: { challengeId, userId } },
            include: { challenge: true },
        });
        if (!membership) {
            throw new appError_1.AppError(403, "You are not a member of this challenge");
        }
        if (membership.challenge.proofType === client_1.ProofType.PHOTO && mediaType === client_1.MediaType.NONE) {
            throw new appError_1.AppError(400, "A photo proof is required for this challenge");
        }
        const key = { challengeId_userId_date: { challengeId, userId, date } };
        const existing = await transaction.checkin.findUnique({ where: key });
        if (existing) {
            await transaction.vetoVote.deleteMany({ where: { checkinId: existing.id } });
        }
        return transaction.checkin.upsert({
            where: key,
            create: {
                challengeId,
                userId,
                date,
                status: client_1.CheckinStatus.APPROVED,
                mediaType,
                telegramFileId: telegramFileId ?? null,
                caption: caption ?? null,
            },
            update: {
                status: client_1.CheckinStatus.APPROVED,
                mediaType,
                telegramFileId: telegramFileId ?? null,
                caption: caption ?? null,
            },
        });
    });
}
async function applyShieldToChallenge({ challengeId, userId, timezone, }) {
    const date = (0, timezone_1.getLocalDateString)(new Date(), timezone);
    return db_1.db.$transaction(async (transaction) => {
        const membership = await transaction.challengeMember.findUnique({
            where: { challengeId_userId: { challengeId, userId } },
        });
        if (!membership) {
            throw new appError_1.AppError(403, "You are not a member of this challenge");
        }
        const key = { challengeId_userId_date: { challengeId, userId, date } };
        const existing = await transaction.checkin.findUnique({ where: key });
        if (existing?.status === client_1.CheckinStatus.APPROVED ||
            existing?.status === client_1.CheckinStatus.SHIELDED) {
            throw new appError_1.AppError(409, "Today's check-in is already protected");
        }
        const spentShield = await transaction.user.updateMany({
            where: { id: userId, shieldsCount: { gt: 0 } },
            data: { shieldsCount: { decrement: 1 } },
        });
        if (spentShield.count === 0) {
            throw new appError_1.AppError(409, "No shields are available");
        }
        if (existing) {
            await transaction.vetoVote.deleteMany({ where: { checkinId: existing.id } });
        }
        const checkin = await transaction.checkin.upsert({
            where: key,
            create: {
                challengeId,
                userId,
                date,
                status: client_1.CheckinStatus.SHIELDED,
                mediaType: client_1.MediaType.NONE,
            },
            update: {
                status: client_1.CheckinStatus.SHIELDED,
                mediaType: client_1.MediaType.NONE,
                telegramFileId: null,
                caption: null,
            },
        });
        const user = await transaction.user.findUniqueOrThrow({
            where: { id: userId },
            select: { shieldsCount: true },
        });
        return { checkin, shieldsCount: user.shieldsCount };
    }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
}
async function toggleVetoVote(checkinId, voterId) {
    const result = await db_1.db.$transaction(async (transaction) => {
        const checkin = await transaction.checkin.findUnique({
            where: { id: checkinId },
            include: {
                user: true,
                challenge: { include: { members: true } },
            },
        });
        if (!checkin) {
            throw new appError_1.AppError(404, "Check-in not found");
        }
        if (checkin.userId === voterId) {
            throw new appError_1.AppError(403, "You cannot veto your own check-in");
        }
        if (checkin.status === client_1.CheckinStatus.SHIELDED) {
            throw new appError_1.AppError(409, "Shielded check-ins cannot be vetoed");
        }
        const isMember = checkin.challenge.members.some((member) => member.userId === voterId);
        if (!isMember) {
            throw new appError_1.AppError(403, "Only challenge members can vote");
        }
        const existingVote = await transaction.vetoVote.findUnique({
            where: { checkinId_voterId: { checkinId, voterId } },
        });
        if (existingVote) {
            await transaction.vetoVote.delete({ where: { id: existingVote.id } });
        }
        else {
            await transaction.vetoVote.create({ data: { checkinId, voterId } });
        }
        const vetoCount = await transaction.vetoVote.count({ where: { checkinId } });
        const otherMembersCount = checkin.challenge.members.length - 1;
        const requiredVotes = Math.ceil(otherMembersCount / 2);
        const shouldVeto = otherMembersCount > 0 && vetoCount / otherMembersCount >= 0.5;
        const status = shouldVeto ? client_1.CheckinStatus.VETOED : client_1.CheckinStatus.APPROVED;
        if (checkin.status !== status) {
            await transaction.checkin.update({ where: { id: checkinId }, data: { status } });
        }
        return {
            status,
            vetoCount,
            requiredVotes,
            votedByMe: !existingVote,
            shouldNotify: status === client_1.CheckinStatus.VETOED && checkin.status !== status,
            telegramId: checkin.user.telegramId,
        };
    }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
    if (result.shouldNotify) {
        await (0, telegram_1.sendTelegramMessage)(result.telegramId, "Ваш пруф оспорен участниками. Пересдайте его до 23:59 по вашему местному времени.");
    }
    return {
        status: result.status,
        vetoCount: result.vetoCount,
        requiredVotes: result.requiredVotes,
        votedByMe: result.votedByMe,
    };
}
async function joinChallengeByCode(inviteCode, userId) {
    const now = new Date();
    return db_1.db.$transaction(async (transaction) => {
        const challenge = await transaction.challenge.findUnique({
            where: { inviteCode },
            include: { members: true },
        });
        if (!challenge) {
            throw new appError_1.AppError(404, "Challenge not found");
        }
        const existingMembership = challenge.members.find((member) => member.userId === userId);
        if (existingMembership) {
            return { challenge, joined: false };
        }
        const user = await transaction.user.findUnique({
            where: { id: userId },
            select: { isPro: true, proUntil: true },
        });
        if (!user) {
            throw new appError_1.AppError(404, "User not found");
        }
        const hasActivePro = user.isPro && (!user.proUntil || user.proUntil > now);
        if (!hasActivePro) {
            const memberships = await transaction.challengeMember.findMany({
                where: { userId },
                select: {
                    challenge: { select: { createdAt: true, durationDays: true } },
                },
            });
            const activeChallengeCount = memberships.filter(({ challenge: memberChallenge }) => {
                if (memberChallenge.durationDays === null) {
                    return true;
                }
                const expiresAt = new Date(memberChallenge.createdAt);
                expiresAt.setUTCDate(expiresAt.getUTCDate() + memberChallenge.durationDays);
                return expiresAt > now;
            }).length;
            if (activeChallengeCount >= 3) {
                throw new appError_1.AppError(403, "The free plan allows up to 3 active challenges");
            }
        }
        const newMembership = await transaction.challengeMember.create({
            data: { challengeId: challenge.id, userId },
        });
        return {
            challenge: {
                ...challenge,
                members: [...challenge.members, newMembership],
            },
            joined: true,
        };
    }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
}
