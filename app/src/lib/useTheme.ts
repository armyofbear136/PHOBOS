// src/lib/useTheme.ts
// Single import point for theme access across the app.
// Components import from here, not directly from next-themes,
// so the underlying provider can be swapped without touching callsites.
export { useTheme } from "next-themes";
