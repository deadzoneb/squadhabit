"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isBotConfigured = exports.bot = void 0;
exports.sendTelegramMessage = sendTelegramMessage;
const config_1 = require("./config");
const grammy_1 = require("grammy");
const DEV_FALLBACK_TOKEN = "000000000:DEV_MODE_ONLY_TOKEN";
exports.bot = config_1.config.botToken || config_1.config.devMode
    ? new grammy_1.Bot(config_1.config.botToken ?? DEV_FALLBACK_TOKEN)
    : undefined;
exports.isBotConfigured = Boolean(config_1.config.botToken);
async function sendTelegramMessage(telegramId, text) {
    if (!config_1.config.botToken || !exports.bot) {
        console.info(`[telegram] Message for ${telegramId} not sent because BOT_TOKEN is not configured`);
        return;
    }
    await exports.bot.api.sendMessage(telegramId.toString(), text);
}
