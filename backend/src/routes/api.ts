import {
  CheckinStatus,
  ChallengeMode,
  MediaType,
  ProofType,
  type User,
} from "@prisma/client";
import type { FastifyInstance } from "fastify";
import { InputFile } from "grammy";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { config, STORE_PRODUCTS } from "../config";
import { db } from "../db";
import { bot } from "../telegram";
import {
  applyShieldToChallenge,
  joinChallengeByCode,
  submitCheckin,
  toggleVetoVote,
} from "../services/checkinService";
import { AppError } from "../utils/appError";
import {
  DEV_TEST_USER,
  validateTelegramInitData,
  type TelegramWebAppUser,
} from "../utils/telegramAuth";
import {
  getLastNDates,
  getLocalDateString,
  isValidTimezone,
} from "../utils/timezone";

declare module "fastify" {
  interface FastifyRequest {
    currentUser: User;
    startParam?: string;
  }
}

const timezoneSchema = z.string().min(1).refine(isValidTimezone, "Invalid timezone");
const bootstrapSchema = z.object({
  timezone: timezoneSchema.optional(),
  startParam: z.string().max(512).optional(),
});
const createChallengeSchema = z.object({
  emoji: z.string().trim().min(1).max(16),
  title: z.string().trim().min(1).max(100),
  durationDays: z.number().int().min(1).max(3650).nullable().optional(),
  proofType: z.enum([ProofType.PHOTO, ProofType.BUTTON]),
  mode: z.enum([ChallengeMode.HARDCORE, ChallengeMode.SOFT]),
});
const idParamsSchema = z.object({ id: z.string().min(1).max(128) });
const settingsSchema = z.object({
  reminderHour: z.number().int().min(0).max(23).optional(),
  timezone: timezoneSchema.optional(),
});
const checkinJsonSchema = z.object({
  caption: z.string().trim().max(1024).optional(),
});
const reactionSchema = z.object({
  emoji: z.enum(["🔥", "💪", "👏", "👀"]),
});
const productSchema = z.object({
  productId: z.enum(["SHIELD_1", "SHIELD_5", "PRO_30"]),
});

type CheckinLabel = "DONE" | "PENDING" | "VETOED" | "SHIELDED";

function getCheckinLabel(status: CheckinStatus | null): CheckinLabel {
  if (status === CheckinStatus.APPROVED) {
    return "DONE";
  }
  if (status === CheckinStatus.VETOED) {
    return "VETOED";
  }
  if (status === CheckinStatus.SHIELDED) {
    return "SHIELDED";
  }
  return "PENDING";
}

function serializeUser(user: User) {
  return { ...user, telegramId: user.telegramId.toString() };
}

async function createDevPurchase(
  userId: string,
  productId: keyof typeof STORE_PRODUCTS,
): Promise<{ simulated: true; shieldsCount: number; isPro: boolean; proUntil: Date | null }> {
  const product = STORE_PRODUCTS[productId];
  return db.$transaction(async (transaction) => {
    const user = await transaction.user.findUniqueOrThrow({ where: { id: userId } });
    const now = new Date();
    const proUntil =
      productId === "PRO_30"
        ? new Date(
            Math.max(now.getTime(), user.proUntil?.getTime() ?? 0) +
              STORE_PRODUCTS.PRO_30.proDays * 24 * 60 * 60 * 1000,
          )
        : user.proUntil;

    await transaction.payment.create({
      data: {
        userId,
        telegramPaymentChargeId: `DEV_${randomUUID()}`,
        productType: productId,
        amountXtr: product.amountXtr,
      },
    });
    const updatedUser = await transaction.user.update({
      where: { id: userId },
      data: {
        shieldsCount: { increment: product.shields },
        ...(productId === "PRO_30" ? { isPro: true, proUntil } : {}),
      },
    });
    return {
      simulated: true,
      shieldsCount: updatedUser.shieldsCount,
      isPro: updatedUser.isPro,
      proUntil: updatedUser.proUntil,
    };
  });
}

