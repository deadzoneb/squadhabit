import "dotenv/config";
import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => (value === "" ? undefined : value),
  z.string().min(1).optional(),
);

const envSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default("0.0.0.0"),
  DATABASE_URL: optionalNonEmptyString,
  BOT_TOKEN: optionalNonEmptyString,
  BOT_USERNAME: optionalNonEmptyString,
  WEBAPP_URL: z.string().url().default("http://localhost:5173"),
  STORAGE_CHAT_ID: optionalNonEmptyString,
  DEV_MODE: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((value) => value === "true" || value === "1"),
});

const env = envSchema.parse(process.env);
const botUsername = env.BOT_USERNAME?.trim().replace(/^@/, "") || undefined;

export const config = {
  port: env.PORT,
  host: env.HOST,
  databaseUrl: env.DATABASE_URL,
  botToken: env.BOT_TOKEN,
  botUsername,
  webappUrl: env.WEBAPP_URL,
  BOT_USERNAME: botUsername,
  WEBAPP_URL: env.WEBAPP_URL,
  storageChatId: env.STORAGE_CHAT_ID,
  devMode: env.DEV_MODE,
};

export const STORE_PRODUCTS = {
  SHIELD_1: { amountXtr: 50, shields: 1 },
  SHIELD_5: { amountXtr: 200, shields: 5 },
  PRO_30: { amountXtr: 250, proDays: 30, shields: 3 },
} as const;

export const STAR_PRICES = {
  DONATE: [50, 150, 500],
  STREAK_FREEZE: 50,
  VIP_30D: 200,
} as const;

export const FREEZE_MONTHLY_LIMIT = 2;
