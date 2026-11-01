import { createContext, useContext } from "react";
import { glyphSets, makeTheme } from "./theme-core.js";

// The menu's look lives in theme-core.js (no React); this adds the Ink
// context the components read it from.
export * from "./theme-core.js";

export const ThemeContext = createContext(makeTheme());
export const useTheme = () => useContext(ThemeContext);
export const glyphsOf = (state) => glyphSets[state.glyphs] ?? glyphSets.rich;
