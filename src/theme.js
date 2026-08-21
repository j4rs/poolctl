/**
 * Design tokens.
 *
 * These are `var(--x)` references, not colour literals — the real values live
 * in `theme.css` so the palette can swap at runtime. Consumers are unchanged:
 * `C.water` still works anywhere a CSS value is accepted.
 *
 * One trap. `var()` does NOT resolve in SVG *presentation attributes*
 * (`fill="…"`), only in CSS. Inside SVG, set colours via `style={{ fill }}`.
 */
export const C = {
  ground: "var(--ground)",
  surface: "var(--surface)",
  surfaceUp: "var(--surface-up)",
  line: "var(--line)",
  water: "var(--water)",
  waterDim: "var(--water-dim)",
  heat: "var(--heat)",
  stone: "var(--stone)",
  muted: "var(--muted)",
  faint: "var(--faint)",
  alert: "var(--alert)",
  /** Tint behind selected surfaces. Replaces hardcoded rgba(79,191,180,…). */
  wash: "var(--wash)",
  /** Modal backdrop. */
  scrim: "var(--scrim)",
  /** Shadow under sheets. */
  lift: "var(--lift)",
};

export const FONT_UI =
  "'Archivo', ui-sans-serif, -apple-system, system-ui, sans-serif";
export const FONT_DATA =
  "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace";

/* ---------------------------------------------------------------------- */

const KEY = "poolctl.theme";
export const THEMES = ["auto", "dark", "light"];

/** Persisted preference: 'auto' follows the OS, otherwise forced. */
export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return THEMES.includes(v) ? v : "auto";
  } catch {
    return "auto";
  }
}

export function applyTheme(theme) {
  const root = document.documentElement;
  if (theme === "auto") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* private mode — the theme still applies for this session */
  }
  /* Keep the browser chrome in step with the page. */
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute(
      "content",
      getComputedStyle(root).getPropertyValue("--ground").trim() || "#0c1618",
    );
  }
}
