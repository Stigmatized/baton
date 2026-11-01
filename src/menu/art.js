import { s } from "./lines.js";

// One ASCII mark across the splash, workspace, size error and login.
export const logo = [
  "    ____  ___  __________  _   __",
  "   / __ )/   |/_  __/ __ \\/ | / /",
  "  / __  / /| | / / / / / /  |/ /",
  " / /_/ / ___ |/ / / /_/ / /|  /",
  "/_____/_/  |_/_/  \\____/_/ |_/",
];
export const wordmark = () => logo.map((line) => [s(line, "brand bold")]);
export const splashArt = wordmark;
export const motto = ["Your Claude accounts.", "One continuous conversation."];
export const slogan = "Keep the conversation moving.";
export const captionLines = (indent = "") => [
  [s(indent + slogan, "accent bold")],
  ...motto.map((line) => [s(indent + line, "muted")]),
];
export const branding = (indent = "") => [
  ...wordmark().map((line) => [s(indent), ...line]),
  [],
  ...captionLines(indent),
];
export const relayArt = [
  [s("        .----------------------.", "brand")],
  [s("   ----/  / / / / / / / / /   /----", "brand")],
  [s("      '----------------------'", "brand")],
];
