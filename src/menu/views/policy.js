import { POLICY_DEFAULTS } from "../../config.js";
import { lineWidth, s } from "../lines.js";
import { width as cells } from "../text.js";
import { toast } from "../state.js";
import { glyphsOf } from "../theme.js";
import { result } from "./common.js";

// The policy settings as a form (after Pelican's settings form): ↑↓ a field,
// ←→ change it, Enter asks to confirm, Esc leaves
// without saving. Each field has a one-line hint that never wraps: its
// short form, or none, when the line has no room for it.
export const fields = [
  {
    key: "mode",
    label: "Mode",
    kind: "choice",
    choices: ["smart", "order"],
    help: "smart picks by room and urgency; order fills one then next",
    short: "how accounts are picked",
  },
  {
    key: "fiveHour",
    label: "5-hour limit",
    kind: "number",
    min: 1,
    max: 100,
    step: 1,
    unit: "%",
    help: "an account at or above it is blocked (default for all)",
    short: "blocked at or above",
  },
  {
    key: "weekly",
    label: "Weekly limit",
    kind: "number",
    min: 1,
    max: 100,
    step: 1,
    unit: "%",
    help: "an account at or above it is blocked (default for all)",
    short: "blocked at or above",
  },
  {
    key: "startReserve",
    label: "Start reserve",
    kind: "number",
    min: 0,
    max: 100,
    step: 5,
    unit: "%",
    help: "5-hour room an account needs to take new work",
    short: "room for new work",
  },
  {
    key: "planFactor",
    label: "Plan factor",
    kind: "number",
    min: 0,
    max: 10,
    step: 0.1,
    unit: "x",
    help: "hop between turns when room < factor x next turn",
    short: "x the next turn",
  },
  {
    key: "waitInPlaceMinutes",
    label: "Wait in place",
    kind: "number",
    min: 0,
    max: 600,
    step: 5,
    unit: "min",
    help: "a 5-hour refusal ending this soon waits instead",
    short: "wait if sooner",
  },
  {
    key: "minStayMinutes",
    label: "Min stay",
    kind: "number",
    min: 0,
    max: 600,
    step: 5,
    unit: "min",
    help: "no planned hop sooner after arriving (no ping-pong)",
    short: "no ping-pong",
  },
  {
    key: "compactionRebalance",
    label: "Rebalance",
    kind: "boolean",
    help: "rebalance at the cheap moment after a compaction",
    short: "after compaction",
  },
  {
    key: "usagePollMinutes",
    label: "Usage poll",
    kind: "number",
    min: 0,
    max: 1440,
    step: 5,
    unit: "min",
    help: "ask every account's usage this often (0: on request)",
    short: "every",
  },
  {
    key: "statusLineUsage",
    label: "Bar usage",
    kind: "boolean",
    help: "add Baton's usage after your own status line",
    short: "after yours",
  },
];
const applyRow = fields.length;

export function startForm(policy) {
  const values = Object.fromEntries(fields.map((f) => [f.key, policy[f.key]]));
  return { original: { ...values }, values: { ...values }, index: 0 };
}
const round = (n) => Math.round(n * 100) / 100;
export const show = (field, value) =>
  field.kind === "boolean"
    ? value
      ? "on"
      : "off"
    : field.kind === "number"
      ? `${round(value)}${field.unit === "%" ? "%" : field.unit === "x" ? "x" : ` ${field.unit}`}`
      : String(value);
export const changes = (form) =>
  Object.fromEntries(
    fields
      .filter((f) => form.values[f.key] !== form.original[f.key])
      .map((f) => [f.key, form.values[f.key]]),
  );

function control(field, value, changed, g) {
  const tone = changed ? "warn bold" : "bold";
  if (field.kind === "number")
    return [
      s(`${g.left} `, "muted"),
      s(show(field, value).padStart(6), tone),
      s(` ${g.right}`, "muted"),
    ];
  if (field.kind === "boolean")
    return [
      s(value ? `${g.dot} ` : `${g.ring} `, value ? "ok" : "muted"),
      s(show(field, value), tone),
    ];
  return field.choices.flatMap((c, i) => [
    ...(i ? [s(" ")] : []),
    s(c === value ? `[${c}]` : ` ${c} `, c === value ? tone : "muted"),
  ]);
}

