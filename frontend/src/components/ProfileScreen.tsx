import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { getTelegramWebApp, haptic } from "../lib/telegram";
import type {
  LobbyResponse,
  ProductCatalog,
  ProductType,
  User,
} from "../types";

interface ProfileScreenProps {
  user: User;
  lobby: LobbyResponse | null;
  products: ProductCatalog;
  onUserUpdated: (user: User) => void;
  onDataChanged: () => Promise<void>;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
}

function isProActive(user: User): boolean {
  return user.isPro && (!user.proUntil || new Date(user.proUntil).getTime() > Date.now());
}

export default function ProfileScreen({
  user,
  lobby,
  products,
  onUserUpdated,
  onDataChanged,
  onToast,
}: ProfileScreenProps) {
  const [reminderHour, setReminderHour] = useState(user.reminderHour);
  const [selectedChallengeId, setSelectedChallengeId] = useState("");
  const [savingSettings, setSavingSettings] = useState(false);
  const [purchasing, setPurchasing] = useState<ProductType | null>(null);

  const eligibleChallenges = useMemo(
    () =>
      (lobby?.challenges ?? []).filter((challenge) => {
        const member = challenge.members.find(({ userId }) => userId === user.id);
        return member?.status === "PENDING" || member?.status === "VETOED";
      }),
    [lobby, user.id],
  );

  useEffect(() => {
    setReminderHour(user.reminderHour);
  }, [user.reminderHour]);

  useEffect(() => {
    if (!eligibleChallenges.some(({ id }) => id === selectedChallengeId)) {
      setSelectedChallengeId(eligibleChallenges[0]?.id ?? "");
    }
  }, [eligibleChallenges, selectedChallengeId]);

  async function saveReminder(hour: number) {
    setReminderHour(hour);
    setSavingSettings(true);
    try {
      const result = await api.updateSettings({ reminderHour: hour });
      onUserUpdated(result.user);
      onToast("Время напоминания сохранено", "success");
      haptic({ type: "notification", style: "success" });
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось сохранить настройки", "error");
      setReminderHour(user.reminderHour);
    } finally {
      setSavingSettings(false);
    }
  }

  async function applyShield() {
    if (!selectedChallengeId) {
      onToast("Выберите челлендж, который нужно защитить", "error");
      return;
    }
    try {
      const result = await api.applyShield(selectedChallengeId);
      onToast(`Щит применён. Осталось: ${result.shieldsCount}`, "success");
      haptic({ type: "notification", style: "success" });
      await onDataChanged();
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось применить щит", "error");
    }
  }

  async function buyProduct(productType: ProductType, amount?: number) {
    if (purchasing) {
      return;
    }
    setPurchasing(productType);
    try {
      const invoice = await api.createInvoice(productType, amount);
      if (!("invoiceUrl" in invoice)) {
        onToast("Покупка успешно активирована", "success");
        await onDataChanged();
        return;
      }

      const webApp = getTelegramWebApp();
      if (!webApp) {
        window.open(invoice.invoiceUrl, "_blank", "noopener,noreferrer");
        onToast("Счёт открыт в новой вкладке", "info");
        return;
      }
      webApp.openInvoice(invoice.invoiceUrl, (status) => {
        if (status === "paid") {
          onToast("Покупка оплачена и активируется", "success");
          void onDataChanged().catch((refreshError: unknown) => {
            onToast(refreshError instanceof Error ? refreshError.message : "Не удалось обновить профиль", "error");
          });
          window.setTimeout(() => {
            void onDataChanged().catch((refreshError: unknown) => {
              onToast(refreshError instanceof Error ? refreshError.message : "Не удалось обновить профиль", "error");
            });
          }, 1500);
        } else if (status === "failed") {
          onToast("Платёж не прошёл. Попробуйте ещё раз.", "error");
        } else if (status === "cancelled") {
          onToast("Оплата отменена", "info");
        }
      });
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось создать счёт", "error");
    } finally {
      setPurchasing(null);
    }
  }

  const initials = user.firstName.trim().slice(0, 1).toUpperCase() || "?";
  const proActive = isProActive(user);

  return (
    <section>
      <div className="screen-heading">
        <div>
          <h1>Профиль</h1>
          <p>Ваши настройки и покупки</p>
        </div>
      </div>

      <section className="card profile-card">
        {user.photoUrl ? (
          <img className={`avatar profile-avatar${user.isVip ? " avatar--vip" : ""}`} src={user.photoUrl} alt={user.firstName} />
        ) : (
          <span className={`avatar profile-avatar${user.isVip ? " avatar--vip" : ""}`}>{initials}</span>
        )}
        <div className="profile-details">
          <h2>{user.firstName}</h2>
          {user.username && <span className="muted">@{user.username}</span>}
          {proActive && <span className="pro-badge">✦ PRO{user.proUntil ? ` до ${new Date(user.proUntil).toLocaleDateString()}` : ""}</span>}
          {user.isVip && user.vipUntil && <span className="member-badge member-badge--vip">VIP · до {new Date(user.vipUntil).toLocaleDateString("ru-RU")}</span>}
          {user.isSupporter && <span className="member-badge member-badge--supporter">⭐ Поддержал проект</span>}
          <p className="muted">Часовой пояс: {user.timezone}</p>
        </div>
      </section>

      <section className="card profile-stats">
        <strong>Заморозки стрика: {user.streakFreezes}</strong>
        <span className="muted">Поддержка проекта: {user.totalDonatedStars} ⭐</span>
      </section>

      <section className="card settings-card">
        <div>
          <h2>🛡️ Щиты заморозки</h2>
          <p className="muted">Сохраните личную серию, если сегодня не получилось выполнить привычку.</p>
        </div>
        <div className="shield-balance">
          {user.shieldsCount}<small>щитов доступно</small>
        </div>
        <label className="field-group">
          <span className="field-label">Челлендж для защиты</span>
          <select
            className="select-input"
            value={selectedChallengeId}
            onChange={(event) => setSelectedChallengeId(event.target.value)}
            disabled={eligibleChallenges.length === 0}
          >
            {eligibleChallenges.length === 0 ? (
              <option value="">Нет незакрытых челленджей</option>
            ) : (
              eligibleChallenges.map((challenge) => (
                <option key={challenge.id} value={challenge.id}>
                  {challenge.emoji} {challenge.title}
                </option>
              ))
            )}
          </select>
        </label>
        <button
          className="button button--block"
          type="button"
          disabled={user.shieldsCount < 1 || eligibleChallenges.length === 0}
          onClick={() => void applyShield()}
        >
          Применить щит на сегодня
        </button>
      </section>

      <section className="card settings-card">
        <div>
          <h2>⏰ Ежедневное напоминание</h2>
          <p className="muted">Время указано для вашего часового пояса.</p>
        </div>
        <label className="field-group">
          <span className="field-label">Напоминать в</span>
          <select
            className="select-input"
            value={reminderHour}
            disabled={savingSettings}
            onChange={(event) => void saveReminder(Number(event.target.value))}
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <option key={hour} value={hour}>{String(hour).padStart(2, "0")}:00</option>
            ))}
          </select>
        </label>
        {savingSettings && <span className="muted">Сохраняем…</span>}
      </section>

      <section className="card shop-card">
        <div>
          <h2>Поддержать проект и бонусы</h2>
          <p className="muted">Покупки добровольные и оплачиваются Telegram Stars.</p>
        </div>
        <div className="support-section">
          <div>
            <strong>Поддержать</strong>
            <small>На сервер и развитие SquadHabit · даёт вечный бейдж спонсора</small>
          </div>
          <div className="support-buttons">
            {products.DONATE.map((amount) => (
              <button
                className="button button--quiet"
                key={amount}
                type="button"
                disabled={purchasing !== null}
                onClick={() => void buyProduct("DONATE", amount)}
              >
                {purchasing === "DONATE" ? "…" : `${amount} ⭐`}
              </button>
            ))}
          </div>
        </div>
        <div className="support-section">
          <div>
            <strong>Заморозка стрика · {products.STREAK_FREEZE} ⭐</strong>
            <small>Сохранит серию, если пропустите день. Куплено {user.freezePurchasesThisMonth} из {user.freezeMonthlyLimit} в этом месяце.</small>
          </div>
          <button
            className="button button--quiet"
            type="button"
            disabled={purchasing !== null || user.freezePurchasesThisMonth >= user.freezeMonthlyLimit}
            onClick={() => void buyProduct("STREAK_FREEZE")}
          >
            {user.freezePurchasesThisMonth >= user.freezeMonthlyLimit
              ? "Лимит на этот месяц исчерпан"
              : purchasing === "STREAK_FREEZE"
                ? "…"
                : "Купить"}
          </button>
        </div>
        <div className="support-section">
          <div>
            <strong>VIP на 30 дней · {products.VIP_30D} ⭐</strong>
            <small>Бейдж VIP в комнатах, акцентная рамка аватара и +1 заморозка стрика в подарок.</small>
          </div>
          <button
            className="button button--quiet"
            type="button"
            disabled={purchasing !== null}
            onClick={() => void buyProduct("VIP_30D")}
          >
            {purchasing === "VIP_30D" ? "…" : user.isVip ? "Продлить" : "Подключить"}
          </button>
        </div>
      </section>
    </section>
  );
}
