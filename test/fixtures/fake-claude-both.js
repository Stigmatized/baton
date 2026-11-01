// The fake claude for a whole baton instance: the lead wrapper's session
// (fake-claude.js, its scenario) and the usage poller's reads (auth status
// and the Agent SDK's stream-json: fake-usage-claude.js).
const argv = process.argv.slice(2);
if (
  (argv[0] === "auth" && argv[1] === "status") ||
  argv.includes("--input-format")
)
  await import("./fake-usage-claude.js");
else await import("./fake-claude.js");