export function registerApiRoutes(app: FastifyInstance): void {
  app.register(async (api) => {
    api.setErrorHandler((error, request, reply) => {
      if (error instanceof AppError) {
        return reply.code(error.statusCode).send({ error: error.message });
      }
      if (error instanceof Error && "code" in error && error.code === "FST_REQ_FILE_TOO_LARGE") {
        return reply.code(413).send({ error: "Uploaded file exceeds the 15 MB limit" });
      }
      request.log.error({ err: error }, "API request failed");
      return reply.code(500).send({ error: "Internal server error" });
    });

    api.addHook("preHandler", async (request, reply) => {
      if (request.url.split("?")[0] === "/api/health") {
        return;
      }

      const initDataHeader = request.headers["x-telegram-init-data"];
      let telegramUser: TelegramWebAppUser | undefined;
      let startParam: string | undefined;
      if (typeof initDataHeader === "string" && initDataHeader.length > 0) {
        try {
          const validatedData = validateTelegramInitData(initDataHeader);
          telegramUser = validatedData.user;
          startParam = validatedData.startParam;
        } catch (error) {
          if (!config.devMode) {
            return reply.code(401).send({ error: "Invalid Telegram authentication data" });
          }
          request.log.warn({ err: error }, "Using development test user for invalid Telegram auth");
        }
      } else if (!config.devMode) {
        return reply.code(401).send({ error: "Telegram authentication is required" });
      }

      telegramUser ??= DEV_TEST_USER;
      const storedUser = await db.user.upsert({
        where: { telegramId: BigInt(telegramUser.id) },
        create: {
          telegramId: BigInt(telegramUser.id),
          username: telegramUser.username ?? null,
          firstName: telegramUser.first_name,
          photoUrl: telegramUser.photo_url ?? null,
        },
        update: {
          username: telegramUser.username ?? null,
          firstName: telegramUser.first_name,
          photoUrl: telegramUser.photo_url ?? null,
        },
      });
      request.currentUser = storedUser;
      request.startParam = startParam;
    });

    api.get("/api/health", async () => ({ status: "ok" }));

    api.post("/api/bootstrap", async (request, reply) => {
      const parsed = bootstrapSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid bootstrap data", details: parsed.error.issues });
      }

      const user = await db.user.update({
        where: { id: request.currentUser.id },
        data: { ...(parsed.data.timezone ? { timezone: parsed.data.timezone } : {}) },
      });

      let joinedChallengeId: string | null = null;
      let joinError: string | null = null;
      const joinPrefix = "join_";
      const startParam = request.startParam ?? parsed.data.startParam;
      if (startParam?.startsWith(joinPrefix)) {
        const inviteCode = startParam.slice(joinPrefix.length);
        if (!inviteCode) {
          joinError = "Invite code is empty";
        } else {
          try {
            const result = await joinChallengeByCode(inviteCode, user.id);
            joinedChallengeId = result.challenge.id;
          } catch (error) {
            if (error instanceof AppError) {
              joinError = error.message;
            } else {
              throw error;
            }
          }
        }
      }

      return {
        user: serializeUser(user),
        botUsername: config.botUsername ?? null,
        products: STORE_PRODUCTS,
        joinedChallengeId,
        joinError,
      };
    });

    api.get("/api/lobby", async (request) => {
      const memberships = await db.challengeMember.findMany({
        where: { userId: request.currentUser.id },
        include: {
          challenge: {
            include: { members: { include: { user: true } } },
          },
        },
        orderBy: { joinedAt: "asc" },
      });
      const now = new Date();
      const today = getLocalDateString(now, request.currentUser.timezone);
      const challengeIds = memberships.map(({ challengeId }) => challengeId);
      const participantIds = Array.from(
        new Set(memberships.flatMap(({ challenge }) => challenge.members.map(({ userId }) => userId))),
      );
      const localDates = Array.from(
        new Set(
          memberships.flatMap(({ challenge }) =>
            challenge.members.map(({ user }) => getLocalDateString(now, user.timezone)),
          ),
        ),
      );
      const checkins = challengeIds.length
        ? await db.checkin.findMany({
            where: {
              challengeId: { in: challengeIds },
              userId: { in: participantIds },
              date: { in: localDates },
            },
            select: { challengeId: true, userId: true, date: true, status: true },
          })
        : [];
      const checkinByKey = new Map(
        checkins.map((checkin) => [
          `${checkin.challengeId}:${checkin.userId}:${checkin.date}`,
          checkin.status,
        ]),
      );

      const challenges = memberships.map(({ challenge }) => ({
        ...challenge,
        members: challenge.members.map(({ user, ...membership }) => {
          const memberDate = getLocalDateString(now, user.timezone);
          const status = checkinByKey.get(`${challenge.id}:${user.id}:${memberDate}`) ?? null;
          return {
            userId: user.id,
            firstName: user.firstName,
            username: user.username,
            photoUrl: user.photoUrl,
            personalStreak: membership.personalStreak,
            bestStreak: membership.bestStreak,
            status: getCheckinLabel(status),
          };
        }),
      }));
      const completedTodayCount = challenges.filter((challenge) =>
        challenge.members.some(
          (member) =>
            member.userId === request.currentUser.id &&
            (member.status === "DONE" || member.status === "SHIELDED"),
        ),
      ).length;

      return {
        today,
        completedTodayCount,
        totalChallengesCount: memberships.length,
        challenges,
      };
    });

    api.post("/api/challenges", async (request, reply) => {
      const parsed = createChallengeSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid challenge data", details: parsed.error.issues });
      }

      const now = new Date();
      const user = request.currentUser;
      const hasActivePro = user.isPro && (!user.proUntil || user.proUntil > now);
      const challenge = await db.$transaction(
        async (transaction) => {
          if (!hasActivePro) {
            const memberships = await transaction.challengeMember.findMany({
              where: { userId: user.id },
              select: { challenge: { select: { createdAt: true, durationDays: true } } },
            });
            const activeCount = memberships.filter(({ challenge: memberChallenge }) => {
              if (memberChallenge.durationDays === null) {
                return true;
              }
              const expiresAt = new Date(memberChallenge.createdAt);
              expiresAt.setUTCDate(expiresAt.getUTCDate() + memberChallenge.durationDays);
              return expiresAt > now;
            }).length;
            if (activeCount >= 3) {
              throw new AppError(403, "The free plan allows up to 3 active challenges");
            }
          }

          return transaction.challenge.create({
            data: {
              inviteCode: randomBytes(8).toString("hex"),
              emoji: parsed.data.emoji,
              title: parsed.data.title,
              durationDays: parsed.data.durationDays ?? null,
              proofType: parsed.data.proofType,
              mode: parsed.data.mode,
              creatorId: user.id,
              members: { create: { userId: user.id } },
            },
            include: { members: true },
          });
        },
        { isolationLevel: "Serializable" },
      );
      return reply.code(201).send(challenge);
    });

    api.get<{ Params: { id: string } }>("/api/challenges/:id", async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid challenge id" });
      }

      const challenge = await db.challenge.findUnique({
        where: { id: parsedParams.data.id },
        include: { members: { include: { user: true } } },
      });
      if (!challenge) {
        throw new AppError(404, "Challenge not found");
      }
      if (!challenge.members.some(({ userId }) => userId === request.currentUser.id)) {
        throw new AppError(403, "You are not a member of this challenge");
      }

      const now = new Date();
      const today = getLocalDateString(now, request.currentUser.timezone);
      const matrixDates = getLastNDates(7, request.currentUser.timezone, now).reverse();
      const memberIds = challenge.members.map(({ userId }) => userId);
      const matrixCheckins = await db.checkin.findMany({
        where: {
          challengeId: challenge.id,
          userId: { in: memberIds },
          date: { in: matrixDates },
        },
        select: { userId: true, date: true, status: true },
      });
      const matrixByKey = new Map(
        matrixCheckins.map(({ userId, date, status }) => [`${userId}:${date}`, status]),
      );
      const matrix = challenge.members.map(({ user, userId, personalStreak, bestStreak }) => ({
        userId,
        firstName: user.firstName,
        personalStreak,
        bestStreak,
        dates: Object.fromEntries(
          matrixDates.map((date) => [
            date,
            getCheckinLabel(matrixByKey.get(`${userId}:${date}`) ?? null),
          ]),
        ),
      }));
      const feedCheckins = await db.checkin.findMany({
        where: { challengeId: challenge.id, date: today },
        include: {
          user: { select: { id: true, firstName: true, username: true, photoUrl: true } },
          reactions: { select: { userId: true, emoji: true } },
          _count: { select: { vetoVotes: true } },
        },
        orderBy: { createdAt: "desc" },
      });
      const feed = feedCheckins.map(({ reactions, _count, ...checkin }) => {
        const groupedReactions = new Map<string, { count: number; reactedByMe: boolean }>();
        for (const reaction of reactions) {
          const grouped = groupedReactions.get(reaction.emoji) ?? { count: 0, reactedByMe: false };
          grouped.count += 1;
          grouped.reactedByMe ||= reaction.userId === request.currentUser.id;
          groupedReactions.set(reaction.emoji, grouped);
        }
        return {
          ...checkin,
          mediaUrl: checkin.telegramFileId
            ? `/api/media/${encodeURIComponent(checkin.telegramFileId)}`
            : null,
          vetoCount: _count.vetoVotes,
          reactions: Array.from(groupedReactions, ([emoji, counts]) => ({ emoji, ...counts })),
        };
      });

      return {
        challenge: {
          ...challenge,
          members: challenge.members.map(({ user, ...membership }) => ({
            ...membership,
            user: {
              id: user.id,
              firstName: user.firstName,
              username: user.username,
              photoUrl: user.photoUrl,
            },
          })),
        },
        today,
        feed,
        matrixDates,
        matrix,
      };
    });

    api.post<{ Params: { id: string } }>("/api/challenges/:id/checkin", async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid challenge id" });
      }
      const challengeId = parsedParams.data.id;
      const challenge = await db.challenge.findFirst({
        where: {
          id: challengeId,
          members: { some: { userId: request.currentUser.id } },
        },
        select: { proofType: true },
      });
      if (!challenge) {
        throw new AppError(404, "Challenge not found or user is not a member");
      }

      let caption: string | undefined;
      let telegramFileId: string | undefined;
      let mediaType: MediaType = MediaType.NONE;
      if (request.isMultipart()) {
        if (challenge.proofType !== ProofType.PHOTO) {
          throw new AppError(400, "This challenge uses button proof, not photo uploads");
        }
        let photoBuffer: Buffer | undefined;
        let filename = "proof.jpg";
        for await (const part of request.parts()) {
          if (part.type === "file") {
            if (photoBuffer) {
              throw new AppError(400, "Only one photo can be uploaded");
            }
            if (!part.mimetype.startsWith("image/")) {
              throw new AppError(415, "Only image uploads are supported");
            }
            filename = part.filename || filename;
            photoBuffer = await part.toBuffer();
          } else if (part.fieldname === "caption" && typeof part.value === "string") {
            const parsedCaption = checkinJsonSchema.safeParse({ caption: part.value });
            if (!parsedCaption.success) {
              throw new AppError(400, "Caption must be 1024 characters or fewer");
            }
            caption = parsedCaption.data.caption;
          }
        }
        if (!photoBuffer) {
          throw new AppError(400, "A photo file is required");
        }
        mediaType = MediaType.PHOTO;
        if (config.botToken && bot) {
          const targetChat = config.storageChatId ?? request.currentUser.telegramId.toString();
          const message = await bot.api.sendPhoto(
            targetChat,
            new InputFile(photoBuffer, filename),
            { caption },
          );
          const uploadedPhoto = message.photo?.at(-1);
          if (!uploadedPhoto) {
            throw new AppError(502, "Telegram did not return the uploaded photo");
          }
          telegramFileId = uploadedPhoto.file_id;
        } else if (config.devMode) {
          telegramFileId = `DEV_PHOTO_${randomBytes(8).toString("hex")}`;
        } else {
          throw new AppError(503, "Telegram photo storage is not configured");
        }
      } else {
        const parsedBody = checkinJsonSchema.safeParse(request.body ?? {});
        if (!parsedBody.success) {
          return reply.code(400).send({ error: "Invalid check-in data", details: parsedBody.error.issues });
        }
        if (challenge.proofType === ProofType.PHOTO) {
          throw new AppError(400, "A photo file is required for this challenge");
        }
        caption = parsedBody.data.caption;
      }

      const checkin = await submitCheckin({
        challengeId,
        userId: request.currentUser.id,
        timezone: request.currentUser.timezone,
        mediaType,
        ...(telegramFileId ? { telegramFileId } : {}),
        ...(caption ? { caption } : {}),
      });
      return reply.code(201).send({ checkin });
    });

    api.post<{ Params: { id: string } }>("/api/challenges/:id/shield", async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid challenge id" });
      }
      const result = await applyShieldToChallenge({
        challengeId: parsedParams.data.id,
        userId: request.currentUser.id,
        timezone: request.currentUser.timezone,
      });
      return reply.send(result);
    });

    api.post<{ Params: { id: string } }>("/api/checkins/:id/veto", async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      if (!parsedParams.success) {
        return reply.code(400).send({ error: "Invalid check-in id" });
      }
      return toggleVetoVote(parsedParams.data.id, request.currentUser.id);
    });

    api.post<{ Params: { id: string } }>("/api/checkins/:id/reactions", async (request, reply) => {
      const parsedParams = idParamsSchema.safeParse(request.params);
      const parsedBody = reactionSchema.safeParse(request.body);
      if (!parsedParams.success || !parsedBody.success) {
        return reply.code(400).send({ error: "Invalid reaction request" });
      }
      const { id: checkinId } = parsedParams.data;
      const { emoji } = parsedBody.data;
      const result = await db.$transaction(async (transaction) => {
        const checkin = await transaction.checkin.findUnique({
          where: { id: checkinId },
          include: { challenge: { include: { members: true } } },
        });
        if (!checkin) {
          throw new AppError(404, "Check-in not found");
        }
        if (!checkin.challenge.members.some(({ userId }) => userId === request.currentUser.id)) {
          throw new AppError(403, "Only challenge members can react");
        }
        const existing = await transaction.reaction.findUnique({
          where: { checkinId_userId_emoji: { checkinId, userId: request.currentUser.id, emoji } },
        });
        if (existing) {
          await transaction.reaction.delete({ where: { id: existing.id } });
        } else {
          await transaction.reaction.create({
            data: { checkinId, userId: request.currentUser.id, emoji },
          });
        }
        const count = await transaction.reaction.count({ where: { checkinId, emoji } });
        return { added: !existing, count };
      });
      return { checkinId, emoji, ...result };
    });

    api.get("/api/me", async (request) => ({
      user: serializeUser(request.currentUser),
      challenges: await db.challengeMember.findMany({
        where: { userId: request.currentUser.id },
        include: { challenge: true },
        orderBy: { joinedAt: "asc" },
      }),
    }));

    api.patch("/api/me/settings", async (request, reply) => {
      const parsed = settingsSchema.safeParse(request.body);
      if (!parsed.success || Object.keys(parsed.data ?? {}).length === 0) {
        return reply.code(400).send({ error: "Invalid settings data", details: parsed.success ? [] : parsed.error.issues });
      }
      const user = await db.user.update({
        where: { id: request.currentUser.id },
        data: parsed.data,
      });
      return { user: serializeUser(user) };
    });

    api.post("/api/payments/invoice", async (request, reply) => {
      const parsed = productSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid product", details: parsed.error.issues });
      }
      const productId = parsed.data.productId;
      const product = STORE_PRODUCTS[productId];
      if (!config.botToken) {
        if (!config.devMode) {
          throw new AppError(503, "Telegram payments are not configured");
        }
        return createDevPurchase(request.currentUser.id, productId);
      }
      if (!bot) {
        throw new AppError(503, "Telegram bot is not configured");
      }

      const invoiceUrl = await bot.api.createInvoiceLink(
        productId === "PRO_30" ? "SquadHabit PRO на 30 дней" : "Щиты SquadHabit",
        productId === "PRO_30" ? "30 дней PRO и 3 щита" : `Щиты: ${product.shields}`,
        JSON.stringify({ userId: request.currentUser.id, productType: productId }),
        "",
        "XTR",
        [{ label: productId, amount: product.amountXtr }],
      );
      return { invoiceUrl };
    });
  });
}
