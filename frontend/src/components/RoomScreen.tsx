import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from "react";
import { api, resolveApiUrl } from "../lib/api";
import VideoNoteRecorder from "./VideoNoteRecorder";
import { compressImage } from "../lib/imageCompress";
import { haptic, shareChallengeInline } from "../lib/telegram";
import type {
  CheckinStatus,
  MemberStatus,
  ReactionEmoji,
  RoomFeedItem,
  RoomResponse,
  User,
} from "../types";

interface RoomScreenProps {
  challengeId: string;
  user: User;
  botUsername: string | null;
  onBack: () => void;
  onDataChanged: () => Promise<void>;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
}

type RoomTab = "feed" | "matrix";

const reactionEmojis: ReactionEmoji[] = ["🔥", "💪", "👏", "👀"];
const MAX_VIDEO_SIZE = 15 * 1024 * 1024;

function getStatusSymbol(status: MemberStatus | undefined): string {
  switch (status) {
    case "DONE":
      return "✅";
    case "SHIELDED":
      return "🛡️";
    case "VETOED":
      return "❌";
    default:
      return "·";
  }
}

function getStatusText(status: CheckinStatus): string {
  switch (status) {
    case "APPROVED":
      return "Сдано";
    case "VETOED":
      return "Нужна пересдача";
    case "SHIELDED":
      return "Сохранено щитом";
  }
}

function FeedCard({
  item,
  requiredVotes,
  currentUserId,
  onReaction,
  onVeto,
}: {
  item: RoomFeedItem;
  requiredVotes: number;
  currentUserId: string;
  onReaction: (checkinId: string, emoji: ReactionEmoji) => void;
  onVeto: (checkinId: string) => void;
}) {
  const isMine = item.userId === currentUserId;
  return (
    <article className="feed-card">
      <div className="feed-card-heading">
        {item.user.photoUrl ? (
          <img className={`avatar${item.user.isVip ? " avatar--vip" : ""}`} src={item.user.photoUrl} alt="" />
        ) : (
          <span className={`avatar${item.user.isVip ? " avatar--vip" : ""}`}>{item.user.firstName.slice(0, 1).toUpperCase()}</span>
        )}
        <div className="feed-author">
          <strong>{item.user.firstName}{isMine ? " · вы" : ""}</strong>
          <span className="member-badges">
            {item.user.isVip && <span className="member-badge member-badge--vip">VIP</span>}
            {item.user.isSupporter && <span className="member-badge member-badge--supporter">⭐</span>}
          </span>
          <small>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</small>
        </div>
        <span className="status-pill">{getStatusText(item.status)}</span>
      </div>

      {item.mediaUrl && item.mediaType === "PHOTO" && (
        <img
          className="proof-photo"
          src={resolveApiUrl(item.mediaUrl)}
          alt={`Фото-пруф: ${item.user.firstName}`}
          loading="lazy"
        />
      )}
      {item.mediaUrl && item.mediaType === "VIDEO_NOTE" && (
        <video
          className="proof-video-note"
          src={resolveApiUrl(item.mediaUrl)}
          controls
          playsInline
          preload="metadata"
        />
      )}
      {item.mediaUrl && item.mediaType === "VIDEO" && (
        <video
          className="proof-photo"
          src={resolveApiUrl(item.mediaUrl)}
          controls
          playsInline
          preload="metadata"
        />
      )}
      {item.caption && <p className="feed-caption">{item.caption}</p>}

      <div className="reaction-row" aria-label="Быстрые реакции">
        {reactionEmojis.map((emoji) => {
          const reaction = item.reactions.find((entry) => entry.emoji === emoji);
          return (
            <button
              key={emoji}
              className="reaction-button"
              type="button"
              aria-pressed={reaction?.reactedByMe ?? false}
              onClick={() => onReaction(item.id, emoji)}
            >
              {emoji}{reaction && reaction.count > 0 ? ` ${reaction.count}` : ""}
            </button>
          );
        })}
      </div>

      {!isMine && item.status !== "SHIELDED" && (
        <div className="veto-row">
          <button
            className="button button--quiet button--danger"
            type="button"
            onClick={() => onVeto(item.id)}
          >
            🤨 Не верю ({item.vetoCount}/{requiredVotes})
          </button>
        </div>
      )}
    </article>
  );
}

