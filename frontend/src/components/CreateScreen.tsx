import { useState, type FormEvent } from "react";
import { api } from "../lib/api";
import { haptic, shareChallengeInline } from "../lib/telegram";
import type {
  ChallengeMode,
  CreateChallengeResponse,
  ProofType,
} from "../types";

interface CreateScreenProps {
  botUsername: string | null;
  onCreated: (challenge: CreateChallengeResponse) => void;
  onOpenRoom: (challengeId: string) => void;
}

const emojis = ["💧", "📚", "🏃", "🧘", "🥗", "💪", "🎨", "🧠", "🌱", "😴", "🚶", "✍️"];
const durations: Array<{ label: string; days: number | null }> = [
  { label: "7 дн.", days: 7 },
  { label: "14 дн.", days: 14 },
  { label: "30 дн.", days: 30 },
  { label: "∞", days: null },
];

export default function CreateScreen({
  botUsername,
  onCreated,
  onOpenRoom,
}: CreateScreenProps) {
  const [emoji, setEmoji] = useState(emojis[0]);
  const [title, setTitle] = useState("");
  const [durationDays, setDurationDays] = useState<number | null>(null);
  const [proofType, setProofType] = useState<ProofType>("PHOTO");
  const [mode, setMode] = useState<ChallengeMode>("HARDCORE");
  const [created, setCreated] = useState<CreateChallengeResponse | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const challenge = await api.createChallenge({
        emoji,
        title: title.trim(),
        durationDays,
        proofType,
        mode,
      });
      setCreated(challenge);
      onCreated(challenge);
      haptic({ type: "notification", style: "success" });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось создать челлендж");
      haptic({ type: "notification", style: "error" });
    } finally {
      setSaving(false);
    }
  }

  if (created) {
    return (
      <section className="success-card">
        <div className="success-mark" aria-hidden="true">🎉</div>
        <h1>Челлендж создан</h1>
        <p className="muted">
          {created.emoji} {created.title}. Позовите друзей, чтобы начать вместе.
        </p>
        <button
          className="button button--block"
          type="button"
          onClick={() => void shareChallengeInline(created.title, created.inviteCode, botUsername)}
        >
          📣 Отправить вызов в чат
        </button>
        <button
          className="button button--secondary button--block"
          type="button"
          onClick={() => onOpenRoom(created.id)}
        >
          Перейти в комнату
        </button>
      </section>
    );
  }

  return (
    <section>
      <div className="screen-heading">
        <div>
          <h1>Новый челлендж</h1>
          <p>Выберите привычку и пригласите команду.</p>
        </div>
      </div>

      <form className="form-stack" onSubmit={(event) => void handleSubmit(event)}>
        <div className="field-group">
          <span className="field-label">Выберите эмодзи</span>
          <div className="emoji-grid">
            {emojis.map((item) => (
              <button
                key={item}
                className="emoji-choice"
                type="button"
                aria-label={`Выбрать ${item}`}
                aria-pressed={emoji === item}
                onClick={() => {
                  setEmoji(item);
                  haptic({ type: "selection" });
                }}
              >
                {item}
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <label htmlFor="challenge-title">Название привычки</label>
          <input
            id="challenge-title"
            className="text-input"
            type="text"
            maxLength={100}
            placeholder="Например, читать 20 минут"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            required
          />
        </div>

        <div className="field-group">
          <span className="field-label">Длительность</span>
          <div className="chip-row">
            {durations.map((duration) => (
              <button
                key={duration.label}
                className="chip"
                type="button"
                aria-pressed={durationDays === duration.days}
                onClick={() => {
                  setDurationDays(duration.days);
                  haptic({ type: "selection" });
                }}
              >
                {duration.label}
              </button>
            ))}
          </div>
        </div>

        <div className="field-group">
          <span className="field-label">Тип отчёта</span>
          <div className="form-stack">
            <button
              className="choice-card"
              type="button"
              aria-pressed={proofType === "PHOTO"}
              onClick={() => setProofType("PHOTO")}
            >
              <span aria-hidden="true">📸</span>
              <span><strong>Фото / кружок</strong><small>Покажите, как прошла привычка</small></span>
            </button>
            <button
              className="choice-card"
              type="button"
              aria-pressed={proofType === "BUTTON"}
              onClick={() => setProofType("BUTTON")}
            >
              <span aria-hidden="true">✅</span>
              <span><strong>Кнопка</strong><small>Быстрая отметка без медиа</small></span>
            </button>
          </div>
        </div>

        <div className="field-group">
          <span className="field-label">Режим команды</span>
          <div className="form-stack">
            <button
              className="choice-card"
              type="button"
              aria-pressed={mode === "HARDCORE"}
              onClick={() => setMode("HARDCORE")}
            >
              <span aria-hidden="true">🔥</span>
              <span><strong>Hardcore</strong><small>Командная серия растёт, только если отметились все</small></span>
            </button>
            <button
              className="choice-card"
              type="button"
              aria-pressed={mode === "SOFT"}
              onClick={() => setMode("SOFT")}
            >
              <span aria-hidden="true">🌿</span>
              <span><strong>Soft</strong><small>Достаточно одной отметки в команде</small></span>
            </button>
          </div>
        </div>

        {error && <p className="form-error" role="alert">{error}</p>}
        <button className="button button--block" type="submit" disabled={saving || !title.trim()}>
          {saving ? "Создаём…" : "Создать челлендж"}
        </button>
      </form>
    </section>
  );
}
