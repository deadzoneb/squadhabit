import { config } from "./config";
import { Bot } from "grammy";

const DEV_FALLBACK_TOKEN = "000000000:DEV_MODE_ONLY_TOKEN";

export const bot =
  config.botToken || config.devMode
    ? new Bot(config.botToken ?? DEV_FALLBACK_TOKEN)
    : undefined;
export const isBotConfigured = Boolean(config.botToken);

export async function sendTelegramMessage(telegramId: bigint, text: string): Promise<void> {
  if (!config.botToken || !bot) {
    console.info(`[telegram] Message for ${telegramId} not sent because BOT_TOKEN is not configured`);
    return;
  }

  await bot.api.sendMessage(telegramId.toString(), text);
}
