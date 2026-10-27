/**
 * `pnpm service <verb>`: install, uninstall, start, stop, restart or report
 * the daemon's login service. See `startup.ts`.
 */
import { manage, verbs, type Verb } from "./startup.js";

const isVerb = (value: string | undefined): value is Verb =>
  verbs.some((verb) => verb === value);

const verb = process.argv[2];
if (!isVerb(verb)) {
  console.error(`usage: pnpm service <${verbs.join("|")}>`);
  process.exit(2);
}
try {
  await manage(verb);
} catch (error) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
