"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEV_TEST_USER = void 0;
exports.validateTelegramInitData = validateTelegramInitData;
const node_crypto_1 = require("node:crypto");
const zod_1 = require("zod");
const config_1 = require("../config");
exports.DEV_TEST_USER = {
    id: 123456789,
    first_name: "SquadHabit Test",
    username: "squadhabit_test",
    language_code: "ru",
};
const MAX_AUTH_AGE_SECONDS = 24 * 60 * 60;
const telegramUserSchema = zod_1.z
    .object({
    id: zod_1.z.number().int().positive().safe(),
    first_name: zod_1.z.string().min(1),
    last_name: zod_1.z.string().optional(),
    username: zod_1.z.string().optional(),
    language_code: zod_1.z.string().optional(),
    photo_url: zod_1.z.string().optional(),
    is_premium: zod_1.z.boolean().optional(),
})
    .passthrough();
function validateTelegramInitData(initData, now = Date.now()) {
    if (!config_1.config.botToken) {
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
    const secretKey = (0, node_crypto_1.createHmac)("sha256", "WebAppData").update(config_1.config.botToken).digest();
    const expectedHash = (0, node_crypto_1.createHmac)("sha256", secretKey).update(dataCheckString).digest();
    const actualHash = Buffer.from(suppliedHash, "hex");
    if (actualHash.length !== expectedHash.length || !(0, node_crypto_1.timingSafeEqual)(actualHash, expectedHash)) {
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
    let parsedJson;
    try {
        parsedJson = JSON.parse(rawUser);
    }
    catch (error) {
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
