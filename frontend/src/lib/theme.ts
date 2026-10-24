import { useCallback, useEffect, useState } from "react";

export type ThemeMode = "light" | "dark";

const THEME_KEY = "card_theme";

function isMode(value: unknown): value is ThemeMode {
  return value === "light" || value === "dark";
}

export function readTheme(): ThemeMode {
  if (typeof document === "undefined") return "light";
  const current = document.documentElement.dataset.theme;
  return isMode(current) ? current : "light";
}

export function applyTheme(mode: ThemeMode) {
  document.documentElement.dataset.theme = mode;
  document.documentElement.style.colorScheme = mode;
  try {
    localStorage.setItem(THEME_KEY, mode);
  } catch {
    /* storage unavailable */
  }
}

export function useTheme() {
  const [mode, setMode] = useState<ThemeMode>(() => readTheme());

  useEffect(() => {
    applyTheme(mode);
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => (prev === "dark" ? "light" : "dark"));
  }, []);

  return { mode, setMode, toggle };
}
