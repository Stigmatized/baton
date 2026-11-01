// Account names are labels only: folders, files, hook arguments and
// environment variables use the account's stable id, never its name. So a
// name may be any printable text the operator likes (an email, words with
// spaces, any script): trimmed, not empty, at most NAME_MAX characters, no
// control characters, line breaks or bidirectional overrides, unique
// ignoring case.

export const NAME_MAX = 120;
const FORBIDDEN = /[\p{Cc}\p{Zl}\p{Zp}\u202A-\u202E\u2066-\u2069]/u;

export const cleanName = (value) =>
  typeof value === "string" ? value.normalize("NFC").trim() : value;

// Why a name cannot be used, or null when it can.
export function nameProblem(value) {
  if (typeof value !== "string") return "A name is text.";
  const name = cleanName(value);
  if (!name) return "A name cannot be empty.";
  if (FORBIDDEN.test(name))
    return "A name cannot hold control characters or line breaks.";
  if ([...name].length > NAME_MAX)
    return `A name is at most ${NAME_MAX} characters.`;
  return null;
}
export const validName = (value) => nameProblem(value) === null;

const fold = (value) => cleanName(String(value)).toLowerCase();
export const sameName = (a, b) => fold(a) === fold(b);

// The id a new account gets from its name: lower case letters, digits, - and
// _ (anything else becomes -), at most 40 characters, "account" when nothing
// is left; config.js and accounts.js make it unique.
export function idFromName(name) {
  const base = fold(name)
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 40)
    .replace(/[-_]+$/g, "");
  return base || "account";
}
