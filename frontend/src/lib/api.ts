import { getInitData } from "./telegram";
import type {
  BootstrapResponse,
  CheckinResponse,
  CreateChallengeInput,
  CreateChallengeResponse,
  DeleteVoteResponse,
  InvoiceResponse,
  LobbyResponse,
  MeResponse,
  ProductType,
  ReactionEmoji,
  ReactionResponse,
  RoomResponse,
  SettingsInput,
  SettingsResponse,
  ShieldResponse,
  StreakFreezeResponse,
  VetoResponse,
} from "../types";

const apiBaseUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");

interface ApiRequestOptions {
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: object | FormData;
}

function isFormData(body: object | FormData): body is FormData {
  return typeof FormData !== "undefined" && body instanceof FormData;
}

async function readResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length === 0) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function describeApiError(payload: unknown, status: number): string {
  if (typeof payload === "object" && payload !== null && "error" in payload) {
    const errorMessage = payload.error;
    if (typeof errorMessage === "string") {
      const details =
        "details" in payload && Array.isArray(payload.details)
          ? payload.details
              .map((detail: unknown) =>
                typeof detail === "object" &&
                detail !== null &&
                "message" in detail &&
                typeof detail.message === "string"
                  ? detail.message
                  : "",
              )
              .filter(Boolean)
              .join("; ")
          : "";
      return details ? `${errorMessage}: ${details}` : errorMessage;
    }
  }
  if (typeof payload === "string" && payload.length > 0) {
    return payload;
  }
  return `Request failed with status ${status}`;
}

async function request<T>(
  path: string,
  options: ApiRequestOptions = {},
): Promise<T> {
  const headers = new Headers({ Accept: "application/json" });
  const initData = getInitData();
  if (initData) {
    headers.set("x-telegram-init-data", initData);
  }

  let body: BodyInit | undefined;
  if (options.body !== undefined) {
    if (isFormData(options.body)) {
      body = options.body;
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(options.body);
    }
  }

  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    ...(body !== undefined ? { body } : {}),
  });
  const payload = await readResponse(response);
  if (!response.ok) {
    throw new Error(describeApiError(payload, response.status));
  }
  return payload as T;
}

export function resolveApiUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path;
  }
  return `${apiBaseUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function encodeId(id: string): string {
  return encodeURIComponent(id);
}

async function bootstrap(timezone: string, startParam = ""): Promise<BootstrapResponse> {
  return request("/api/bootstrap", {
    method: "POST",
    body: { timezone, ...(startParam ? { startParam } : {}) },
  });
}

async function getLobby(): Promise<LobbyResponse> {
  return request("/api/lobby");
}

async function createChallenge(
  input: CreateChallengeInput,
): Promise<CreateChallengeResponse> {
  return request("/api/challenges", { method: "POST", body: input });
}

async function getRoom(challengeId: string): Promise<RoomResponse> {
  return request(`/api/challenges/${encodeId(challengeId)}`);
}

async function submitButtonCheckin(
  challengeId: string,
  caption?: string,
): Promise<CheckinResponse> {
  return request(`/api/challenges/${encodeId(challengeId)}/checkin`, {
    method: "POST",
    body: caption ? { caption } : {},
  });
}

async function submitPhotoCheckin(
  challengeId: string,
  photo: File,
  caption?: string,
): Promise<CheckinResponse> {
  const form = new FormData();
  form.append("file", photo, photo.name);
  if (caption) {
    form.append("caption", caption);
  }
  return request(`/api/challenges/${encodeId(challengeId)}/checkin`, {
    method: "POST",
    body: form,
  });
}

async function submitVideoNoteCheckin(
  challengeId: string,
  videoNote: Blob,
  caption?: string,
): Promise<CheckinResponse> {
  const form = new FormData();
  form.append("file", videoNote, "video-note.mp4");
  form.append("proofKind", "video_note");
  if (caption) {
    form.append("caption", caption);
  }
  return request(`/api/challenges/${encodeId(challengeId)}/checkin`, {
    method: "POST",
    body: form,
  });
}

async function voteToDeleteChallenge(challengeId: string): Promise<DeleteVoteResponse> {
  return request(`/api/challenges/${encodeId(challengeId)}/delete-vote`, {
    method: "POST",
  });
}

async function cancelDeleteRequest(challengeId: string): Promise<{ cancelled: true }> {
  return request(`/api/challenges/${encodeId(challengeId)}/delete-vote`, {
    method: "DELETE",
  });
}

async function applyShield(challengeId: string): Promise<ShieldResponse> {
  return request(`/api/challenges/${encodeId(challengeId)}/shield`, { method: "POST" });
}

async function applyStreakFreeze(challengeId: string): Promise<StreakFreezeResponse> {
  return request(`/api/challenges/${encodeId(challengeId)}/freeze`, { method: "POST" });
}

async function toggleVeto(checkinId: string): Promise<VetoResponse> {
  return request(`/api/checkins/${encodeId(checkinId)}/veto`, { method: "POST" });
}

async function toggleReaction(
  checkinId: string,
  emoji: ReactionEmoji,
): Promise<ReactionResponse> {
  return request(`/api/checkins/${encodeId(checkinId)}/reactions`, {
    method: "POST",
    body: { emoji },
  });
}

async function getMe(): Promise<MeResponse> {
  return request("/api/me");
}

async function updateSettings(input: SettingsInput): Promise<SettingsResponse> {
  return request("/api/me/settings", { method: "PATCH", body: input });
}

async function createInvoice(productType: ProductType, amount?: number): Promise<InvoiceResponse> {
  return request("/api/payments/invoice", {
    method: "POST",
    body: { productType, ...(amount !== undefined ? { amount } : {}) },
  });
}

async function getApiHealth(): Promise<{ status: string }> {
  return request("/api/health");
}

export const api = {
  bootstrap,
  getLobby,
  createChallenge,
  getRoom,
  submitButtonCheckin,
  submitPhotoCheckin,
  submitVideoNoteCheckin,
  voteToDeleteChallenge,
  cancelDeleteRequest,
  applyShield,
  applyStreakFreeze,
  toggleVeto,
  toggleReaction,
  getMe,
  updateSettings,
  createInvoice,
  getApiHealth,
};