export function formLines(form, width, { g, focused }) {
  const changed = changes(form);
  const count = Object.keys(changed).length;
  const lines = [];
  const labelWidth = Math.max(...fields.map((f) => cells(f.label))) + 2;
  const controls = fields.map((f) =>
    control(f, form.values[f.key], f.key in changed, g),
  );
  const controlWidth = Math.max(...controls.map(lineWidth)) + 2;
  for (const [i, f] of fields.entries()) {
    const at = i === form.index;
    const line = [
      s(at ? `${g.arrow} ` : "  ", "accent bold"),
      s(f.label.padEnd(labelWidth), at && focused ? "selected bold" : "bold"),
      ...controls[i],
      s(" ".repeat(Math.max(2, controlWidth - lineWidth(controls[i])))),
    ];
    const room = width - lineWidth(line);
    const hint = [f.help, f.short].find((h) => h && cells(h) <= room);
    if (hint) line.push(s(hint, "muted"));
    lines.push(line);
  }
  lines.push([]);
  const atApply = form.index === applyRow;
  lines.push([
    s(atApply ? `${g.arrow} ` : "  ", "accent bold"),
    s(
      ` Apply${count ? ` ${count} change${count === 1 ? "" : "s"}` : ""} `,
      atApply && focused ? "selected bold" : count ? "accent bold" : "muted",
    ),
    s(count ? "  asks to confirm first" : "  nothing changed yet", "muted"),
  ]);
  const defaults = fields.filter(
    (f) => form.values[f.key] !== POLICY_DEFAULTS[f.key],
  ).length;
  lines.push(
    [],
    [
      s(
        defaults
          ? `${defaults} differ from the defaults (d resets the field)`
          : "all at their defaults",
        "muted",
      ),
    ],
  );
  return lines;
}

const step = (field, value, direction) => {
  if (field.kind === "number")
    return round(
      Math.max(field.min, Math.min(field.max, value + direction * field.step)),
    );
  if (field.kind === "boolean") return !value;
  const at = field.choices.indexOf(value);
  return field.choices[
    (at + direction + field.choices.length) % field.choices.length
  ];
};
const withValue = (state, key, value) => ({
  ...state,
  form: { ...state.form, values: { ...state.form.values, [key]: value } },
});

export function confirmApply(state) {
  const changed = changes(state.form);
  if (!Object.keys(changed).length)
    return result(toast(state, "Nothing changed."));
  return result({
    ...state,
    modal: {
      kind: "confirm",
      yes: true,
      title: "Apply these policy settings?",
      lines: fields
        .filter((f) => f.key in changed)
        .map(
          (f) =>
            `${f.label}: ${show(f, state.form.original[f.key])} → ${show(f, changed[f.key])}`,
        ),
      effect: {
        type: "apply",
        op: "policy",
        args: { changes: changed },
        done: "Saved the policy.",
      },
    },
  });
}

export function closeForm(state) {
  if (!state.form) return state;
  const dirty = Object.keys(changes(state.form)).length;
  const next = { ...state, form: null };
  return dirty ? toast(next, "Policy left unchanged.") : next;
}

const moves = { up: -1, down: 1 };
export function formKeys(state, key) {
  const form = state.form;
  if (!form) return null;
  const count = fields.length + 1;
  let index = null;
  if (key in moves)
    index = Math.max(0, Math.min(count - 1, form.index + moves[key]));
  else if (key === "home") index = 0;
  else if (key === "end") index = count - 1;
  if (index !== null) return result({ ...state, form: { ...form, index } });
  if (key === "escape") return result({ ...closeForm(state), focus: "side" });
  const field = fields[form.index];
  if (key === "enter") return confirmApply(state);
  if (!field) return result(state);
  if (["left", "right"].includes(key))
    return result(
      withValue(
        state,
        field.key,
        step(field, form.values[field.key], key === "left" ? -1 : 1),
      ),
    );
  if (key === "d")
    return result(withValue(state, field.key, POLICY_DEFAULTS[field.key]));
  return null;
}
export const policy = {
  model(state, item, box) {
    const form = state.form ?? startForm(state.data.policy);
    return {
      title: [s("Policy", "bold")],
      right: Object.keys(changes(form)).length
        ? [s(`${Object.keys(changes(form)).length} unsaved`, "warn bold")]
        : [s(state.data.policy.mode, "muted")],
      body: formLines(form, box.room.width, {
        g: glyphsOf(state),
        focused: state.focus === "pane" && !!state.form,
      }),
    };
  },
};
