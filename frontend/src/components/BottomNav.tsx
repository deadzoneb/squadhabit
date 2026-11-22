import type { Screen } from "../types";
import { haptic } from "../lib/telegram";

type NavScreen = Exclude<Screen, "room">;

interface BottomNavProps {
  currentScreen: NavScreen;
  onNavigate: (screen: NavScreen) => void;
}

const items: Array<{ id: NavScreen; label: string; icon: string }> = [
  { id: "lobby", label: "Лобби", icon: "🏠" },
  { id: "create", label: "Создать", icon: "✨" },
  { id: "profile", label: "Профиль", icon: "👤" },
];

export default function BottomNav({ currentScreen, onNavigate }: BottomNavProps) {
  return (
    <nav className="bottom-nav" aria-label="Основная навигация">
      {items.map((item) => (
        <button
          key={item.id}
          className="nav-button"
          type="button"
          aria-current={currentScreen === item.id ? "page" : undefined}
          onClick={() => {
            haptic({ type: "selection" });
            onNavigate(item.id);
          }}
        >
          <span className="nav-icon" aria-hidden="true">{item.icon}</span>
          <span className="nav-label">{item.label}</span>
        </button>
      ))}
    </nav>
  );
}
