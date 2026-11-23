import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/api";

interface VideoNoteRecorderProps {
  challengeId: string;
  caption?: string;
  onClose: () => void;
  onUploaded: () => void;
  onToast: (message: string, type?: "success" | "error" | "info") => void;
}

const MAX_RECORDING_SECONDS = 30;
const MAX_UPLOAD_SIZE = 15 * 1024 * 1024;
const TIMER_CIRCUMFERENCE = 276.46;

function getCameraError(error: unknown): string {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "Разрешите доступ к камере и микрофону в настройках браузера и попробуйте снова.";
  }
  if (error instanceof DOMException && error.name === "NotFoundError") {
    return "Камера или микрофон не найдены на этом устройстве.";
  }
  return "Не удалось открыть камеру. Проверьте разрешения и подключение по HTTPS.";
}

export default function VideoNoteRecorder({
  challengeId,
  caption,
  onClose,
  onUploaded,
  onToast,
}: VideoNoteRecorderProps) {
  const [facingMode, setFacingMode] = useState<"user" | "environment">("user");
  const [streamReady, setStreamReady] = useState(false);
  const [canSwitchCamera, setCanSwitchCamera] = useState(false);
  const [recording, setRecording] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const secondsRef = useRef(0);
  const mountedRef = useRef(false);
  const recordedUrlRef = useRef<string | null>(null);

  const releaseStream = useCallback(() => {
    const stream = streamRef.current;
    streamRef.current = null;
    stream?.getTracks().forEach((track) => track.stop());
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const acquireStream = useCallback(async (mode: "user" | "environment") => {
    setError(null);
    setStreamReady(false);
    releaseStream();
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Запись недоступна: откройте приложение по HTTPS и разрешите доступ к камере.");
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: mode,
          width: { ideal: 480 },
          height: { ideal: 480 },
        },
        audio: true,
      });
      if (!mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      streamRef.current = stream;
      setStreamReady(true);
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        void videoRef.current.play().catch(() => undefined);
      }
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        if (mountedRef.current) {
          setCanSwitchCamera(devices.filter((device) => device.kind === "videoinput").length > 1);
        }
      } catch (enumerationError) {
        console.warn("[video-note] Unable to enumerate cameras", enumerationError);
        if (mountedRef.current) {
          setCanSwitchCamera(false);
        }
      }
    } catch (requestError) {
      if (mountedRef.current) {
        setError(getCameraError(requestError));
      }
    }
  }, [releaseStream]);

  useEffect(() => {
    mountedRef.current = true;
    void acquireStream("user");
    return () => {
      mountedRef.current = false;
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
      }
      if (recorderRef.current?.state === "recording") {
        recorderRef.current.stop();
      }
      releaseStream();
      if (recordedUrlRef.current) {
        URL.revokeObjectURL(recordedUrlRef.current);
      }
    };
  }, [acquireStream, releaseStream]);

  function stopRecording() {
    const recorder = recorderRef.current;
    if (recorder?.state === "recording") {
      recorder.stop();
    }
  }

  function startRecording() {
    const stream = streamRef.current;
    if (!stream) {
      setError("Камера ещё не готова. Попробуйте снова.");
      return;
    }
    if (typeof MediaRecorder === "undefined") {
      setError("Запись видео не поддерживается этим браузером.");
      return;
    }

    const mimeType =
      typeof MediaRecorder.isTypeSupported === "function" &&
      MediaRecorder.isTypeSupported("video/mp4")
        ? "video/mp4"
        : typeof MediaRecorder.isTypeSupported === "function" &&
            MediaRecorder.isTypeSupported("video/webm")
          ? "video/webm"
          : "";
    if (!mimeType) {
      setError("Браузер не поддерживает запись видео MP4 или WebM.");
      return;
    }

    try {
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          chunksRef.current.push(event.data);
        }
      };
      recorder.onstop = () => {
        if (timerRef.current !== null) {
          window.clearInterval(timerRef.current);
          timerRef.current = null;
        }
        recorderRef.current = null;
        releaseStream();
        const blob = new Blob(chunksRef.current, {
          type: recorder.mimeType || mimeType,
        });
        if (!mountedRef.current) {
          return;
        }
        if (blob.size === 0) {
          setRecording(false);
          setError("Видео не удалось записать. Попробуйте ещё раз.");
          return;
        }
        const url = URL.createObjectURL(blob);
        recordedUrlRef.current = url;
        setRecordedBlob(blob);
        setRecordedUrl(url);
        setRecording(false);
      };
      recorder.onerror = () => {
        if (mountedRef.current) {
          setRecording(false);
          setError("Во время записи произошла ошибка. Попробуйте ещё раз.");
        }
        releaseStream();
      };
      recorderRef.current = recorder;
      secondsRef.current = 0;
      setSeconds(0);
      recorder.start(250);
      setRecording(true);
      timerRef.current = window.setInterval(() => {
        const nextSecond = secondsRef.current + 1;
        secondsRef.current = nextSecond;
        setSeconds(nextSecond);
        if (nextSecond >= MAX_RECORDING_SECONDS) {
          stopRecording();
        }
      }, 1000);
      setError(null);
    } catch (recordingError) {
      setError(
        recordingError instanceof Error
          ? `Не удалось начать запись: ${recordingError.message}`
          : "Не удалось начать запись. Попробуйте снова.",
      );
    }
  }

  function retake() {
    releaseStream();
    if (recordedUrlRef.current) {
      URL.revokeObjectURL(recordedUrlRef.current);
      recordedUrlRef.current = null;
    }
    setRecordedUrl(null);
    setRecordedBlob(null);
    setSeconds(0);
    setError(null);
    void acquireStream(facingMode);
  }

  async function submitRecording() {
    if (!recordedBlob || submitting) {
      return;
    }
    if (recordedBlob.size > MAX_UPLOAD_SIZE) {
      onToast("Видео слишком большое, максимум 15 МБ", "error");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await api.submitVideoNoteCheckin(challengeId, recordedBlob, caption);
      onUploaded();
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : "Не удалось отправить кружок.");
    } finally {
      setSubmitting(false);
    }
  }

  const timerOffset = TIMER_CIRCUMFERENCE * (1 - seconds / MAX_RECORDING_SECONDS);

  return (
    <div
      className="video-recorder-overlay"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <section
        className="video-recorder-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="video-recorder-title"
      >
        <div className="video-recorder-heading">
          <div>
            <h2 id="video-recorder-title">Запись кружка</h2>
            <p>До 30 секунд · камера и микрофон</p>
          </div>
          <button
            className="button button--quiet"
            type="button"
            aria-label="Закрыть запись"
            disabled={submitting}
            onClick={onClose}
          >
            ✕
          </button>
        </div>

        <div className="video-recorder-stage">
          {recordedUrl ? (
            <video
              className="video-recorder-preview"
              src={recordedUrl}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <video
              ref={videoRef}
              className="video-recorder-preview video-recorder-preview--live"
              autoPlay
              muted
              playsInline
            />
          )}
          {recording && (
            <div className="video-recorder-timer" aria-label={`${seconds} из 30 секунд`}>
              <svg viewBox="0 0 100 100" aria-hidden="true">
                <circle className="video-recorder-timer-track" cx="50" cy="50" r="44" />
                <circle
                  className="video-recorder-timer-progress"
                  cx="50"
                  cy="50"
                  r="44"
                  style={{ strokeDashoffset: timerOffset }}
                />
              </svg>
              <span>{seconds}</span>
            </div>
          )}
        </div>

        {error && <p className="video-recorder-error" role="alert">{error}</p>}

        {recordedBlob ? (
          <div className="video-recorder-actions">
            <button
              className="button button--secondary"
              type="button"
              disabled={submitting}
              onClick={retake}
            >
              Переснять
            </button>
            <button
              className="button"
              type="button"
              disabled={submitting}
              onClick={() => void submitRecording()}
            >
              {submitting ? "Отправляем…" : "Отправить"}
            </button>
          </div>
        ) : (
          <div className="video-recorder-actions">
            {canSwitchCamera && !recording && (
              <button
                className="button button--secondary"
                type="button"
                disabled={!streamReady}
                onClick={() => {
                  const nextMode = facingMode === "user" ? "environment" : "user";
                  setFacingMode(nextMode);
                  void acquireStream(nextMode);
                }}
              >
                ↻ Камера
              </button>
            )}
            {recording ? (
              <button className="button button--danger" type="button" onClick={stopRecording}>
                Стоп
              </button>
            ) : (
              <button
                className="button"
                type="button"
                disabled={!streamReady}
                onClick={startRecording}
              >
                Начать запись
              </button>
            )}
            {!streamReady && !error && <span className="hint">Подключаем камеру…</span>}
            {error && !recording && !recordedBlob && (
              <button
                className="button button--quiet"
                type="button"
                onClick={() => void acquireStream(facingMode)}
              >
                Повторить
              </button>
            )}
          </div>
        )}
      </section>
    </div>
  );
}
