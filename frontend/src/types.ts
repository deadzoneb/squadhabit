export type Screen = "lobby" | "create" | "room" | "profile";
export type ProofType = "PHOTO" | "BUTTON";
export type ChallengeMode = "HARDCORE" | "SOFT";
export type CheckinStatus = "APPROVED" | "VETOED" | "SHIELDED";
export type MediaType = "NONE" | "PHOTO" | "VIDEO" | "VIDEO_NOTE";
export type MemberStatus = "DONE" | "PENDING" | "VETOED" | "SHIELDED";
export type ReactionEmoji = "🔥" | "💪" | "👏" | "👀";
export type ProductType = "DONATE" | "STREAK_FREEZE" | "VIP_30D";

export interface User {
  id: string;
  telegramId: string;
  username: string | null;
  firstName: string;
  photoUrl: string | null;
  timezone: string;
  reminderHour: number;
  shieldsCount: number;
  isPro: boolean;
  proUntil: string | null;
  isSupporter: boolean;
  totalDonatedStars: number;
  isVip: boolean;
  vipUntil: string | null;
  streakFreezes: number;
  freezePurchasesThisMonth: number;
  freezeMonthlyLimit: number;
  createdAt: string;
  updatedAt: string;
}

export interface Challenge {
  id: string;
  inviteCode: string;
  title: string;
  emoji: string;
  durationDays: number | null;
  proofType: ProofType;
  mode: ChallengeMode;
  teamStreak: number;
  bestTeamStreak: number;
  lastEvaluatedDate: string | null;
  creatorId: string;
  createdAt: string;
}

export interface ChallengeMember {
  id: string;
  challengeId: string;
  userId: string;
  personalStreak: number;
  bestStreak: number;
  joinedAt: string;
}

export interface LobbyMember {
  userId: string;
  firstName: string;
  username: string | null;
  photoUrl: string | null;
  isSupporter: boolean;
  isVip: boolean;
  personalStreak: number;
  bestStreak: number;
  status: MemberStatus;
}

export interface LobbyChallenge extends Challenge {
  members: LobbyMember[];
}

export interface BootstrapResponse {
  user: User;
  botUsername: string | null;
  products: ProductCatalog;
  prices: ProductCatalog;
  joinedChallengeId: string | null;
  joinError: string | null;
}

export interface ProductCatalog {
  DONATE: readonly [number, number, number];
  STREAK_FREEZE: number;
  VIP_30D: number;
}

export interface LobbyResponse {
  today: string;
  completedTodayCount: number;
  totalChallengesCount: number;
  challenges: LobbyChallenge[];
}

export interface RoomMember extends ChallengeMember {
  user: Pick<User, "id" | "firstName" | "username" | "photoUrl" | "isSupporter" | "isVip" | "vipUntil">;
}

export interface RoomReaction {
  emoji: ReactionEmoji;
  count: number;
  reactedByMe: boolean;
}

export interface RoomFeedItem {
  id: string;
  challengeId: string;
  userId: string;
  date: string;
  status: CheckinStatus;
  mediaType: MediaType;
  telegramFileId: string | null;
  caption: string | null;
  createdAt: string;
  updatedAt: string;
  mediaUrl: string | null;
  vetoCount: number;
  user: Pick<User, "id" | "firstName" | "username" | "photoUrl" | "isSupporter" | "isVip" | "vipUntil">;
  reactions: RoomReaction[];
}

export interface MatrixRow {
  userId: string;
  firstName: string;
  isVip: boolean;
  isSupporter: boolean;
  personalStreak: number;
  bestStreak: number;
  dates: Record<string, MemberStatus>;
}

export interface DeleteRequest {
  votesCount: number;
  totalMembers: number;
  hasVoted: boolean;
  initiatorName: string;
}

export interface RoomResponse {
  challenge: Challenge & { members: RoomMember[] };
  today: string;
  feed: RoomFeedItem[];
  matrixDates: string[];
  matrix: MatrixRow[];
  deleteRequest: DeleteRequest | null;
}

export type DeleteVoteResponse =
  | { deleted: true }
  | { deleted: false; votesCount: number; totalMembers: number; voterIds: string[] };

export interface CreateChallengeInput {
  emoji: string;
  title: string;
  durationDays: number | null;
  proofType: ProofType;
  mode: ChallengeMode;
}

export interface CreateChallengeResponse extends Challenge {
  members: ChallengeMember[];
}

export interface CheckinResponse {
  checkin: {
    id: string;
    challengeId: string;
    userId: string;
    date: string;
    status: CheckinStatus;
    mediaType: MediaType;
    telegramFileId: string | null;
    caption: string | null;
    createdAt: string;
    updatedAt: string;
  };
}

export interface ShieldResponse extends CheckinResponse {
  shieldsCount: number;
}

export interface StreakFreezeResponse extends CheckinResponse {
  streakFreezes: number;
}

export interface VetoResponse {
  status: CheckinStatus;
  vetoCount: number;
  requiredVotes: number;
  votedByMe: boolean;
}

export interface ReactionResponse {
  checkinId: string;
  emoji: ReactionEmoji;
  added: boolean;
  count: number;
}

export interface MeResponse {
  user: User;
  prices: ProductCatalog;
  challenges: Array<{
    id: string;
    challengeId: string;
    userId: string;
    personalStreak: number;
    bestStreak: number;
    joinedAt: string;
    challenge: Challenge;
  }>;
}

export interface SettingsInput {
  reminderHour?: number;
  timezone?: string;
}

export interface SettingsResponse {
  user: User;
}

export type InvoiceResponse =
  | { invoiceUrl: string }
  | { simulated: true; duplicate: boolean; quotaExceeded: boolean };

export interface ApiErrorResponse {
  error: string;
  details?: unknown;
}

export interface ToastMessage {
  message: string;
  type: "success" | "error" | "info";
}
