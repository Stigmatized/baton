// The menu's state and what the sidebar and the panes read from it. Pure:
// the reducer changes state, the components draw it.
export function initialState({
  size = { cols: 100, rows: 30 },
  now = 0,
  color = true,
  glyphs = "rich",
  data = null,
  splash = false,
} = {}) {
  return {
    now,
    size,
    color,
    glyphs,
    // Keyboard focus: the list ("side"), pinned "search" or "add" control,
    // or the Policy editor ("pane"). Pinned focus preserves the open view.
    focus: "side",
    selected: "overview",
    index: 0,
    // Folded groups the person opened (more:sessions).
    open: {},
    filter: "",
    filtering: false,
    // Per pane: the scroll position.
    views: {},
    // The policy form while it is open.
    form: null,
    modal: null,
    toasts: [],
    toastSeq: 0,
    data,
    splash,
    // Sign-in per account: { loggedIn, authMethod } or { error }, from
    // `claude auth status` (method only, never the email).
    auth: {},
    // What runs right now (a sign-in), shown in the header.
    busy: null,
  };
}

export const accounts = (state) => state.data?.states ?? [];
// Accounts by id (a rename changes only the name); nameOf for display.
export const accountById = (state, id) =>
  accounts(state).find((a) => a.id === id) ?? null;
export const configOf = (state, id) =>
  state.data?.config.accounts.find((a) => a.id === id) ?? null;
export const nameOf = (state, id) => configOf(state, id)?.name ?? id;
export const sessions = (state) => state.data?.sessions ?? [];
export const liveSessions = (state) => sessions(state).filter((x) => x.live);
export const recentSessions = (state) => sessions(state).filter((x) => !x.live);
export const sessionById = (state, id) =>
  sessions(state).find((x) => x.id === id) ?? null;
export const sessionsOn = (state, id) =>
  liveSessions(state).filter((x) => x.account === id);
export const signedOut = (state, id) => state.auth[id]?.loggedIn === false;

export const toastTtl = { error: 10000, ok: 5000, info: 4000 };
export function toast(state, text, tone = "info") {
  const id = state.toastSeq + 1;
  return {
    ...state,
    toastSeq: id,
    toasts: [...state.toasts, { id, text, tone, at: state.now }].slice(-3),
  };
}
export function expireToasts(state) {
  const kept = state.toasts.filter(
    (t) => state.now - t.at < (toastTtl[t.tone] ?? 5000),
  );
  return kept.length === state.toasts.length
    ? state
    : { ...state, toasts: kept };
}
export const lastToast = (state) => state.toasts.at(-1)?.text ?? null;
