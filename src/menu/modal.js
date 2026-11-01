import { cleanName, nameProblem as textProblem, sameName } from "../names.js";
import { charWidth } from "./text.js";
import { printable } from "./keys.js";
import { toast } from "./state.js";
import { result } from "./views/common.js";
import { runAction } from "./actions.js";

// Dialogs over the view (after Pelican's): confirm (y / n), input (a line of
// text: a new account's name), choice (pick one: where to hop), thresholds
// (a small form of two numbers) and selection actions. Each holds its effect
// as data; ui/overlays.js draws them.
const close = (state) => ({ ...state, modal: null });

export function editField(field, key) {
  const chars = [...field.value];
  let cursor = Math.min(field.cursor ?? chars.length, chars.length);
  if (printable(key)) {
    chars.splice(cursor, 0, key);
    cursor++;
  } else if (key === "backspace" && cursor > 0) {
    chars.splice(cursor - 1, 1);
    cursor--;
  } else if (key === "delete") chars.splice(cursor, 1);
  else if (key === "left") cursor = Math.max(0, cursor - 1);
  else if (key === "right") cursor = Math.min(chars.length, cursor + 1);
  else if (key === "home") cursor = 0;
  else if (key === "end") cursor = chars.length;
  else if (key === "ctrl+u") {
    chars.splice(0, cursor);
    cursor = 0;
  } else return null;
  return { ...field, value: chars.join(""), cursor };
}
export function insertText(field, text) {
  const clean = String(text ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  const chars = [...field.value];
  const cursor = Math.min(field.cursor ?? chars.length, chars.length);
  const added = [...clean];
  chars.splice(cursor, 0, ...added);
  return { ...field, value: chars.join(""), cursor: cursor + added.length };
}

export function modalText(state, text) {
  const modal = state.modal;
  if (modal.kind === "input")
    return result({ ...state, modal: insertText(modal, text) });
  return null;
}

// The thresholds dialog: 5-hour and weekly, each a percentage or "default"
// (the policy's).
const thresholdFields = ["fiveHour", "weekly"];
function thresholdKeys(state, modal, key) {
  const field = thresholdFields[modal.index];
  if (key === "escape") return result(close(state));
  if (["up", "down"].includes(key))
    return result({
      ...state,
      modal: { ...modal, index: (modal.index + 1) % thresholdFields.length },
    });
  if (["left", "right"].includes(key)) {
    const direction = key === "left" ? -1 : 1;
    const current = modal.values[field] ?? modal.defaults[field];
    const value = Math.max(1, Math.min(100, current + direction));
    return result({
      ...state,
      modal: { ...modal, values: { ...modal.values, [field]: value } },
    });
  }
  if (key === "d")
    return result({
      ...state,
      modal: { ...modal, values: { ...modal.values, [field]: null } },
    });
  if (key === "enter")
    return result(close(state), [
      {
        type: "apply",
        op: "thresholds",
        args: {
          id: modal.account,
          fiveHour: modal.values.fiveHour,
          weekly: modal.values.weekly,
        },
        done: `Saved the thresholds of ${modal.accountName ?? modal.account}.`,
      },
    ]);
  return result(state);
}

// A name: any printable text (names.js), unique among the accounts
// ignoring case (the account being renamed aside).
function nameProblem(state, value, self = null) {
  const problem = textProblem(value);
  if (problem) return problem;
  const taken = state.data?.config.accounts.find(
    (a) => a.id !== self && sameName(a.name, value),
  );
  return taken ? `${taken.name} is the name of another account.` : null;
}

function submitInput(state, modal) {
  const value = cleanName(modal.value);
  if (modal.submit === "add") {
    const problem = nameProblem(state, value);
    if (problem) return result(toast(state, problem, "error"));
    // The new account's sign-in follows (the store runs it with its id).
    return result(close(state), [
      { type: "apply", op: "add", args: { name: value } },
    ]);
  }
  if (modal.submit === "rename") {
    const current = state.data?.config.accounts.find(
      (a) => a.id === modal.account,
    );
    if (current && current.name === value) return result(close(state));
    const problem = nameProblem(state, value, modal.account);
    if (problem) return result(toast(state, problem, "error"));
    return result(close(state), [
      {
        type: "apply",
        op: "rename",
        args: { id: modal.account, name: value },
        done: `Renamed ${current?.name ?? modal.account} to ${value}.`,
      },
    ]);
  }
  return result(close(state));
}

export function modalKeys(state, key) {
  const modal = state.modal;
  switch (modal.kind) {
    case "actions": {
      if (key === "escape") return result(close(state));
      const count = modal.options.length;
      if (["up", "down"].includes(key)) {
        const step = key === "up" ? -1 : 1;
        return result({
          ...state,
          modal: {
            ...modal,
            scroll: undefined,
            index: (modal.index + step + count) % count,
          },
        });
      }
      if (key === "enter")
        return runAction(state, modal.options[modal.index].command);
      const direct = modal.options.find((o) => o.key === key);
      return direct ? runAction(state, direct.command) : result(state);
    }
    case "confirm": {
      const yes = modal.focus ? modal.focus === "yes" : Boolean(modal.yes);
      if (key === "y" || (key === "enter" && yes))
        return result(close(state), [modal.effect]);
      if (["n", "escape", "enter"].includes(key)) return result(close(state));
      if (["left", "right"].includes(key))
        return result({
          ...state,
          modal: { ...modal, focus: yes ? "no" : "yes" },
        });
      return result(state);
    }
    case "input": {
      if (key === "escape") return result(close(state));
      if (key === "enter") return submitInput(state, modal);
      const edited = editField(modal, key);
      return result(edited ? { ...state, modal: edited } : state);
    }
    case "choice": {
      if (key === "escape" || key === "q") return result(close(state));
      const count = modal.options.length;
      if (key === "up")
        return result({
          ...state,
          modal: {
            ...modal,
            scroll: undefined,
            index: (modal.index - 1 + count) % count,
          },
        });
      if (key === "down")
        return result({
          ...state,
          modal: {
            ...modal,
            scroll: undefined,
            index: (modal.index + 1) % count,
          },
        });
      const pick = (i) =>
        result(close(state), [
          {
            ...modal.effect,
            args: {
              ...modal.effect.args,
              [modal.field]: modal.options[i].value,
            },
          },
        ]);
      if (/^[1-9]$/.test(key) && Number(key) <= count)
        return pick(Number(key) - 1);
      if (key === "enter") return pick(modal.index);
      return result(state);
    }
    case "thresholds":
      return thresholdKeys(state, modal, key);
    default:
      return result(close(state));
  }
}

export function fieldWindow(value, cursor, room) {
  const chars = [...String(value ?? "")];
  const at = Math.min(cursor ?? chars.length, chars.length);
  const width = (list) => list.reduce((n, c) => n + charWidth(c), 0);
  let start = 0;
  while (width(chars.slice(start, at)) > room - 1 && start < at) start++;
  let end = at + 1;
  while (end < chars.length && width(chars.slice(start, end + 1)) <= room)
    end++;
  return {
    before: chars.slice(start, at).join(""),
    at: chars[at] ?? " ",
    after: chars.slice(at + 1, Math.max(at + 1, end)).join(""),
  };
}
