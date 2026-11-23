import type { ToastMessage } from "../types";

type HapticImpactStyle = "light" | "medium" | "heavy" | "rigid" | "soft";
type HapticNotificationType = "error" | "success" | "warning";
type HapticEvent =
  | { type: "impact"; style: HapticImpactStyle }
  | { type: "notification"; style: HapticNotificationType }
  | { type: "selection" };

interface TelegramWebApp {
  ready(): void;
  expand(): void;
  initData: string;
  initDataUnsafe?: {
    start_param?: string;
  };
  HapticFeedback?: {
    impactOccurred(style: HapticImpactStyle): void;
    notificationOccurred(type: HapticNotificationType): void;
    selectionChanged(): void;
  };
  switchInlineQuery?(
    query: string,
    chooseChatTypes?: Array<"users" | "bots" | "groups" | "channels">,
  ): void;
  openInvoice(
    url: string,
    callback?: (status: "paid" | "cancelled" | "failed" | "pending") => void,
  ): void;
}

declare global {
  interface Window {
    Telegram?: {
      WebApp?: TelegramWebApp;
    };
  }
}

export const TOAST_EVENT = "squadhabit:toast";

export function getTelegramWebApp(): TelegramWebApp | undefined {
  return window.Telegram?.WebApp;
}

export function initTelegramWebApp(): void {
  const webApp = getTelegramWebApp();
  webApp?.ready();
  webApp?.expand();
}

export function getInitData(): string {
  return getTelegramWebApp()?.initData ?? "";
}

export function getStartParam(): string {
  const telegramStartParam = getTelegramWebApp()?.initDataUnsafe?.start_param;
  if (telegramStartParam) {
    return telegramStartParam;
  }
  return new URLSearchParams(window.location.search).get("startapp") ?? "";
}

export function haptic(event: HapticEvent): void {
  const feedback = getTelegramWebApp()?.HapticFeedback;
  if (!feedback) {
    return;
  }
  if (event.type === "impact") {
    feedback.impactOccurred(event.style);
  } else if (event.type === "notification") {
    feedback.notificationOccurred(event.style);
  } else {
    feedback.selectionChanged();
  }
}

function showToast(message: string, type: ToastMessage["type"]): void {
  window.dispatchEvent(new CustomEvent<ToastMessage>(TOAST_EVENT, {
    detail: { message, type },
  }));
}

async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Continue with the selection-based fallback.
    }
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "");
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

export async function shareChallengeInline(
  title: string,
  inviteCode: string,
  botUsername: string | null | undefined,
): Promise<void> {
  const webApp = getTelegramWebApp();
  if (webApp?.switchInlineQuery) {
    try {
      webApp.switchInlineQuery(title, ["users", "groups", "channels"]);
      return;
    } catch (error) {
      console.warn("[telegram] Unable to open inline sharing", error);
    }
  }

  const normalizedBotUsername = botUsername?.trim().replace(/^@/, "");
  if (!normalizedBotUsername) {
    showToast("Не удалось создать приглашение: не настроено имя бота", "error");
    return;
  }
  const inviteUrl = new URL(`https://t.me/${normalizedBotUsername}`);
  inviteUrl.searchParams.set("start", `join_${inviteCode}`);
  const copied = await copyText(inviteUrl.toString());
  showToast(
    copied ? "Ссылка-приглашение скопирована" : "Не удалось скопировать ссылку",
    copied ? "success" : "error",
  );
}
