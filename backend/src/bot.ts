import { CheckinStatus, MediaType, Prisma } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { InlineQueryResultArticle, User as TelegramUser } from "grammy/types";
import { z } from "zod";
import { config, FREEZE_MONTHLY_LIMIT, STORE_PRODUCTS } from "./config";
import { prisma } from "./db";
import { bot, getBotUsername, isBotConfigured } from "./telegram";
import { joinChallengeByCode, submitCheckin } from "./services/checkinService";
import {
  activateStarPayment,
  getFreezePurchasesThisMonth,
  getStarPaymentPrice,
} from "./services/starPaymentService";
import { AppError } from "./utils/appError";
import { getLocalDateString } from "./utils/timezone";

const PENDING_PROOF_TTL_MS = 10 * 60 * 1000;
const successfulCheckinStatuses = [CheckinStatus.APPROVED, CheckinStatus.SHIELDED];
const productTypeSchema = z.enum(["SHIELD_1", "SHIELD_5", "PRO_30"]);
const paymentPayloadSchema = z.object({
  userId: z.string().min(1),
  productType: productTypeSchema,
});
const starPaymentPayloadSchema = z.object({
  u: z.string().min(1),
  t: z.enum(["D", "F", "V"]),
  a: z.number().int().optional(),
  n: z.string().min(1),
}).strict();

type ProductType = z.infer<typeof productTypeSchema>;
type StarProductType = "DONATE" | "STREAK_FREEZE" | "VIP_30D";

interface PendingProof {
  fileId: string;
  mediaType: MediaType;
  caption?: string;
  expiresAt: number;
  challengeIds: string[];
}

const pendingProofs = new Map<number, PendingProof>();

let handlersRegistered = false;
let runtimeBotUsername = config.BOT_USERNAME;

export async function upsertBotUser(from: TelegramUser) {
  const telegramId = BigInt(from.id);
  return prisma.user.upsert({
    where: { telegramId },
    create: {
      telegramId,
      firstName: from.first_name,
      username: from.username ?? null,
    },
    update: {
      firstName: from.first_name,
      username: from.username ?? null,
    },
  });
}

function isActiveChallenge(createdAt: Date, durationDays: number | null, now: Date): boolean {
  if (durationDays === null) {
    return true;
  }
  const expiresAt = new Date(createdAt);
  expiresAt.setUTCDate(expiresAt.getUTCDate() + durationDays);
  return expiresAt > now;
}