export default function RoomScreen({
  challengeId,
  user,
  botUsername,
  onBack,
  onDataChanged,
  onToast,
}: RoomScreenProps) {
  const [room, setRoom] = useState<RoomResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<RoomTab>("feed");
  const [caption, setCaption] = useState("");
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [videoNoteOpen, setVideoNoteOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const photoInput = useRef<HTMLInputElement>(null);
  const videoInput = useRef<HTMLInputElement>(null);

  const loadRoom = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setRoom(await api.getRoom(challengeId));
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : "Не удалось загрузить комнату");
    } finally {
      setLoading(false);
    }
  }, [challengeId]);

  useEffect(() => {
    void loadRoom();
  }, [loadRoom]);

  const checkin = room?.feed.find((item) => item.userId === user.id);
  const canSubmit = !checkin || checkin.status === "VETOED";

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!room || submitting) {
      return;
    }
    if (room.challenge.proofType === "PHOTO" && !mediaFile) {
      onToast("Сначала выберите фото или видео", "error");
      return;
    }
    setSubmitting(true);
    try {
      if (room.challenge.proofType === "PHOTO" && mediaFile) {
        if (mediaFile.type.startsWith("video/") && mediaFile.size > MAX_VIDEO_SIZE) {
          onToast("Видео слишком большое, максимум 15 МБ", "error");
          return;
        }
        if (!mediaFile.type.startsWith("image/") && !mediaFile.type.startsWith("video/")) {
          onToast("Поддерживаются только фото и видео", "error");
          return;
        }
        const fileToUpload = mediaFile.type.startsWith("image/")
          ? await compressImage(mediaFile)
          : mediaFile;
        await api.submitPhotoCheckin(room.challenge.id, fileToUpload, caption);
      } else {
        await api.submitButtonCheckin(room.challenge.id, caption);
      }
      setCaption("");
      setMediaFile(null);
      if (photoInput.current) {
        photoInput.current.value = "";
      }
      if (videoInput.current) {
        videoInput.current.value = "";
      }
      onToast("Отчёт засчитан", "success");
      haptic({ type: "notification", style: "success" });
      await Promise.all([loadRoom(), onDataChanged()]);
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось отправить отчёт", "error");
      haptic({ type: "notification", style: "error" });
    } finally {
      setSubmitting(false);
    }
  }

  async function handleShield() {
    if (!room || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.applyShield(room.challenge.id);
      onToast(`Щит применён. Осталось: ${result.shieldsCount}`, "success");
      haptic({ type: "notification", style: "success" });
      await Promise.all([loadRoom(), onDataChanged()]);
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось применить щит", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleStreakFreeze() {
    if (!room || submitting) {
      return;
    }
    setSubmitting(true);
    try {
      const result = await api.applyStreakFreeze(room.challenge.id);
      onToast(`День заморожен. Осталось заморозок: ${result.streakFreezes}`, "success");
      haptic({ type: "notification", style: "success" });
      await Promise.all([loadRoom(), onDataChanged()]);
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось заморозить день", "error");
    } finally {
      setSubmitting(false);
    }
  }

  async function handleReaction(checkinId: string, emoji: ReactionEmoji) {
    try {
      await api.toggleReaction(checkinId, emoji);
      await loadRoom();
      haptic({ type: "selection" });
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось отправить реакцию", "error");
    }
  }

  async function handleVeto(checkinId: string) {
    try {
      const result = await api.toggleVeto(checkinId);
      onToast(
        result.status === "VETOED"
          ? `Голос учтён: ${result.vetoCount}/${result.requiredVotes}`
          : "Ваш голос за вето отменён",
        "info",
      );
      await loadRoom();
      haptic({ type: "impact", style: "medium" });
    } catch (requestError) {
      onToast(requestError instanceof Error ? requestError.message : "Не удалось проголосовать", "error");
    }
  }

  function handlePhotoSelection(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!selectedFile) {
      return;
    }
    if (selectedFile && !selectedFile.type.startsWith("image/")) {
      onToast("Выберите изображение", "error");
      return;
    }
    setMediaFile(selectedFile);
  }

  function handleVideoSelection(event: ChangeEvent<HTMLInputElement>) {
    const selectedFile = event.currentTarget.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (!selectedFile) {
      return;
    }
    if (!selectedFile.type.startsWith("video/")) {
      onToast("Выберите видеофайл", "error");
      return;
    }
    if (selectedFile.size > MAX_VIDEO_SIZE) {
      onToast("Видео слишком большое, максимум 15 МБ", "error");
      return;
    }
    setMediaFile(selectedFile);
  }

  function handleDeleteVote() {
    if (!room || deleteSubmitting) {
      return;
    }
    if (!room.deleteRequest) {
      setDeleteConfirmOpen(true);
      return;
    }
    void submitDeleteVote();
  }

  async function submitDeleteVote() {
    if (!room || deleteSubmitting) {
      return;
    }
    setDeleteConfirmOpen(false);
    setDeleteSubmitting(true);
    try {
      const result = await api.voteToDeleteChallenge(room.challenge.id);
      if (result.deleted) {
        onToast("Челлендж удалён", "success");
        onBack();
        void onDataChanged().catch((refreshError: unknown) => {
          onToast(
            refreshError instanceof Error ? refreshError.message : "Не удалось обновить лобби",
            "error",
          );
        });
        return;
      }
      onToast(`За удаление согласны ${result.votesCount} из ${result.totalMembers}`, "info");
      await loadRoom();
    } catch (requestError) {
      onToast(
        requestError instanceof Error ? requestError.message : "Не удалось проголосовать за удаление",
        "error",
      );
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function handleCancelDeleteRequest() {
    if (!room || deleteSubmitting) {
      return;
    }
    setDeleteSubmitting(true);
    try {
      await api.cancelDeleteRequest(room.challenge.id);
      onToast("Запрос на удаление отменён", "success");
      await loadRoom();
    } catch (requestError) {
      onToast(
        requestError instanceof Error ? requestError.message : "Не удалось отменить удаление",
        "error",
      );
    } finally {
      setDeleteSubmitting(false);
    }
  }

  function handleVideoNoteUploaded() {
    setVideoNoteOpen(false);
    setCaption("");
    setMediaFile(null);
    onToast("Отчёт засчитан", "success");
    haptic({ type: "notification", style: "success" });
    void Promise.all([loadRoom(), onDataChanged()]).catch((refreshError: unknown) => {
      onToast(
        refreshError instanceof Error ? refreshError.message : "Не удалось обновить комнату",
        "error",
      );
    });
  }

  if (loading && !room) {
    return <div className="loading-state">Загружаем комнату…</div>;
  }
  if (error && !room) {
    return (
      <div className="empty-card">
        <p className="error-state">{error}</p>
        <button className="button" type="button" onClick={() => void loadRoom()}>Повторить</button>
      </div>
    );
  }
  if (!room) {
    return null;
  }

  const isVetoed = checkin?.status === "VETOED";
  const requiredVotes = Math.ceil(Math.max(0, room.challenge.members.length - 1) / 2);

  return (
    <section>
      <div className="room-toolbar">
        <button className="button button--quiet" type="button" onClick={onBack}>← Лобби</button>
        <div className="room-toolbar-actions">
          <button
            className="button button--quiet"
            type="button"
            onClick={() => void shareChallengeInline(
              room.challenge.title,
              room.challenge.inviteCode,
              botUsername,
            )}
          >
            Позвать друзей
          </button>
        </div>
      </div>

      {room.deleteRequest && (
        <div className="delete-request-banner" role="status">
          <div className="delete-request-copy">
            <strong>Предложено удаление</strong>
            <span>{room.deleteRequest.initiatorName}: согласны {room.deleteRequest.votesCount} из {room.deleteRequest.totalMembers}</span>
          </div>
          <div className="delete-request-actions">
            {!room.deleteRequest.hasVoted && (
              <button
                className="button button--quiet"
                type="button"
                disabled={deleteSubmitting}
                onClick={handleDeleteVote}
              >
                ✅ Согласен удалить
              </button>
            )}
            <button
              className="button button--quiet button--danger"
              type="button"
              disabled={deleteSubmitting}
              onClick={() => void handleCancelDeleteRequest()}
            >
              ❌ Оставить челлендж
            </button>
          </div>
        </div>
      )}

      <div className="room-summary">
        <h1>{room.challenge.emoji} {room.challenge.title}</h1>
        <p>
          {room.challenge.mode === "HARDCORE" ? "🔥 Hardcore" : "🌿 Soft"}
          {" · "}Командная серия: {room.challenge.teamStreak} дн.
          {" · "}{room.challenge.proofType === "PHOTO" ? "Фото / кружок" : "Отметка кнопкой"}
        </p>
      </div>
      {!room.deleteRequest && (
        <div className="room-delete-action">
          <button
            className="button button--quiet button--danger"
            type="button"
            disabled={deleteSubmitting}
            onClick={handleDeleteVote}
          >
            🗑 Удалить челлендж
          </button>
        </div>
      )}

      {canSubmit ? (
        <form className="card checkin-panel" onSubmit={(event) => void handleSubmit(event)}>
          <h2>Отчёт на сегодня</h2>
          {isVetoed && (
            <div className="status-banner status-banner--veto" role="alert">
              Ваш отчёт оспорен. Пересдайте пруф до 23:59 по вашему местному времени.
            </div>
          )}
          {room.challenge.proofType === "PHOTO" ? (
            <>
              <div className="media-action-panel" aria-label="Добавить пруф">
                <button className="button button--secondary" type="button" onClick={() => photoInput.current?.click()}>
                  📷 Фото
                </button>
                <button className="button button--secondary" type="button" onClick={() => videoInput.current?.click()}>
                  🎬 Видео
                </button>
                <button className="button button--secondary" type="button" onClick={() => setVideoNoteOpen(true)}>
                  ⭕ Кружок
                </button>
              </div>
              <input
                ref={photoInput}
                className="visually-hidden"
                type="file"
                accept="image/*"
                onChange={handlePhotoSelection}
              />
              <input
                ref={videoInput}
                className="visually-hidden"
                type="file"
                accept="video/*"
                onChange={handleVideoSelection}
              />
              {mediaFile && (
                <p className="selected-media" role="status">
                  Выбрано: {mediaFile.name}
                  <button
                    className="selected-media-remove"
                    type="button"
                    aria-label="Убрать выбранный файл"
                    onClick={() => setMediaFile(null)}
                  >
                    ✕
                  </button>
                </p>
              )}
              <small className="hint">
                Фото сжимаются перед отправкой. Максимальный размер видео — 15 МБ.
              </small>
            </>
          ) : null}
          <label className="field-label" htmlFor="checkin-caption">Подпись (необязательно)</label>
          <textarea
            id="checkin-caption"
            className="caption-input"
            maxLength={1024}
            placeholder="Добавьте пару слов…"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            rows={2}
          />
          <button className="button button--block" type="submit" disabled={submitting}>
            {submitting
              ? "Отправляем…"
              : room.challenge.proofType === "PHOTO"
                ? "📤 Отправить пруф"
                : "✅ Закрыть день"}
          </button>
          {user.shieldsCount > 0 && (
            <button
              className="button button--secondary button--block"
              type="button"
              disabled={submitting}
              onClick={() => void handleShield()}
            >
              🛡️ Применить щит на сегодня
            </button>
          )}
          {user.streakFreezes > 0 && !checkin && (
            <button
              className="button button--secondary button--block"
              type="button"
              disabled={submitting}
              onClick={() => void handleStreakFreeze()}
            >
              Заморозить день
            </button>
          )}
        </form>
      ) : (
        <div className={`status-banner ${checkin?.status === "SHIELDED" ? "status-banner--shield" : ""}`}>
          {checkin?.status === "SHIELDED"
            ? "🛡️ Сегодняшняя серия сохранена щитом."
            : "✅ День закрыт. Отличная работа!"}
        </div>
      )}

      {videoNoteOpen && (
        <VideoNoteRecorder
          challengeId={room.challenge.id}
          caption={caption}
          onClose={() => setVideoNoteOpen(false)}
          onUploaded={handleVideoNoteUploaded}
          onToast={onToast}
        />
      )}
      {deleteConfirmOpen && (
        <div
          className="video-recorder-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleteSubmitting) {
              setDeleteConfirmOpen(false);
            }
          }}
        >
          <section
            className="delete-confirm-modal"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="delete-confirm-title"
          >
            <h2 id="delete-confirm-title">Удалить челлендж?</h2>
            <p>Челлендж и его история будут удалены, только если согласятся все участники.</p>
            <div className="video-recorder-actions">
              <button
                className="button button--secondary"
                type="button"
                disabled={deleteSubmitting}
                onClick={() => setDeleteConfirmOpen(false)}
              >
                Отмена
              </button>
              <button
                className="button button--danger"
                type="button"
                disabled={deleteSubmitting}
                onClick={() => void submitDeleteVote()}
              >
                {deleteSubmitting ? "Отправляем…" : "Предложить удаление"}
              </button>
            </div>
          </section>
        </div>
      )}

      <div className="room-tabs" role="tablist" aria-label="Содержимое комнаты">
        <button
          className="room-tab"
          type="button"
          role="tab"
          aria-selected={tab === "feed"}
          aria-pressed={tab === "feed"}
          onClick={() => setTab("feed")}
        >
          Лента дня
        </button>
        <button
          className="room-tab"
          type="button"
          role="tab"
          aria-selected={tab === "matrix"}
          aria-pressed={tab === "matrix"}
          onClick={() => setTab("matrix")}
        >
          Матрица
        </button>
        <button className="button button--quiet" type="button" onClick={() => void loadRoom()}>
          ↻
        </button>
      </div>

      {tab === "feed" ? (
        room.feed.length === 0 ? (
          <div className="empty-card">
            <p>Сегодня отчётов пока нет. Будьте первым!</p>
          </div>
        ) : (
          <div className="feed-list">
            {room.feed.map((item) => (
              <FeedCard
                key={item.id}
                item={item}
                requiredVotes={requiredVotes}
                currentUserId={user.id}
                onReaction={(checkinId, emoji) => void handleReaction(checkinId, emoji)}
                onVeto={(checkinId) => void handleVeto(checkinId)}
              />
            ))}
          </div>
        )
      ) : (
        <div className="matrix-wrap">
          <table className="matrix-table">
            <thead>
              <tr>
                <th scope="col">Участник</th>
                {room.matrixDates.map((date) => (
                  <th key={date} scope="col" title={date}>{date.slice(5)}</th>
                ))}
                <th scope="col">Стрик</th>
              </tr>
            </thead>
            <tbody>
              {room.matrix.map((row) => (
                <tr key={row.userId}>
                  <td className="matrix-name">
                    {row.firstName}
                    {row.isVip && <span className="member-badge member-badge--vip">VIP</span>}
                    {row.isSupporter && <span className="member-badge member-badge--supporter">⭐</span>}
                  </td>
                  {room.matrixDates.map((date) => (
                    <td key={date} title={`${date}: ${row.dates[date]}`}>
                      {getStatusSymbol(row.dates[date])}
                    </td>
                  ))}
                  <td className="matrix-streak">🔥 {row.personalStreak}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
