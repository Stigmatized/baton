import { useMemo, useSyncExternalStore } from "react";
import { Box, useInput, usePaste } from "ink";
import { s } from "../lines.js";
import { makeTheme, ThemeContext, useTheme } from "../theme.js";
import { bodyHeight, frameCols, frameRows, tooSmall } from "../layout.js";
import { keyOf } from "../keys.js";
import { paneBox } from "../pane.js";
import { sideWidth } from "../tree.js";
import { footerLine } from "./chrome.js";
import { h, Lines } from "./kit.js";
import { Sidebar } from "./sidebar.js";
import { RightPane } from "./pane.js";
import { Modal, Toasts } from "./overlays.js";
import { Splash } from "./splash.js";

function Body({ state }) {
  const width = frameCols(state),
    height = bodyHeight(state);
  if (!state.data)
    return h(Lines, {
      lines: [[], [s("  Loading your accounts...", "muted")]],
      width,
      height,
    });
  return h(
    Box,
    { flexDirection: "row", width, height },
    h(Sidebar, { state, width: sideWidth(state), height }),
    h(RightPane, { state, box: paneBox(state) }),
  );
}
function Frame({ state }) {
  const theme = useTheme();
  const cols = frameCols(state),
    rows = frameRows(state);
  return h(
    Box,
    {
      width: cols,
      height: rows,
      flexDirection: "column",
      backgroundColor: theme.tone("background"),
    },
    tooSmall(state) || state.splash
      ? h(Splash, { state, error: tooSmall(state) })
      : h(
          Box,
          { width: cols, height: rows, flexDirection: "column" },
          h(
            Box,
            { width: cols, height: bodyHeight(state), overflow: "hidden" },
            h(Body, { state }),
          ),
          h(Lines, {
            lines: [footerLine(state, theme.g)],
            width: cols,
            height: 1,
          }),
          ...(state.toasts.length ? [h(Toasts, { key: "toasts", state })] : []),
          ...(state.modal ? [h(Modal, { key: "modal", state })] : []),
        ),
  );
}
export function Screen({ state }) {
  const theme = useMemo(
    () => makeTheme({ color: state.color, glyphs: state.glyphs }),
    [state.color, state.glyphs],
  );
  return h(ThemeContext.Provider, { value: theme }, h(Frame, { state }));
}
export function App({ store }) {
  const state = useSyncExternalStore(
    store.subscribe,
    store.getState,
    store.getState,
  );
  useInput((input, key) => {
    const name = keyOf(input, key);
    if (name && typeof name === "object")
      store.dispatch({ type: "text", text: name.text });
    else if (name) store.dispatch({ type: "key", key: name });
  });
  usePaste((text) => store.dispatch({ type: "paste", text }));
  return h(Screen, { state });
}
