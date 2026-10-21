import * as React from "react";

export type ThemePreference = "light" | "dark" | "system";
const KEY = "ctxpool.theme";

function stored(): ThemePreference {
  try {
    const value = localStorage.getItem(KEY);
    if (value === "light" || value === "dark" || value === "system") return value;
  } catch {
    // Storage can be blocked; fall back to the system theme.
  }
  return "system";
}

export function useTheme(): [ThemePreference, (next: ThemePreference) => void] {
  const [preference, setPreference] = React.useState<ThemePreference>(stored);
  React.useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => document.documentElement.classList.toggle("dark", preference === "dark" || (preference === "system" && media.matches));
    apply();
    media.addEventListener("change", apply);
    try {
      localStorage.setItem(KEY, preference);
    } catch {
      // The theme still applies for this visit.
    }
    return () => media.removeEventListener("change", apply);
  }, [preference]);
  return [preference, setPreference];
}
