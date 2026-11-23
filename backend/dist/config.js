"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STORE_PRODUCTS = exports.config = void 0;
require("dotenv/config");
const zod_1 = require("zod");
const optionalNonEmptyString = zod_1.z.preprocess((value) => (value === "" ? undefined : value), zod_1.z.string().min(1).optional());
const envSchema = zod_1.z.object({
    PORT: zod_1.z.coerce.number().int().min(1).max(65535).default(3000),
    HOST: zod_1.z.string().min(1).default("0.0.0.0"),
    DATABASE_URL: optionalNonEmptyString,
    BOT_TOKEN: optionalNonEmptyString,
    BOT_USERNAME: optionalNonEmptyString,
    WEBAPP_URL: zod_1.z.string().url().default("http://localhost:5173"),
    STORAGE_CHAT_ID: optionalNonEmptyString,
    DEV_MODE: zod_1.z
        .enum(["true", "false", "1", "0"])
        .optional()
        .transform((value) => value === "true" || value === "1"),
});
const env = envSchema.parse(process.env);
const botUsername = env.BOT_USERNAME?.trim().replace(/^@/, "") || undefined;
exports.config = {
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
exports.STORE_PRODUCTS = {
    SHIELD_1: { amountXtr: 50, shields: 1 },
    SHIELD_5: { amountXtr: 200, shields: 5 },
    PRO_30: { amountXtr: 250, proDays: 30, shields: 3 },
};
