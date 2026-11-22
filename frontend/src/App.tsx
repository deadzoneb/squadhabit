import { useCallback, useEffect, useRef, useState } from "react";
import BottomNav from "./components/BottomNav";
import CreateScreen from "./components/CreateScreen";
import LobbyScreen from "./components/LobbyScreen";
import ProfileScreen from "./components/ProfileScreen";
import RoomScreen from "./components/RoomScreen";
import { api } from "./lib/api";
import {
  getStartParam,
  initTelegramWebApp,
  TOAST_EVENT,
} from "./lib/telegram";
import type {
  BootstrapResponse,
  CreateChallengeResponse,
  LobbyResponse,
  MeResponse,
  ProductCatalog,
  Screen,
  ToastMessage,
  User,
} from "./types";

interface ToastState extends ToastMessage {
  id: number;
}

export default function App() {
  const [screen, setScreen] = useState<Screen>("lobby");
  const [user, setUser] = useState<User | null>(null);
  const [lobby, setLobby] = useState<LobbyResponse | null>(null);
  const [products, setProducts] = useState<ProductCatalog | null>(null);
  const [botUsername, setBotUsername] = useState<string | null>(null);
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [toast, setToast] = useState<ToastState | null>(null);
  const toastCounter = useRef(0);

  const showToast = useCallback(
    (message: string, type: ToastMessage["type"] = "info") => {
      toastCounter.current += 1;
      setToast({ id: toastCounter.current, message, type });
    },
    [],
  );

  useEffect(() => {
    const handleToast = (event: Event) => {
      if (event instanceof CustomEvent) {
        const detail = event.detail as ToastMessage;
        if (typeof detail.message === "string") {
          showToast(detail.message, detail.type);
        }
      }
    };
    window.addEventListener(TOAST_EVENT, handleToast);
    return () => window.removeEventListener(TOAST_EVENT, handleToast);
  }, [showToast]);

  useEffect(() => {
    if (!toast) {
      return;
    }
    const timer = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    let active = true;
    initTelegramWebApp();
    setBooting(true);
    setBootError(null);

    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const startParam = getStartParam();
    async function initialize(): Promise<void> {
      try {
        const bootstrap: BootstrapResponse = await api.bootstrap(timezone, startParam);
        if (!active) {
          return;
        }
        setUser(bootstrap.user);
        setBotUsername(bootstrap.botUsername);
        setProducts(bootstrap.products);
        if (bootstrap.joinError) {
          showToast(bootstrap.joinError, "error");
        }

        const [lobbyData, meData]: [LobbyResponse, MeResponse] = await Promise.all([
          api.getLobby(),
          api.getMe(),
        ]);
        if (!active) {
          return;
        }
        setLobby(lobbyData);
        setUser(meData.user);
        if (bootstrap.joinedChallengeId) {
          setChallengeId(bootstrap.joinedChallengeId);
          setScreen("room");
          showToast("Вы присоединились к челленджу", "success");
        } else {
          setScreen("lobby");
        }
      } catch (requestError) {
        if (active) {
          setBootError(
            requestError instanceof Error
              ? requestError.message
              : "Не удалось подключиться к SquadHabit",
          );
        }
      } finally {
        if (active) {
          setBooting(false);
        }
      }
    }
    void initialize();

    return () => {
      active = false;
    };
  }, [bootstrapAttempt, showToast]);

  const refreshData = useCallback(async () => {
    const [lobbyData, meData] = await Promise.all([api.getLobby(), api.getMe()]);
    setLobby(lobbyData);
    setUser(meData.user);
  }, []);

  const refreshLobby = useCallback(async () => {
    try {
      setLobby(await api.getLobby());
    } catch (requestError) {
      showToast(requestError instanceof Error ? requestError.message : "Не удалось обновить лобби", "error");
    }
  }, [showToast]);

  function openRoom(id: string) {
    setChallengeId(id);
    setScreen("room");
  }

  function handleChallengeCreated(challenge: CreateChallengeResponse) {
    void refreshData().catch((requestError: unknown) => {
      showToast(requestError instanceof Error ? requestError.message : "Не удалось обновить данные", "error");
    });
    setChallengeId(challenge.id);
  }

  const navScreen = screen === "room" ? "lobby" : screen;
  const appContent = booting ? (
    <div className="loading-state">Подключаем SquadHabit…</div>
  ) : bootError || !user || !products ? (
    <section className="empty-card">
      <div className="empty-icon" aria-hidden="true">⚠️</div>
      <h2>Не удалось загрузить приложение</h2>
      <p className="error-state">{bootError ?? "Профиль пользователя недоступен"}</p>
      <button
        className="button"
        type="button"
        onClick={() => setBootstrapAttempt((attempt) => attempt + 1)}
      >
        Повторить
      </button>
    </section>
  ) : (
    <>
      {screen === "lobby" && (
        <LobbyScreen
          data={lobby}
          loading={false}
          error={null}
          onOpenRoom={openRoom}
          onCreate={() => setScreen("create")}
          onRetry={() => void refreshLobby()}
        />
      )}
      {screen === "create" && (
        <CreateScreen
          botUsername={botUsername}
          onCreated={handleChallengeCreated}
          onOpenRoom={openRoom}
        />
      )}
      {screen === "room" && challengeId && (
        <RoomScreen
          challengeId={challengeId}
          user={user}
          botUsername={botUsername}
          onBack={() => setScreen("lobby")}
          onDataChanged={refreshData}
          onToast={showToast}
        />
      )}
      {screen === "profile" && (
        <ProfileScreen
          user={user}
          lobby={lobby}
          products={products}
          onUserUpdated={setUser}
          onDataChanged={refreshData}
          onToast={showToast}
        />
      )}
    </>
  );

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>SquadHabit</h1>
        {user && <span className="muted">{user.firstName}</span>}
      </header>
      {appContent}
      {!booting && !bootError && (
        <BottomNav
          currentScreen={navScreen}
          onNavigate={(nextScreen) => setScreen(nextScreen)}
        />
      )}
      {toast && (
        <div className={`toast toast--${toast.type}`} role="status" key={toast.id}>
          {toast.message}
        </div>
      )}
    </main>
  );
}
