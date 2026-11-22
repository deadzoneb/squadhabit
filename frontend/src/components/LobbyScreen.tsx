import { useEffect, useState } from "react";
import type { LobbyChallenge, LobbyResponse, MemberStatus } from "../types";
import { haptic } from "../lib/telegram";

interface LobbyScreenProps {
  data: LobbyResponse | null;
  loading: boolean;
  error: string | null;
  onOpenRoom: (challengeId: string) => void;
  onCreate: () => void;
  onRetry: () => void;
}

const statusClass: Record<MemberStatus, string> = {
  DONE: "avatar--done",
  PENDING: "avatar--pending",
  VETOED: "avatar--vetoed",
  SHIELDED: "avatar--shielded",
};

function getTimeUntilMidnight(now: number): string {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const seconds = Math.max(0, Math.floor((end.getTime() - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return [hours, minutes, remainder].map((value) => String(value).padStart(2, "0")).join(":");
}

function MemberAvatar({ member }: { member: LobbyChallenge["members"][number] }) {
  const className = `avatar ${statusClass[member.status]}`;
  if (member.photoUrl) {
    return (
      <img
        className={className}
        src={member.photoUrl}
        alt={member.firstName}
        title={`${member.firstName}: ${member.status}`}
      />
    );
  }
  return (
    <span className={className} title={`${member.firstName}: ${member.status}`}>
      {member.firstName.slice(0, 1).toUpperCase()}
    </span>
  );
}

function ChallengeCard({
  challenge,
  onOpen,
}: {
  challenge: LobbyChallenge;
  onOpen: () => void;
}) {
  const mode = challenge.mode === "HARDCORE" ? "Hardcore" : "Soft";
  const proof = challenge.proofType === "PHOTO" ? "📸 Фото / кружок" : "✅ Кнопка";
  const duration =
    challenge.durationDays === null ? "Без срока" : `${challenge.durationDays} дн.`;

  return (
    <button
      className="challenge-card"
      type="button"
      onClick={() => {
        haptic({ type: "impact", style: "light" });
        onOpen();
      }}
    >
      <div className="challenge-title-row">
        <span className="challenge-emoji" aria-hidden="true">{challenge.emoji}</span>
        <div className="challenge-title">
          <h2>{challenge.title}</h2>
          <span className={`badge ${challenge.mode === "HARDCORE" ? "badge--hardcore" : "badge--soft"}`}>
            {mode}
          </span>
        </div>
      </div>
      <div className="challenge-meta">
        <span>{proof}</span>
        <span>·</span>
        <span>{duration}</span>
        <span className="challenge-streak">🔥 {challenge.teamStreak} дней</span>
      </div>
      <div className="avatar-stack" aria-label="Участники">
        {challenge.members.slice(0, 8).map((member) => (
          <MemberAvatar key={member.userId} member={member} />
        ))}
        {challenge.members.length > 8 && (
          <span className="avatar">+{challenge.members.length - 8}</span>
        )}
      </div>
    </button>
  );
}

export default function LobbyScreen({
  data,
  loading,
  error,
  onOpenRoom,
  onCreate,
  onRetry,
}: LobbyScreenProps) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (loading && !data) {
    return <div className="loading-state">Загружаем ваши челленджи…</div>;
  }
  if (error && !data) {
    return (
      <div className="empty-card">
        <p className="error-state">{error}</p>
        <button className="button" type="button" onClick={onRetry}>Повторить</button>
      </div>
    );
  }

  const challenges = data?.challenges ?? [];
  const total = data?.totalChallengesCount ?? 0;
  const completed = data?.completedTodayCount ?? 0;
  const progress = total === 0 ? 0 : Math.min(100, (completed / total) * 100);

  return (
    <>
      <section className="card progress-card" aria-label="Прогресс на сегодня">
        <div className="progress-label">
          <div>
            <span className="muted">Закрыто сегодня</span>
            <strong className="row-between">
              {completed} <span className="muted">/ {total}</span>
            </strong>
          </div>
          <span className="countdown">До конца дня {getTimeUntilMidnight(now)}</span>
        </div>
        <div
          className="progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={total}
          aria-valuenow={completed}
          aria-label="Закрытые привычки"
        >
          <div className="progress-fill" style={{ width: `${progress}%` }} />
        </div>
        <div className="status-legend" aria-label="Статусы участников">
          <span className="legend-item"><i className="legend-dot legend-dot--done" />Сдано</span>
          <span className="legend-item"><i className="legend-dot legend-dot--pending" />Ожидается</span>
          <span className="legend-item"><i className="legend-dot legend-dot--vetoed" />Вето</span>
          <span className="legend-item"><i className="legend-dot legend-dot--shielded" />Щит</span>
        </div>
      </section>

      <div className="section-heading">
        <h2>Ваши челленджи</h2>
        {loading && <span className="muted">Обновляем…</span>}
      </div>

      {challenges.length === 0 ? (
        <section className="empty-card">
          <div className="empty-icon" aria-hidden="true">🌱</div>
          <h2>Начните с первой привычки</h2>
          <p>Создайте челлендж и пригласите друзей поддерживать вашу серию.</p>
          <button className="button" type="button" onClick={onCreate}>Создать челлендж</button>
        </section>
      ) : (
        <div className="challenge-list">
          {challenges.map((challenge) => (
            <ChallengeCard
              key={challenge.id}
              challenge={challenge}
              onOpen={() => onOpenRoom(challenge.id)}
            />
          ))}
        </div>
      )}
    </>
  );
}
