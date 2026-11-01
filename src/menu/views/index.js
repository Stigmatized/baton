import { overview } from "./overview.js";
import { account } from "./account.js";
import { session, sessions } from "./session.js";
import { policy } from "./policy.js";
import { stats } from "./stats.js";

// What each kind of sidebar item shows in the right pane: model(state, item,
// box) -> { title, right, body }.
export const kinds = { overview, account, session, sessions, policy, stats };
