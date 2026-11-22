import { CheckinStatus, ChallengeMode, Prisma } from "@prisma/client";
import cron, { type ScheduledTask } from "node-cron";
import { db } from "../db";
import { sendTelegramMessage } from "../telegram";
import { getLocalDateString, getLocalHour, getPreviousDateString, getTimezoneOffsetMinutes } from "../utils/timezone";

const successfulStatuses = [CheckinStatus.APPROVED, CheckinStatus.SHIELDED];
let cronTask: ScheduledTask | undefined;

function isChallengeActive(createdAt: Date, durationDays: number | null, now: Date): boolean {
  if (durationDays === null) {
    return true;
  }
  const expiresAt = new Date(createdAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
  return expiresAt > now;
}

export async function runRemindersJob(): Promise<void> {
  const now = new Date();
  const users = await db.user.findMany({
    where: { memberships: { some: {} } },
    include: { memberships: { include: { challenge: true } } },
  });

  for (const user of users) {
    const activeMemberships = user.memberships.filter(({ challenge }) =>
      isChallengeActive(challenge.createdAt, challenge.durationDays, now),
    );
    if (
      activeMemberships.length === 0 ||
      getLocalHour(now, user.timezone) !== user.reminderHour
    ) {
      continue;
    }

    const date = getLocalDateString(now, user.timezone);
    const existingLog = await db.notificationLog.findUnique({
      where: { userId_date_type: { userId: user.id, date, type: "REMINDER" } },
    });
    if (existingLog) {
      continue;
    }

    const challengeIds = activeMemberships.map(({ challengeId }) => challengeId);
    const successfulCheckins = await db.checkin.findMany({
      where: {
        userId: user.id,
        challengeId: { in: challengeIds },
        date,
        status: { in: successfulStatuses },
      },
      select: { challengeId: true },
    });
    const completedChallengeIds = new Set(successfulCheckins.map(({ challengeId }) => challengeId));
    const pendingChallenges = activeMemberships.filter(
      ({ challengeId }) => !completedChallengeIds.has(challengeId),
    );
    if (pendingChallenges.length === 0) {
      continue;
    }

    const claim = await db.notificationLog.createMany({
      data: [{ userId: user.id, date, type: "REMINDER" }],
      skipDuplicates: true,
    });
    if (claim.count === 0) {
      continue;
    }

    const challengeTitles = pendingChallenges
      .map(({ challenge }) => `${challenge.emoji} ${challenge.title}`)
      .join("\n");
    try {
      await sendTelegramMessage(
        user.telegramId,
        `Не забудьте отметить привычки сегодня:\n${challengeTitles}`,
      );
    } catch (error) {
      await db.notificationLog.delete({
        where: { userId_date_type: { userId: user.id, date, type: "REMINDER" } },
      });
      throw error;
    }
  }
}

export async function runStreakEvaluationJob(): Promise<void> {
  const now = new Date();
  const challenges = await db.challenge.findMany({
    include: {
      members: { include: { user: true } },
    },
  });

  for (const challenge of challenges) {
    if (challenge.members.length === 0) {
      continue;
    }

    const westernTimezone = challenge.members.reduce((western, member) => {
      const candidateOffset = getTimezoneOffsetMinutes(now, member.user.timezone);
      const westernOffset = getTimezoneOffsetMinutes(now, western);
      return candidateOffset < westernOffset ? member.user.timezone : western;
    }, challenge.members[0].user.timezone);
    const westernToday = getLocalDateString(now, westernTimezone);
    const targetDate = getPreviousDateString(westernToday);
    if (
      (challenge.lastEvaluatedDate && challenge.lastEvaluatedDate >= targetDate) ||
      getLocalDateString(challenge.createdAt, westernTimezone) > targetDate
    ) {
      continue;
    }

    const eligibleMembers = challenge.members.filter(
      (member) => getLocalDateString(member.joinedAt, westernTimezone) <= targetDate,
    );
    if (eligibleMembers.length === 0) {
      continue;
    }

    const successfulCheckins = await db.checkin.findMany({
      where: {
        challengeId: challenge.id,
        userId: { in: eligibleMembers.map(({ userId }) => userId) },
        date: targetDate,
        status: { in: successfulStatuses },
      },
      select: { userId: true },
    });
    const completedUserIds = new Set(successfulCheckins.map(({ userId }) => userId));
    const missedMembers = eligibleMembers.filter(({ userId }) => !completedUserIds.has(userId));
    const allCompleted = missedMembers.length === 0;
    const anyCompleted = completedUserIds.size > 0;
    const previousTeamStreak = challenge.teamStreak;
    const nextTeamStreak =
      challenge.mode === ChallengeMode.HARDCORE
        ? allCompleted
          ? previousTeamStreak + 1
          : 0
        : anyCompleted
          ? previousTeamStreak + 1
          : 0;
    const nextBestTeamStreak = Math.max(challenge.bestTeamStreak, nextTeamStreak);

    await db.$transaction(async (transaction) => {
      for (const member of eligibleMembers) {
        const personalStreak = completedUserIds.has(member.userId)
          ? member.personalStreak + 1
          : 0;
        await transaction.challengeMember.update({
          where: { id: member.id },
          data: {
            personalStreak,
            bestStreak: Math.max(member.bestStreak, personalStreak),
          },
        });
      }

      await transaction.challenge.update({
        where: { id: challenge.id },
        data: {
          teamStreak: nextTeamStreak,
          bestTeamStreak: nextBestTeamStreak,
          lastEvaluatedDate: targetDate,
        },
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });

    if (
      challenge.mode === ChallengeMode.HARDCORE &&
      !allCompleted &&
      previousTeamStreak > 0
    ) {
      const missedNames = missedMembers.map(({ user }) => user.firstName).join(", ");
      await Promise.all(
        challenge.members.map(({ user }) =>
          sendTelegramMessage(
            user.telegramId,
            `Командная серия прервана ${targetDate}. Не отметились: ${missedNames}.`,
          ),
        ),
      );
    }
  }
}

export function startCronJobs(): void {
  if (cronTask) {
    return;
  }
  cronTask = cron.schedule("*/15 * * * *", async () => {
    await Promise.all([runRemindersJob(), runStreakEvaluationJob()]);
  });
}

export async function stopCronJobs(): Promise<void> {
  if (cronTask) {
    const task = cronTask;
    cronTask = undefined;
    await task.stop();
  }
}
