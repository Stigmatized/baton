// One fixed rail, one workspace and a quiet footer. A reserved last row
// avoids Windows console scrolling when the bottom-right cell is written.
export const minSize = { cols: 100, rows: 28 };
export const headerRows = 0;
export const footerRows = 1;

export const frameCols = (state) => Math.max(1, state.size.cols);
export const frameRows = (state) => Math.max(1, state.size.rows - 1);
export const bodyHeight = (state) =>
  Math.max(1, frameRows(state) - headerRows - footerRows);
export const isNarrow = () => false;
export const tooSmall = (state) =>
  state.size.cols < minSize.cols || state.size.rows < minSize.rows;

export const sidebarCols = 46;
export const sideBrandRows = 13;
export const sideFooterRows = 3;
export const paneHeaderRows = 4;
export const inner = (width, height) => ({
  width: Math.max(1, width - 6),
  height: Math.max(1, height - paneHeaderRows - 1),
});
