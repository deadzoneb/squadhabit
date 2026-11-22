import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { getTelegramWebApp, haptic } from "../lib/telegram";
import type {
  LobbyResponse,
  ProductCatalog,
  ProductId,
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

const productDetails: Record<ProductId, { title: string; description: string }> = {
  SHIELD_1: { title: "Один щит", description: "Сохраните серию на один день" },
  SHIELD_5: { title: "Набор из 5 щитов", description: "Пять дней под защитой" },
  PRO_30: { title: "SquadHabit PRO", description: "30 дней PRO и 3 щита" },
};

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
  const [purchasing, setPurchasing] = useState<ProductId | null>(null);

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

  async function buyProduct(productId: ProductId) {
    if (purchasing) {
      return;
    }
    setPurchasing(productId);
    try {
      const invoice = await api.createInvoice(productId);
      if (!("invoiceUrl" in invoice)) {
        onToast("Покупка в тестовом режиме успешно активирована", "success");
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
          void onDataChanged();
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
          <img className="avatar profile-avatar" src={user.photoUrl} alt={user.firstName} />
        ) : (
          <span className="avatar profile-avatar">{initials}</span>
        )}
        <div className="profile-details">
          <h2>{user.firstName}</h2>
          {user.username && <span className="muted">@{user.username}</span>}
          {proActive && <span className="pro-badge">✦ PRO{user.proUntil ? ` до ${new Date(user.proUntil).toLocaleDateString()}` : ""}</span>}
          <p className="muted">Часовой пояс: {user.timezone}</p>
        </div>
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
          <h2>⭐ Магазин Stars</h2>
          <p className="muted">Покупки оплачиваются Telegram Stars (XTR).</p>
        </div>
        {(Object.keys(productDetails) as ProductId[]).map((productId) => {
          const product = products[productId];
          const details = productDetails[productId];
          return (
            <div className="shop-product" key={productId}>
              <div>
                <strong>{details.title}</strong>
                <small>{details.description}</small>
              </div>
              <button
                className="button button--quiet"
                type="button"
                disabled={purchasing !== null || (productId === "PRO_30" && proActive)}
                onClick={() => void buyProduct(productId)}
              >
                {purchasing === productId ? "…" : `${product.amountXtr} ⭐`}
              </button>
            </div>
          );
        })}
      </section>
    </section>
  );
}
