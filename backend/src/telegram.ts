import { config } from "./config";
import { Bot, InlineKeyboard } from "grammy";

const DEV_FALLBACK_TOKEN = "000000000:DEV_MODE_ONLY_TOKEN";

export const bot =
  config.botToken || config.devMode
    ? new Bot(config.botToken ?? DEV_FALLBACK_TOKEN)
    : undefined;
export const isBotConfigured = Boolean(config.botToken);

let cachedBotUsername = config.botUsername ?? null;
let botUsernameRequest: Promise<string | null> | null = null;

export async function getBotUsername(): Promise<string | null> {
  if (cachedBotUsername) {
    return cachedBotUsername;
  }
  if (!bot || !config.botToken) {
    return null;
  }
  if (!botUsernameRequest) {
    botUsernameRequest = bot.api.getMe()
      .then(({ username }) => {
        cachedBotUsername = username?.replace(/^@/, "") ?? null;
        return cachedBotUsername;
      })
      .catch((error: unknown) => {
        botUsernameRequest = null;
        throw error;
      });
  }
  return botUsernameRequest;
}

export async function sendTelegramMessage(telegramId: bigint, text: string): Promise<void> {
  if (!config.botToken || !bot) {
    console.info(`[telegram] Message for ${telegramId} not sent because BOT_TOKEN is not configured`);
    return;
  }

  await bot.api.sendMessage(telegramId.toString(), text, {
    reply_markup: new InlineKeyboard().webApp("📱 Открыть трекер", config.WEBAPP_URL),
  });
}
