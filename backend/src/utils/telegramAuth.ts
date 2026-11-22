import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { config } from "../config";

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  photo_url?: string;
  is_premium?: boolean;
}

export interface ValidatedTelegramInitData {
  user: TelegramWebAppUser;
  startParam?: string;
  authDate: number;
}

export const DEV_TEST_USER: TelegramWebAppUser = {
  id: 123456789,
  first_name: "SquadHabit Test",
  username: "squadhabit_test",
  language_code: "ru",
};

const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const telegramUserSchema = z
  .object({
    id: z.number().int().positive().safe(),
    first_name: z.string().min(1),
    last_name: z.string().optional(),
    username: z.string().optional(),
    language_code: z.string().optional(),
    photo_url: z.string().optional(),
    is_premium: z.boolean().optional(),
  })
  .passthrough();

export function validateTelegramInitData(
  initData: string,
  now = Date.now(),
): ValidatedTelegramInitData {
  if (!config.botToken) {
    throw new Error("BOT_TOKEN is required to validate Telegram initData");
  }

  const params = new URLSearchParams(initData);
  const entries = Array.from(params.entries());
  if (entries.length !== new Set(entries.map(([key]) => key)).size) {
    throw new Error("Telegram initData contains duplicate fields");
  }

  const suppliedHash = params.get("hash");
  if (!suppliedHash || !/^[a-f\d]{64}$/i.test(suppliedHash)) {
    throw new Error("Telegram initData has an invalid hash");
  }

  const dataCheckString = entries
    .filter(([key]) => key !== "hash")
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  const expectedHash = createHmac("sha256", secretKey).update(dataCheckString).digest();
  const actualHash = Buffer.from(suppliedHash, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw new Error("Telegram initData signature verification failed");
  }

  const authDateValue = params.get("auth_date");
  if (!authDateValue || !/^\d+$/.test(authDateValue)) {
    throw new Error("Telegram initData has an invalid auth_date");
  }
  const authDate = Number(authDateValue);
  const currentTimeSeconds = Math.floor(now / 1000);
  if (authDate > currentTimeSeconds || currentTimeSeconds - authDate > MAX_AUTH_AGE_SECONDS) {
    throw new Error("Telegram initData is expired or has a future auth_date");
  }

  const rawUser = params.get("user");
  if (!rawUser) {
    throw new Error("Telegram initData does not include a user");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawUser);
  } catch (error) {
    throw new Error("Telegram initData contains invalid user JSON", { cause: error });
  }
  const parsedUser = telegramUserSchema.parse(parsedJson);

  const startParam = params.get("start_param") ?? undefined;
  return {
    user: parsedUser,
    startParam,
    authDate,
  };
}