function parsePaymentPayload(value: string) {
  try {
    const parsedJson: unknown = JSON.parse(value);
    const parsed = paymentPayloadSchema.safeParse(parsedJson);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function parseStarPaymentPayload(value: string): {
  userId: string;
  productType: StarProductType;
  amount?: number;
} | null {
  try {
    const parsed = starPaymentPayloadSchema.safeParse(JSON.parse(value) as unknown);
    if (!parsed.success) {
      return null;
    }
    const productType = parsed.data.t === "D"
      ? "DONATE"
      : parsed.data.t === "F"
        ? "STREAK_FREEZE"
        : "VIP_30D";
    if (
      (productType === "DONATE" && getStarPaymentPrice(productType, parsed.data.a) === null) ||
      (productType !== "DONATE" && parsed.data.a !== undefined)
    ) {
      return null;
    }
    return {
      userId: parsed.data.u,
      productType,
      ...(parsed.data.a !== undefined ? { amount: parsed.data.a } : {}),
    };
  } catch {
    return null;
  }
}

function getPaymentProduct(productType: ProductType) {
  return STORE_PRODUCTS[productType];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function getTrackerKeyboard(url = config.WEBAPP_URL): InlineKeyboard {
  return new InlineKeyboard().webApp("📱 Открыть трекер", url);
}

function getWebAppInviteUrl(inviteCode: string): string {
  const url = new URL(config.WEBAPP_URL);
  url.searchParams.set("startapp", `join_${inviteCode}`);
  return url.toString();
}

function getUserFacingError(error: unknown): string {
  if (error instanceof AppError) {
    if (error.statusCode === 403 && error.message.includes("3 active challenges")) {
      return "Бесплатный тариф позволяет участвовать максимум в 3 активных челленджах.";
    }
    if (error.statusCode === 404) {
      return "Челлендж по этой ссылке не найден.";
    }
    return error.message;
  }
  return "Не удалось выполнить действие. Попробуйте ещё раз позже.";
}

export function registerBotHandlers(): void {
  const activeBot = bot;
  if (!activeBot || handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  activeBot.catch((error) => {
    console.error(
      `[telegram] Update ${error.ctx.update.update_id} failed`,
      error.error,
    );
  });

  activeBot.command("start", async (ctx) => {
    if (!ctx.from) {
      return;
    }
    const user = await upsertBotUser(ctx.from);
    const payload = ctx.match.trim();
    if (payload.startsWith("join_")) {
      const inviteCode = payload.slice("join_".length);
      if (!inviteCode) {
        await ctx.reply("Приглашение не найдено\nПроверьте ссылку и попробуйте снова.", {
          reply_markup: getTrackerKeyboard(),
        });
        return;
      }

      try {
        const result = await joinChallengeByCode(inviteCode, user.id);
        const webAppUrl = getWebAppInviteUrl(inviteCode);
        await ctx.reply(
          result.joined
            ? `Вы вступили\n${result.challenge.emoji} ${result.challenge.title}`
            : `Вы уже участвуете\n${result.challenge.emoji} ${result.challenge.title}`,
          { reply_markup: getTrackerKeyboard(webAppUrl) },
        );
      } catch (error) {
        console.error("[telegram] Failed to join challenge from /start", error);
        await ctx.reply(`Не удалось вступить\n${getUserFacingError(error)}`, {
          reply_markup: getTrackerKeyboard(),
        });
      }
      return;
    }

    await ctx.reply(
      "SquadHabit\nОтмечайте привычки вместе и поддерживайте командную серию.",
      {
        reply_markup: getTrackerKeyboard(),
      },
    );
  });

  activeBot.on("inline_query", async (ctx) => {
    const user = await upsertBotUser(ctx.from);
    const query = ctx.inlineQuery.query.trim().toLowerCase();
    const memberships = await prisma.challengeMember.findMany({
      where: { userId: user.id },
      include: { challenge: { include: { _count: { select: { members: true } } } } },
      orderBy: { joinedAt: "desc" },
    });
    const matchingChallenges = memberships
      .map(({ challenge }) => challenge)
      .filter((challenge) => challenge.title.toLowerCase().includes(query))
      .slice(0, 15);

    let botUsername = runtimeBotUsername ?? activeBot.botInfo?.username ?? await getBotUsername();
    if (!botUsername) {
      throw new Error("Cannot create inline invite links because BOT_USERNAME is unavailable");
    }
    botUsername = botUsername.replace(/^@/, "");
    runtimeBotUsername = botUsername;

    const results: InlineQueryResultArticle[] = matchingChallenges.map((challenge) => {
      const modeLabel = challenge.mode === "HARDCORE" ? "Hardcore" : "Soft";
      const durationLabel =
        challenge.durationDays === null ? "без ограничения" : `${challenge.durationDays} дней`;
      const description =
        `${modeLabel} · ${durationLabel} · участников: ${challenge._count.members}`;
      const inviteUrl = new URL(`https://t.me/${botUsername}`);
      inviteUrl.searchParams.set("start", `join_${challenge.inviteCode}`);
      const message =
        `<b>${escapeHtml(challenge.emoji)} ${escapeHtml(challenge.title)}</b>\n\n` +
        `🔥 Серия команды: <b>${challenge.teamStreak}</b>\n` +
        "Присоединяйся к нам и поддерживай привычку каждый день!";
      return {
        type: "article",
        id: challenge.id,
        title: `${challenge.emoji} ${challenge.title}`,
        description,
        input_message_content: {
          message_text: message,
          parse_mode: "HTML",
        },
        reply_markup: new InlineKeyboard().url("⚡ Принять вызов", inviteUrl.toString()),
      };
    });

    await ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true });
  });

  activeBot.on(["message:photo", "message:video_note", "message:video"], async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Отправьте пруф в личный чат с ботом.");
      return;
    }

    const from = ctx.from;
    const user = await upsertBotUser(from);
    const now = new Date();
    const today = getLocalDateString(now, user.timezone);
    const message = ctx.message;
    const photo = "photo" in message ? message.photo : undefined;
    const videoNote = "video_note" in message ? message.video_note : undefined;
    const video = "video" in message ? message.video : undefined;
    let mediaType: MediaType;
    let fileId: string;
    if (photo?.length) {
      mediaType = MediaType.PHOTO;
      fileId = photo[photo.length - 1].file_id;
    } else if (videoNote) {
      mediaType = MediaType.VIDEO_NOTE;
      fileId = videoNote.file_id;
    } else if (video) {
      mediaType = MediaType.VIDEO;
      fileId = video.file_id;
    } else {
      await ctx.reply("Пруф не распознан\nОтправьте фото или видео ещё раз.", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }
    const caption = ctx.message.caption;

    const memberships = await prisma.challengeMember.findMany({
      where: { userId: user.id },
      include: {
        challenge: {
          include: {
            checkins: {
              where: {
                userId: user.id,
                date: today,
                status: { in: successfulCheckinStatuses },
              },
              select: { id: true },
            },
          },
        },
      },
    });
    const activeMemberships = memberships.filter(({ challenge }) =>
      isActiveChallenge(challenge.createdAt, challenge.durationDays, now),
    );
    if (activeMemberships.length === 0) {
      await ctx.reply("Нет активных привычек\nСоздайте челлендж или примите приглашение.", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }

    const pendingMemberships = activeMemberships.filter(
      ({ challenge }) => challenge.checkins.length === 0,
    );
    if (pendingMemberships.length === 0) {
      await ctx.reply("Сегодня всё отмечено\nОтличная работа!", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }

    if (pendingMemberships.length === 1) {
      const { challenge } = pendingMemberships[0];
      try {
        await submitCheckin({
          challengeId: challenge.id,
          userId: user.id,
          timezone: user.timezone,
          mediaType,
          telegramFileId: fileId,
          ...(caption ? { caption } : {}),
        });
        await ctx.reply(`Пруф засчитан\n${challenge.emoji} ${challenge.title}`, {
          reply_markup: getTrackerKeyboard(),
        });
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }
        await ctx.reply(`Не удалось засчитать пруф\n${getUserFacingError(error)}`, {
          reply_markup: getTrackerKeyboard(),
        });
      }
      return;
    }

    const pendingProof: PendingProof = {
      fileId,
      mediaType,
      expiresAt: Date.now() + PENDING_PROOF_TTL_MS,
      challengeIds: pendingMemberships.map(({ challenge }) => challenge.id),
      ...(caption ? { caption } : {}),
    };
    pendingProofs.set(from.id, pendingProof);
    const expiryTimer = setTimeout(() => {
      if (pendingProofs.get(from.id) === pendingProof) {
        pendingProofs.delete(from.id);
      }
    }, PENDING_PROOF_TTL_MS);
    expiryTimer.unref();

    const keyboard = new InlineKeyboard();
    for (const { challenge } of pendingMemberships) {
      keyboard.text(
        `${challenge.emoji} ${challenge.title}`,
        `assign_proof:${challenge.id}`,
      ).row();
    }
    await ctx.reply("Выберите привычку\nКуда прикрепить этот пруф?", {
      reply_markup: keyboard,
    });
  });

  activeBot.callbackQuery(/^assign_proof:(.+)$/, async (ctx) => {
    const challengeId = ctx.match[1];
    const pendingProof = pendingProofs.get(ctx.from.id);
    if (!pendingProof || pendingProof.expiresAt <= Date.now()) {
      pendingProofs.delete(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "Пруф истёк. Отправьте его ещё раз." });
      return;
    }
    if (!pendingProof.challengeIds.includes(challengeId)) {
      await ctx.answerCallbackQuery({ text: "Этот челлендж не выбран для данного пруфа." });
      return;
    }

    try {
      const user = await upsertBotUser(ctx.from);
      await submitCheckin({
        challengeId,
        userId: user.id,
        timezone: user.timezone,
        mediaType: pendingProof.mediaType,
        telegramFileId: pendingProof.fileId,
        ...(pendingProof.caption ? { caption: pendingProof.caption } : {}),
      });
      pendingProofs.delete(ctx.from.id);
      await ctx.answerCallbackQuery({ text: "Пруф засчитан" });
    } catch (error) {
      await ctx.answerCallbackQuery({ text: getUserFacingError(error) });
      if (!(error instanceof AppError)) {
        throw error;
      }
      return;
    }
    await ctx.editMessageText("Пруф засчитан\nДень закрыт.", {
      reply_markup: getTrackerKeyboard(),
    });
  });

  activeBot.on("pre_checkout_query", async (ctx) => {
    const rawPayload = ctx.preCheckoutQuery.invoice_payload;
    const starPayload = parseStarPaymentPayload(rawPayload);
    const payload = starPayload ? null : parsePaymentPayload(rawPayload);
    let rejectionReason: string | undefined;
    try {
      if (!starPayload && !payload) {
        rejectionReason = "Некорректные данные счёта.";
      } else if (starPayload) {
        const price = getStarPaymentPrice(starPayload.productType, starPayload.amount);
        const user = await prisma.user.findUnique({
          where: { id: starPayload.userId },
          select: { telegramId: true },
        });
        if (!user || user.telegramId !== BigInt(ctx.from.id)) {
          rejectionReason = "Этот счёт создан для другого пользователя.";
        } else if (
          price === null ||
          ctx.preCheckoutQuery.currency !== "XTR" ||
          ctx.preCheckoutQuery.total_amount !== price
        ) {
          rejectionReason = "Сумма или валюта счёта не совпадает с товаром.";
        } else if (
          starPayload.productType === "STREAK_FREEZE" &&
          await getFreezePurchasesThisMonth(prisma, starPayload.userId) >= FREEZE_MONTHLY_LIMIT
        ) {
          rejectionReason = "Лимит покупки заморозок на этот месяц исчерпан.";
        }
      } else {
        const legacyPayload = payload;
        if (!legacyPayload) {
          rejectionReason = "Некорректные данные счёта.";
        } else {
          const product = getPaymentProduct(legacyPayload.productType);
          const user = await prisma.user.findUnique({
            where: { id: legacyPayload.userId },
            select: { telegramId: true },
          });
          if (!user || user.telegramId !== BigInt(ctx.from.id)) {
            rejectionReason = "Этот счёт создан для другого пользователя.";
          } else if (
            ctx.preCheckoutQuery.currency !== "XTR" ||
            ctx.preCheckoutQuery.total_amount !== product.amountXtr
          ) {
            rejectionReason = "Сумма или валюта счёта не совпадает с товаром.";
          }
        }
      }
    } catch (error) {
      console.error("[telegram] Failed to validate pre-checkout query", error);
      rejectionReason = "Не удалось проверить платёж. Попробуйте позже.";
    }

    if (rejectionReason) {
      await ctx.answerPreCheckoutQuery(false, { error_message: rejectionReason });
      return;
    }
    await ctx.answerPreCheckoutQuery(true);
  });

  activeBot.on("message:successful_payment", async (ctx) => {
    const payment = ctx.message.successful_payment;
    const starPayload = parseStarPaymentPayload(payment.invoice_payload);
    if (starPayload) {
      const price = getStarPaymentPrice(starPayload.productType, starPayload.amount);
      if (payment.currency !== "XTR" || price === null || payment.total_amount !== price) {
        console.error("[telegram] Successful Stars payment amount or currency does not match product");
        await ctx.reply("Данные платежа не совпали\nОбратитесь в поддержку.", {
          reply_markup: getTrackerKeyboard(),
        });
        return;
      }

      try {
        const activation = await activateStarPayment({
          database: prisma,
          userId: starPayload.userId,
          telegramId: BigInt(ctx.from.id),
          telegramPaymentChargeId: payment.telegram_payment_charge_id,
          payload: payment.invoice_payload,
          productType: starPayload.productType,
          starsAmount: payment.total_amount,
        });
        if (activation.quotaExceeded) {
          try {
            await activeBot.api.refundStarPayment(
              ctx.from.id,
              payment.telegram_payment_charge_id,
            );
            await ctx.reply("Лимит заморозок исчерпан, Stars возвращены.", {
              reply_markup: getTrackerKeyboard(),
            });
          } catch (refundError) {
            console.error("[telegram] Failed to refund a payment over the freeze limit", refundError);
            await ctx.reply("Лимит заморозок исчерпан. Свяжитесь с поддержкой для возврата Stars.", {
              reply_markup: getTrackerKeyboard(),
            });
          }
          return;
        }
        if (activation.duplicate) {
          await ctx.reply("Покупка уже активирована.", {
            reply_markup: getTrackerKeyboard(),
          });
          return;
        }
        const message = starPayload.productType === "DONATE"
          ? "Спасибо за поддержку SquadHabit! Бейдж спонсора активирован."
          : starPayload.productType === "STREAK_FREEZE"
            ? "Заморозка стрика добавлена."
            : "VIP активирован на 30 дней. Вам также начислена заморозка стрика.";
        await ctx.reply(message, { reply_markup: getTrackerKeyboard() });
      } catch (error) {
        console.error("[telegram] Failed to activate a Stars payment", error);
        await ctx.reply("Не удалось активировать покупку\nОбратитесь в поддержку.", {
          reply_markup: getTrackerKeyboard(),
        });
      }
      return;
    }

    const payload = parsePaymentPayload(payment.invoice_payload);
    if (!payload) {
      console.error("[telegram] Successful payment has an invalid invoice payload");
      await ctx.reply("Покупка не подтверждена\nОбратитесь в поддержку.", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }

    const product = getPaymentProduct(payload.productType);
    if (payment.currency !== "XTR" || payment.total_amount !== product.amountXtr) {
      console.error("[telegram] Successful payment amount or currency does not match product");
      await ctx.reply("Данные платежа не совпали\nОбратитесь в поддержку.", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }

    const existingPayment = await prisma.payment.findUnique({
      where: { telegramPaymentChargeId: payment.telegram_payment_charge_id },
      select: { userId: true, productType: true },
    });
    if (existingPayment) {
      if (
        existingPayment.userId === payload.userId &&
        existingPayment.productType === payload.productType
      ) {
        await ctx.reply("Покупка уже активирована\nБаланс обновлён.", {
          reply_markup: getTrackerKeyboard(),
        });
      } else {
        console.error("[telegram] Payment charge id is already linked to a different purchase");
        await ctx.reply("Платёж уже обработан\nЕсли покупка не отображается, обратитесь в поддержку.", {
          reply_markup: getTrackerKeyboard(),
        });
      }
      return;
    }

    const telegramId = BigInt(ctx.from.id);
    const activation = await (async () => {
      try {
        return await prisma.$transaction(async (transaction) => {
          const user = await transaction.user.findUnique({ where: { id: payload.userId } });
          if (!user || user.telegramId !== telegramId) {
            throw new AppError(403, "Payment user does not match the Telegram account");
          }
          const duplicate = await transaction.payment.findUnique({
            where: { telegramPaymentChargeId: payment.telegram_payment_charge_id },
          });
          if (duplicate) {
            return { duplicate: true as const };
          }

          const proDays = "proDays" in product ? product.proDays : 0;
          const proUntil =
            proDays > 0
              ? new Date(
                  Math.max(Date.now(), user.proUntil?.getTime() ?? 0) +
                    proDays * 24 * 60 * 60 * 1000,
                )
              : user.proUntil;

          await transaction.payment.create({
            data: {
              userId: user.id,
              telegramPaymentChargeId: payment.telegram_payment_charge_id,
              productType: payload.productType,
              amountXtr: payment.total_amount,
            },
          });
          const updatedUser = await transaction.user.update({
            where: { id: user.id },
            data: {
              shieldsCount: { increment: product.shields },
              ...(proDays > 0 ? { isPro: true, proUntil } : {}),
            },
          });
          return {
            duplicate: false as const,
            user: {
              shieldsCount: updatedUser.shieldsCount,
              isPro: updatedUser.isPro,
              proUntil: updatedUser.proUntil,
            },
          };
        });
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return { duplicate: true as const };
        }
        if (error instanceof AppError) {
          console.error("[telegram] Successful payment user verification failed", error);
          await ctx.reply("Платёж не активирован\nОбратитесь в поддержку.", {
            reply_markup: getTrackerKeyboard(),
          });
          return null;
        }
        throw error;
      }
    })();

    if (!activation) {
      return;
    }
    if (activation.duplicate) {
      await ctx.reply("Покупка уже активирована\nБаланс обновлён.", {
        reply_markup: getTrackerKeyboard(),
      });
      return;
    }
    const activatedUser = activation.user;

    const proMessage =
      "proDays" in product && product.proDays > 0
        ? ` PRO до ${activatedUser.proUntil?.toLocaleDateString("ru-RU")}.`
        : "";
    await ctx.reply(
      `Покупка активирована\n+${product.shields} щит(ов). Баланс: ${activatedUser.shieldsCount}.${proMessage}`,
      { reply_markup: getTrackerKeyboard() },
    );
  });
}

export async function startBot(): Promise<void> {
  registerBotHandlers();
  if (!isBotConfigured) {
    console.info(
      config.devMode
        ? "[telegram] Polling skipped in DEV_MODE because BOT_TOKEN is not configured"
        : "[telegram] Polling skipped because BOT_TOKEN is not configured",
    );
    return;
  }
  if (!bot) {
    throw new Error("BOT_TOKEN is configured but the grammY bot instance is unavailable");
  }
  if (bot.isRunning()) {
    return;
  }

  void bot.start({
    onStart: (botInfo) => {
      runtimeBotUsername = config.BOT_USERNAME ?? botInfo.username;
      console.info(`[telegram] Bot @${botInfo.username} started polling`);
    },
  }).catch((error: unknown) => {
    console.error("[telegram] Polling stopped with an error", error);
  });
}

export async function stopBot(): Promise<void> {
  if (bot?.isRunning()) {
    await bot.stop();
  }
  pendingProofs.clear();
}
