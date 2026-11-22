import { CheckinStatus, MediaType, Prisma } from "@prisma/client";
import { InlineKeyboard } from "grammy";
import type { InlineQueryResultArticle, User as TelegramUser } from "grammy/types";
import { z } from "zod";
import { config, STORE_PRODUCTS } from "./config";
import { prisma } from "./db";
import { bot, isBotConfigured } from "./telegram";
import { joinChallengeByCode, submitCheckin } from "./services/checkinService";
import { AppError } from "./utils/appError";
import { getLocalDateString } from "./utils/timezone";

const PENDING_PROOF_TTL_MS = 10 * 60 * 1000;
const successfulCheckinStatuses = [CheckinStatus.APPROVED, CheckinStatus.SHIELDED];
const productTypeSchema = z.enum(["SHIELD_1", "SHIELD_5", "PRO_30"]);
const paymentPayloadSchema = z.object({
  userId: z.string().min(1),
  productType: productTypeSchema,
});

type ProductType = z.infer<typeof productTypeSchema>;

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

function getPaymentProduct(productType: ProductType) {
  return STORE_PRODUCTS[productType];
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
        await ctx.reply("В ссылке отсутствует код приглашения.");
        return;
      }

      try {
        const result = await joinChallengeByCode(inviteCode, user.id);
        const message = result.joined
          ? `Вы вступили в челлендж «${result.challenge.title}»!`
          : `Вы уже участвуете в челлендже «${result.challenge.title}».`;
        const webAppUrl = `${config.WEBAPP_URL}?startapp=join_${encodeURIComponent(inviteCode)}`;
        await ctx.reply(
          message,
          { reply_markup: new InlineKeyboard().webApp("🚀 Открыть челлендж", webAppUrl) },
        );
      } catch (error) {
        console.error("[telegram] Failed to join challenge from /start", error);
        await ctx.reply(getUserFacingError(error));
      }
      return;
    }

    await ctx.reply(
      "Привет! В SquadHabit вы объединяетесь в команды, отмечаете привычки каждый день и поддерживаете общую серию. Друзья могут подтвердить пруф, а щит поможет сохранить серию, если день не задался.",
      {
        reply_markup: new InlineKeyboard().webApp(
          "📱 Открыть трекер привычек",
          config.WEBAPP_URL,
        ),
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

    let botUsername = runtimeBotUsername ?? activeBot.botInfo?.username;
    if (!botUsername) {
      botUsername = (await activeBot.api.getMe()).username;
      runtimeBotUsername = botUsername;
    }

    const results: InlineQueryResultArticle[] = matchingChallenges.map((challenge) => {
      const modeLabel = challenge.mode === "HARDCORE" ? "Hardcore" : "Soft";
      const durationLabel =
        challenge.durationDays === null ? "без ограничения" : `${challenge.durationDays} дней`;
      const description =
        `${modeLabel} · ${durationLabel} · участников: ${challenge._count.members}`;
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
        reply_markup: new InlineKeyboard().url(
          "⚡ Принять вызов",
          `https://t.me/${botUsername}?start=join_${challenge.inviteCode}`,
        ),
      };
    });

    await ctx.answerInlineQuery(results, { cache_time: 5, is_personal: true });
  });

  activeBot.on(["message:photo", "message:video_note"], async (ctx) => {
    if (ctx.chat.type !== "private") {
      await ctx.reply("Отправьте фото или видеокружок в личный чат со мной.");
      return;
    }

    const from = ctx.from;
    const user = await upsertBotUser(from);
    const now = new Date();
    const today = getLocalDateString(now, user.timezone);
    const mediaType =
      ctx.message.photo !== undefined ? MediaType.PHOTO : MediaType.VIDEO_NOTE;
    const fileId =
      ctx.message.photo !== undefined
        ? ctx.message.photo[ctx.message.photo.length - 1].file_id
        : ctx.message.video_note.file_id;
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
      await ctx.reply("У вас пока нет активных челленджей. Создайте или примите приглашение в приложении.");
      return;
    }

    const pendingMemberships = activeMemberships.filter(
      ({ challenge }) => challenge.checkins.length === 0,
    );
    if (pendingMemberships.length === 0) {
      await ctx.reply("Все ваши привычки на сегодня уже закрыты. Отличная работа!");
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
        await ctx.reply(`Пруф засчитан для «${challenge.title}»!`);
      } catch (error) {
        if (!(error instanceof AppError)) {
          throw error;
        }
        await ctx.reply(getUserFacingError(error));
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
    await ctx.reply("К какому челленджу прикрепить этот пруф?", {
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
    await ctx.editMessageText("Пруф успешно засчитан!");
  });

  activeBot.on("pre_checkout_query", async (ctx) => {
    const payload = parsePaymentPayload(ctx.preCheckoutQuery.invoice_payload);
    let rejectionReason: string | undefined;
    try {
      if (!payload) {
        rejectionReason = "Некорректные данные счёта.";
      } else {
        const product = getPaymentProduct(payload.productType);
        const user = await prisma.user.findUnique({
          where: { id: payload.userId },
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
    const payload = parsePaymentPayload(payment.invoice_payload);
    if (!payload) {
      console.error("[telegram] Successful payment has an invalid invoice payload");
      await ctx.reply("Не удалось проверить покупку. Обратитесь в поддержку.");
      return;
    }

    const product = getPaymentProduct(payload.productType);
    if (payment.currency !== "XTR" || payment.total_amount !== product.amountXtr) {
      console.error("[telegram] Successful payment amount or currency does not match product");
      await ctx.reply("Данные платежа не совпали с товаром. Обратитесь в поддержку.");
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
        await ctx.reply("Эта покупка уже была активирована.");
      } else {
        console.error("[telegram] Payment charge id is already linked to a different purchase");
        await ctx.reply("Платёж уже обработан. Если покупка не отображается, обратитесь в поддержку.");
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
          await ctx.reply("Не удалось связать платёж с аккаунтом. Обратитесь в поддержку.");
          return null;
        }
        throw error;
      }
    })();

    if (!activation) {
      return;
    }
    if (activation.duplicate) {
      await ctx.reply("Эта покупка уже была активирована.");
      return;
    }
    const activatedUser = activation.user;

    const proMessage =
      "proDays" in product && product.proDays > 0
        ? ` PRO активен до ${activatedUser.proUntil?.toLocaleDateString("ru-RU")}.`
        : "";
    await ctx.reply(
      `Покупка активирована: добавлено ${product.shields} щит(ов). Сейчас у вас ${activatedUser.shieldsCount}.${proMessage}`,
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
