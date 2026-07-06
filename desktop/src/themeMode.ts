import { createContext, useContext } from "react";

export type ThemeMode = "light" | "dark";

export type ThemeModeContextValue = {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
};

export const ThemeModeContext = createContext<ThemeModeContextValue>({
  mode: "light",
  setMode: () => undefined,
});

export function useThemeMode() {
  return useContext(ThemeModeContext);
}
