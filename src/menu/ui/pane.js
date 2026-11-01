import { Box } from "ink";
import { lineWidth, restyle, s, spread } from "../lines.js";
import { useTheme } from "../theme.js";
import { currentItem, paneModel, paneWindow } from "../pane.js";
import { paneHeaderRows } from "../layout.js";
import { h, Lines } from "./kit.js";
import { legendLine } from "../legend.js";

export function RightPane({ state, box }) {
  const theme = useTheme();
  const model = paneModel(state, currentItem(state), box);
  const w = paneWindow(state, model, box);
  const title = restyle(model.title, "bold");
  const right = state.busy ? [s(state.busy, "accent")] : model.right;
  const progress = w.max
    ? [
        s(
          w.top +
            1 +
            "–" +
            Math.min(w.total, w.top + w.room) +
            " of " +
            w.total,
          "muted",
        ),
      ]
    : [];
  return h(
    Box,
    {
      width: box.width,
      height: box.height,
      flexDirection: "column",
      paddingX: 3,
    },
    h(Lines, {
      lines: [[], title, right, []],
      width: box.room.width,
      height: paneHeaderRows,
    }),
    h(Lines, {
      lines: w.lines,
      width: box.room.width,
      height: box.room.height,
    }),
    h(Lines, {
      lines: [
        spread(
          legendLine(
            state,
            currentItem(state).kind,
            box.room.width - (progress.length ? lineWidth(progress) + 3 : 0),
          ),
          progress,
          box.room.width,
        ),
      ],
      width: box.room.width,
      height: 1,
    }),
  );
}
