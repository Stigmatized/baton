import { Box } from "ink";
import { fitLine, lineWidth, s } from "../lines.js";
import { frameCols, frameRows, minSize } from "../layout.js";
import { splashArt, relayArt, captionLines, slogan } from "../art.js";
import { h, Line } from "./kit.js";

export function Splash({ state, error = false }) {
  const cols = frameCols(state),
    rows = frameRows(state);
  const art = [...(rows >= 24 ? [...relayArt, []] : []), ...splashArt()];
  const artWidth = Math.max(...art.map(lineWidth));
  const captions = captionLines();
  const captionWidth = Math.max(...captions.map(lineWidth));
  const lines = [
    ...art.map((line) => fitLine(line, artWidth)),
    [],
    ...(error
      ? [[s(slogan, "accent bold")]]
      : captions.map((line) => fitLine(line, captionWidth))),
    ...(error
      ? [
          [],
          [s("A little more room.", "accent")],
          [
            s(
              "Baton needs " +
                minSize.cols +
                " x " +
                minSize.rows +
                " terminal cells.",
              "muted",
            ),
          ],
          [
            s(
              "Current size: " +
                state.size.cols +
                " x " +
                state.size.rows +
                ". Resize to continue.",
              "muted",
            ),
          ],
          [],
          [s("q  Quit", "muted")],
        ]
      : [[], [], [s("Press any key to start", "accent bold")]]),
  ];
  const shown =
    rows >= lines.length
      ? lines
      : [[s("BATON", "brand bold")], [], ...lines.slice(error ? -5 : -1)];
  return h(
    Box,
    {
      width: cols,
      height: rows,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
    },
    ...shown.map((line, i) =>
      h(
        Box,
        { key: i, width: cols, height: 1, justifyContent: "center" },
        h(Line, { line }),
      ),
    ),
  );
}
