import {
  accountById,
  accounts,
  configOf,
  sessionById,
  signedOut,
  toast,
} from "./state.js";
import { result } from "./views/common.js";
import { span } from "./text.js";

// The selection's menu commands and the effects the runtime carries out
// through the same core functions as the CLI. Accounts are named by
// their id, so a rename in between never acts on the wrong one.
export function itemActions(state, item) {
  const out = [];
  if (item.kind === "account") {
    const a = accountById(state, item.accountId);
    if (!a) return out;
    const last = accounts(state).length - 1;
    if (a.index > 0) out.push(["K", "up"]);
    if (a.index < last) out.push(["J", "down"]);
    out.push(["r", "usage now"]);
    out.push(["e", "edit name"]);
    out.push(["t", "thresholds"]);
    out.push(["s", signedOut(state, a.id) ? "sign in" : "sign in again"]);
    out.push(["a", "add"]);
    out.push(["d", "remove"]);
  } else if (item.kind === "session") {
    const x = sessionById(state, item.sessionId);
    if (x?.live) out.push(["h", "hop"], ["H", "hop to"]);
  } else if (item.kind === "overview") {
    out.push(["r", "usage now"]);
    out.push(["a", "add account"]);
  }
  return out;
}

const apply = (op, args, done) => ({ type: "apply", op, args, done });

export function openActions(state, item) {
  if (item.kind !== "account") {
    const options =
      item.kind === "overview"
        ? [{ label: "Refresh all accounts", command: "r", key: "r" }]
        : item.kind === "session" && sessionById(state, item.sessionId)?.live
          ? [
              { label: "Move to best account", command: "h", key: "h" },
              { label: "Move to an account", command: "H", key: "H" },
            ]
          : [];
    return options.length
      ? result({
          ...state,
          modal: {
            kind: "actions",
            title:
              item.kind === "overview" ? "Overview actions" : "Session actions",
            lines: [],
            item,
            index: 0,
            options,
          },
        })
      : result(state);
  }
  const account = accountById(state, item.accountId);
  if (!account) return result(state);
  const offered = itemActions(state, item).map(([key]) => key);
  const options = [
    { label: "Rename", command: "e", key: "e" },
    { label: "Change mode", command: "mode", key: "m" },
    { label: "Usage thresholds", command: "t", key: "t" },
    { label: "Refresh usage", command: "r", key: "r" },
    {
      label: signedOut(state, account.id) ? "Sign in" : "Sign in again",
      command: "s",
      key: "s",
    },
    ...(offered.includes("K")
      ? [{ label: "Move up", command: "K", key: "K" }]
      : []),
    ...(offered.includes("J")
      ? [{ label: "Move down", command: "J", key: "J" }]
      : []),
    { label: "Delete account", command: "d", key: "d" },
  ];
  return result({
    ...state,
    modal: {
      kind: "actions",
      title: "Account actions",
      lines: [account.name],
      item,
      index: 0,
      options,
    },
  });
}

export function runAction(state, command) {
  const item = state.modal.item;
  const id = item.accountId;
  const next = { ...state, modal: null };
  if (command !== "mode") return act(next, item, command) ?? result(next);
  const account = accountById(state, id);
  if (!account) return result(next);
  const options = [
    { label: "Preferred", value: "preferred" },
    { label: "Normal", value: "normal" },
    { label: "Last resort", value: "last-resort" },
  ];
  return result({
    ...next,
    modal: {
      kind: "choice",
      title: "Account mode",
      lines: [account.name],
      options,
      index: Math.max(
        0,
        options.findIndex((o) => o.value === account.mark),
      ),
      field: "mark",
      submitLabel: "Set mode",
      effect: apply("mark", { id }, `Updated the mode of ${account.name}.`),
    },
  });
}

export function act(state, item, key) {
  const offered = itemActions(state, item).map(([k]) => k);
  const k = key;
  if (!offered.includes(k)) return null;
  if (k === "a")
    return result({
      ...state,
      modal: {
        kind: "input",
        title: "Add an account",
        lines: [
          "Any name you like (an email, words, any script). Baton makes its profile, then Claude Code's sign-in runs in this terminal.",
        ],
        value: "",
        cursor: 0,
        submit: "add",
      },
    });
  // r: the account's usage now (the Overview: every account's).
  if (k === "r")
    return result(state, [
      {
        type: "refresh",
        account: item.kind === "account" ? item.accountId : null,
      },
    ]);
  if (item.kind === "account") {
    const a = accountById(state, item.accountId);
    const { id, name } = a;
    switch (k) {
      case "K":
        return result(state, [
          apply("move", { id, position: a.index }, `${name} moved up.`),
        ]);
      case "J":
        return result(state, [
          apply("move", { id, position: a.index + 2 }, `${name} moved down.`),
        ]);
      case "e":
        return result({
          ...state,
          modal: {
            kind: "input",
            title: `Rename ${name}`,
            lines: [
              "Any name you like (an email, words, any script). Its profile, sign-in, sessions and history stay as they are.",
            ],
            value: name,
            cursor: [...name].length,
            submit: "rename",
            account: id,
          },
        });
      case "t": {
        const config = configOf(state, id);
        return result({
          ...state,
          modal: {
            kind: "thresholds",
            account: id,
            accountName: name,
            index: 0,
            values: {
              fiveHour: config?.fiveHour ?? null,
              weekly: config?.weekly ?? null,
            },
            defaults: {
              fiveHour: state.data.policy.fiveHour,
              weekly: state.data.policy.weekly,
            },
          },
        });
      }
      case "s":
        return result(state, [{ type: "signin", account: id }]);
      case "d": {
        if (accounts(state).length === 1)
          return result(
            toast(
              state,
              `${name} is the only account and Baton needs one: add another first.`,
              "error",
            ),
          );
        const running = state.data.sessions.some(
          (x) => x.live && x.account === id,
        )
          ? [`A session runs on ${name} now; it keeps running.`]
          : [];
        return result({
          ...state,
          modal: {
            kind: "confirm",
            title: `Remove ${name} from Baton?`,
            lines: [
              "Its profile folder stays (it holds that account's sign-in); delete it yourself when you no longer need it.",
              ...running,
            ],
            effect: apply("remove", { id }, `Removed ${name}.`),
          },
        });
      }
      default:
        return null;
    }
  }
  if (item.kind === "session") {
    const x = sessionById(state, item.sessionId);
    if (k === "h")
      return result(state, [apply("hop", { session: x.id, to: null })]);
    if (k === "H") {
      const options = accounts(state)
        .filter((a) => a.id !== x.account)
        .map((a) => ({
          value: a.id,
          label: `${a.name}${a.blocked ? `  blocked ${a.availableKnown ? span(a.availableAt - state.now) : ""}`.trimEnd() : ""}`,
        }));
      if (!options.length) return null;
      return result({
        ...state,
        modal: {
          kind: "choice",
          title: `Move ${x.name} at the end of its turn to`,
          lines: [],
          options,
          index: 0,
          field: "to",
          effect: apply("hop", { session: x.id }),
        },
      });
    }
  }
  return null;
}
