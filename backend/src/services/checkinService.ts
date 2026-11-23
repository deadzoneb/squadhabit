import {
  CheckinStatus,
  MediaType,
  Prisma,
  ProofType,
} from "@prisma/client";
import { db } from "../db";
import { sendTelegramMessage } from "../telegram";
import { AppError } from "../utils/appError";
import { getLocalDateString } from "../utils/timezone";

interface SubmitCheckinInput {
  challengeId: string;
  userId: string;
  timezone: string;
  mediaType: MediaType;
  telegramFileId?: string;
  caption?: string;
}

interface ApplyShieldInput {
  challengeId: string;
  userId: string;
  timezone: string;
}

export async function submitCheckin({
  challengeId,
  userId,
  timezone,
  mediaType,
  telegramFileId,
  caption,
}: SubmitCheckinInput) {
  const date = getLocalDateString(new Date(), timezone);

  return db.$transaction(async (transaction) => {
    const membership = await transaction.challengeMember.findUnique({
      where: { challengeId_userId: { challengeId, userId } },
      include: { challenge: true },
    });
    if (!membership) {
      throw new AppError(403, "You are not a member of this challenge");
    }
    if (membership.challenge.proofType === ProofType.PHOTO && mediaType === MediaType.NONE) {
      throw new AppError(400, "A photo proof is required for this challenge");
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
        status: CheckinStatus.APPROVED,
        mediaType,
        telegramFileId: telegramFileId ?? null,
        caption: caption ?? null,
      },
      update: {
        status: CheckinStatus.APPROVED,
        mediaType,
        telegramFileId: telegramFileId ?? null,
        caption: caption ?? null,
      },
    });
  });
}

export async function applyShieldToChallenge({
  challengeId,
  userId,
  timezone,
}: ApplyShieldInput) {
  const date = getLocalDateString(new Date(), timezone);

  return db.$transaction(
    async (transaction) => {
      const membership = await transaction.challengeMember.findUnique({
        where: { challengeId_userId: { challengeId, userId } },
      });
      if (!membership) {
        throw new AppError(403, "You are not a member of this challenge");
      }

      const key = { challengeId_userId_date: { challengeId, userId, date } };
      const existing = await transaction.checkin.findUnique({ where: key });
      if (
        existing?.status === CheckinStatus.APPROVED ||
        existing?.status === CheckinStatus.SHIELDED
      ) {
        throw new AppError(409, "Today's check-in is already protected");
      }

      const spentShield = await transaction.user.updateMany({
        where: { id: userId, shieldsCount: { gt: 0 } },
        data: { shieldsCount: { decrement: 1 } },
      });
      if (spentShield.count === 0) {
        throw new AppError(409, "No shields are available");
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
          status: CheckinStatus.SHIELDED,
          mediaType: MediaType.NONE,
        },
        update: {
          status: CheckinStatus.SHIELDED,
          mediaType: MediaType.NONE,
          telegramFileId: null,
          caption: null,
        },
      });
      const user = await transaction.user.findUniqueOrThrow({
        where: { id: userId },
        select: { shieldsCount: true },
      });
      return { checkin, shieldsCount: user.shieldsCount };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}

export async function toggleVetoVote(checkinId: string, voterId: string) {
  const result = await db.$transaction(
    async (transaction) => {
      const checkin = await transaction.checkin.findUnique({
        where: { id: checkinId },
        include: {
          user: true,
          challenge: { include: { members: true } },
        },
      });
      if (!checkin) {
        throw new AppError(404, "Check-in not found");
      }
      if (checkin.userId === voterId) {
        throw new AppError(403, "You cannot veto your own check-in");
      }
      if (checkin.status === CheckinStatus.SHIELDED) {
        throw new AppError(409, "Shielded check-ins cannot be vetoed");
      }

      const isMember = checkin.challenge.members.some((member) => member.userId === voterId);
      if (!isMember) {
        throw new AppError(403, "Only challenge members can vote");
      }

      const existingVote = await transaction.vetoVote.findUnique({
        where: { checkinId_voterId: { checkinId, voterId } },
      });
      if (existingVote) {
        await transaction.vetoVote.delete({ where: { id: existingVote.id } });
      } else {
        await transaction.vetoVote.create({ data: { checkinId, voterId } });
      }

      const vetoCount = await transaction.vetoVote.count({ where: { checkinId } });
      const otherMembersCount = checkin.challenge.members.length - 1;
      const requiredVotes = Math.ceil(otherMembersCount / 2);
      const shouldVeto =
        otherMembersCount > 0 && vetoCount / otherMembersCount >= 0.5;
      const status = shouldVeto ? CheckinStatus.VETOED : CheckinStatus.APPROVED;
      if (checkin.status !== status) {
        await transaction.checkin.update({ where: { id: checkinId }, data: { status } });
      }

      return {
        status,
        vetoCount,
        requiredVotes,
        votedByMe: !existingVote,
        shouldNotify: status === CheckinStatus.VETOED && checkin.status !== status,
        telegramId: checkin.user.telegramId,
      };
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );

  if (result.shouldNotify) {
    await sendTelegramMessage(
      result.telegramId,
      "Пруф оспорен\nПересдайте до 23:59 по местному времени.",
    );
  }

  return {
    status: result.status,
    vetoCount: result.vetoCount,
    requiredVotes: result.requiredVotes,
    votedByMe: result.votedByMe,
  };
}

export async function joinChallengeByCode(inviteCode: string, userId: string) {
  const now = new Date();
  return db.$transaction(
    async (transaction) => {
      const challenge = await transaction.challenge.findUnique({
        where: { inviteCode },
        include: { members: true },
      });
      if (!challenge) {
        throw new AppError(404, "Challenge not found");
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
        throw new AppError(404, "User not found");
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
          throw new AppError(403, "The free plan allows up to 3 active challenges");
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
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  );
}
