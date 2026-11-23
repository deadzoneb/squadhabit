import { Prisma, PrismaClient } from "@prisma/client";
import { FREEZE_MONTHLY_LIMIT } from "../config";

type PaymentDatabase = PrismaClient | Prisma.TransactionClient;

export function getUtcMonthRange(date = new Date()): { start: Date; end: Date } {
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
  const end = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
  return { start, end };
}

export async function getFreezePurchasesThisMonth(
  database: PaymentDatabase,
  userId: string,
  date = new Date(),
): Promise<number> {
  const { start, end } = getUtcMonthRange(date);
  return database.starPayment.count({
    where: {
      userId,
      productType: "STREAK_FREEZE",
      createdAt: { gte: start, lt: end },
    },
  });
}

export async function serializeMonetization<T extends {
  isSupporter: boolean;
  totalDonatedStars: number;
  vipUntil: Date | null;
  streakFreezes: number;
}>(database: PaymentDatabase, user: T & { id: string }, now = new Date()) {
  const freezePurchasesThisMonth = await getFreezePurchasesThisMonth(database, user.id, now);
  return {
    ...user,
    isVip: user.vipUntil !== null && user.vipUntil > now,
    freezePurchasesThisMonth,
    freezeMonthlyLimit: FREEZE_MONTHLY_LIMIT,
  };
}

export function getStarPaymentPrice(productType: string, amount?: number): number | null {
  if (productType === "DONATE") {
    return amount === 50 || amount === 150 || amount === 500 ? amount : null;
  }
  if (productType === "STREAK_FREEZE") {
    return 50;
  }
  if (productType === "VIP_30D") {
    return 200;
  }
  return null;
}

export async function activateStarPayment(input: {
  database: PrismaClient;
  userId: string;
  telegramId: bigint;
  telegramPaymentChargeId: string;
  payload: string;
  productType: "DONATE" | "STREAK_FREEZE" | "VIP_30D";
  starsAmount: number;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  return input.database.$transaction(async (transaction) => {
    await transaction.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${input.userId} FOR UPDATE`;
    const user = await transaction.user.findUnique({ where: { id: input.userId } });
    if (!user || user.telegramId !== input.telegramId) {
      throw new Error("Payment user does not match the Telegram account");
    }

    const existing = await transaction.starPayment.findUnique({
      where: { telegramPaymentChargeId: input.telegramPaymentChargeId },
    });
    if (existing) {
      if (
        existing.userId !== input.userId ||
        existing.payload !== input.payload ||
        existing.productType !== input.productType ||
        existing.starsAmount !== input.starsAmount
      ) {
        throw new Error("Telegram payment charge id is linked to a different purchase");
      }
      return { duplicate: true as const, quotaExceeded: false as const };
    }

    if (
      input.productType === "STREAK_FREEZE" &&
      await getFreezePurchasesThisMonth(transaction, user.id, now) >= FREEZE_MONTHLY_LIMIT
    ) {
      return { duplicate: false as const, quotaExceeded: true as const };
    }

    await transaction.starPayment.create({
      data: {
        userId: user.id,
        telegramPaymentChargeId: input.telegramPaymentChargeId,
        payload: input.payload,
        productType: input.productType,
        starsAmount: input.starsAmount,
      },
    });

    const data: Prisma.UserUpdateInput = input.productType === "DONATE"
      ? {
          isSupporter: true,
          totalDonatedStars: { increment: input.starsAmount },
        }
      : input.productType === "STREAK_FREEZE"
        ? { streakFreezes: { increment: 1 } }
        : {
            vipUntil: new Date(
              Math.max(now.getTime(), user.vipUntil?.getTime() ?? 0) +
                30 * 24 * 60 * 60 * 1000,
            ),
            streakFreezes: { increment: 1 },
          };
    await transaction.user.update({ where: { id: user.id }, data });
    return { duplicate: false as const, quotaExceeded: false as const };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}
