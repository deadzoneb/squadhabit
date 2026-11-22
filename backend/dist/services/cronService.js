"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runRemindersJob = runRemindersJob;
exports.runStreakEvaluationJob = runStreakEvaluationJob;
exports.startCronJobs = startCronJobs;
exports.stopCronJobs = stopCronJobs;
const client_1 = require("@prisma/client");
const node_cron_1 = __importDefault(require("node-cron"));
const db_1 = require("../db");
const telegram_1 = require("../telegram");
const timezone_1 = require("../utils/timezone");
const successfulStatuses = [client_1.CheckinStatus.APPROVED, client_1.CheckinStatus.SHIELDED];
let cronTask;
function isChallengeActive(createdAt, durationDays, now) {
    if (durationDays === null) {
        return true;
    }
    const expiresAt = new Date(createdAt);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
    return expiresAt > now;
}
async function runRemindersJob() {
    const now = new Date();
    const users = await db_1.db.user.findMany({
        where: { memberships: { some: {} } },
        include: { memberships: { include: { challenge: true } } },
    });
    for (const user of users) {
        const activeMemberships = user.memberships.filter(({ challenge }) => isChallengeActive(challenge.createdAt, challenge.durationDays, now));
        if (activeMemberships.length === 0 ||
            (0, timezone_1.getLocalHour)(now, user.timezone) !== user.reminderHour) {
            continue;
        }
        const date = (0, timezone_1.getLocalDateString)(now, user.timezone);
        const existingLog = await db_1.db.notificationLog.findUnique({
            where: { userId_date_type: { userId: user.id, date, type: "REMINDER" } },
        });
        if (existingLog) {
            continue;
        }
        const challengeIds = activeMemberships.map(({ challengeId }) => challengeId);
        const successfulCheckins = await db_1.db.checkin.findMany({
            where: {
                userId: user.id,
                challengeId: { in: challengeIds },
                date,
                status: { in: successfulStatuses },
            },
            select: { challengeId: true },
        });
        const completedChallengeIds = new Set(successfulCheckins.map(({ challengeId }) => challengeId));
        const pendingChallenges = activeMemberships.filter(({ challengeId }) => !completedChallengeIds.has(challengeId));
        if (pendingChallenges.length === 0) {
            continue;
        }
        const claim = await db_1.db.notificationLog.createMany({
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
            await (0, telegram_1.sendTelegramMessage)(user.telegramId, `Не забудьте отметить привычки сегодня:\n${challengeTitles}`);
        }
        catch (error) {
            await db_1.db.notificationLog.delete({
                where: { userId_date_type: { userId: user.id, date, type: "REMINDER" } },
            });
            throw error;
        }
    }
}
async function runStreakEvaluationJob() {
    const now = new Date();
    const challenges = await db_1.db.challenge.findMany({
        include: {
            members: { include: { user: true } },
        },
    });
    for (const challenge of challenges) {
        if (challenge.members.length === 0) {
            continue;
        }
        const westernTimezone = challenge.members.reduce((western, member) => {
            const candidateOffset = (0, timezone_1.getTimezoneOffsetMinutes)(now, member.user.timezone);
            const westernOffset = (0, timezone_1.getTimezoneOffsetMinutes)(now, western);
            return candidateOffset < westernOffset ? member.user.timezone : western;
        }, challenge.members[0].user.timezone);
        const westernToday = (0, timezone_1.getLocalDateString)(now, westernTimezone);
        const targetDate = (0, timezone_1.getPreviousDateString)(westernToday);
        if ((challenge.lastEvaluatedDate && challenge.lastEvaluatedDate >= targetDate) ||
            (0, timezone_1.getLocalDateString)(challenge.createdAt, westernTimezone) > targetDate) {
            continue;
        }
        const eligibleMembers = challenge.members.filter((member) => (0, timezone_1.getLocalDateString)(member.joinedAt, westernTimezone) <= targetDate);
        if (eligibleMembers.length === 0) {
            continue;
        }
        const successfulCheckins = await db_1.db.checkin.findMany({
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
        const nextTeamStreak = challenge.mode === client_1.ChallengeMode.HARDCORE
            ? allCompleted
                ? previousTeamStreak + 1
                : 0
            : anyCompleted
                ? previousTeamStreak + 1
                : 0;
        const nextBestTeamStreak = Math.max(challenge.bestTeamStreak, nextTeamStreak);
        await db_1.db.$transaction(async (transaction) => {
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
        }, { isolationLevel: client_1.Prisma.TransactionIsolationLevel.Serializable });
        if (challenge.mode === client_1.ChallengeMode.HARDCORE &&
            !allCompleted &&
            previousTeamStreak > 0) {
            const missedNames = missedMembers.map(({ user }) => user.firstName).join(", ");
            await Promise.all(challenge.members.map(({ user }) => (0, telegram_1.sendTelegramMessage)(user.telegramId, `Командная серия прервана ${targetDate}. Не отметились: ${missedNames}.`)));
        }
    }
}
function startCronJobs() {
    if (cronTask) {
        return;
    }
    cronTask = node_cron_1.default.schedule("*/15 * * * *", async () => {
        await Promise.all([runRemindersJob(), runStreakEvaluationJob()]);
    });
}
async function stopCronJobs() {
    if (cronTask) {
        const task = cronTask;
        cronTask = undefined;
        await task.stop();
    }
}
