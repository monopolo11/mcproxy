import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchdPid,
  launchdPlist,
  systemdUnit,
  windowsScript,
  type Target,
} from "../src/startup.js";

const target: Target = {
  node: "/Users/me/.local/share/fnm/node-versions/v22/installation/bin/node",
  main: "/Users/me/Dev/my proxy/apps/server/dist/main.js",
  cwd: "/Users/me/Dev/my proxy",
  envFile: "/Users/me/Dev/my proxy/.env",
  path: "/opt/homebrew/bin:/usr/bin:/bin",
  port: "8080",
};

test("launchd agent runs main.js with the .env, snapshots PATH and PORT, and restarts only after a crash", () => {
  const plist = launchdPlist(
    { ...target, path: 'a&b:/c"d' },
    "/Users/me/Library/Logs/mcproxy/mcproxy.log",
  );
  assert.match(plist, /<string>\/Users\/me\/Dev\/my proxy\/apps\/server\/dist\/main.js<\/string>/);
  assert.match(plist, /<string>--env-file-if-exists=\/Users\/me\/Dev\/my proxy\/.env<\/string>/);
  assert.match(plist, /<key>PATH<\/key>\n\t\t<string>a&amp;b:\/c&quot;d<\/string>/);
  assert.match(plist, /<key>PORT<\/key>\n\t\t<string>8080<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\n\t<dict>\n\t\t<key>SuccessfulExit<\/key>\n\t\t<false\/>/);
  assert.doesNotMatch(launchdPlist({ ...target, port: undefined }, "/tmp/x.log"), /PORT/);
});

test("launchctl print output yields the pid only while running", () => {
  assert.equal(launchdPid("\tstate = running\n\tpid = 4242\n"), 4242);
  assert.equal(launchdPid("\tstate = not running\n"), undefined);
});

test("systemd unit quotes paths with spaces and stops restarting after a clean exit", () => {
  const unit = systemdUnit({ ...target, cwd: "/home/me/proxy", path: 'x"y' });
  assert.match(unit, /^ExecStart="\/Users\/me\/\.local\/[^"]*\/node" "--env-file-if-exists=\/Users\/me\/Dev\/my proxy\/\.env" "\/Users\/me\/Dev\/my proxy\/apps\/server\/dist\/main\.js"$/m);
  assert.match(unit, /^Environment="PATH=x\\"y" "PORT=8080"$/m);
  assert.match(unit, /^Restart=on-failure$/m);
  assert.match(unit, /^WantedBy=default\.target$/m);
});

test("windows script pre-quotes node arguments, escapes single quotes and never starts a second daemon", () => {
  const script = windowsScript(
    {
      ...target,
      node: "C:\\Program Files\\nodejs\\node.exe",
      main: "C:\\Users\\o'neil\\mcproxy\\apps\\server\\dist\\main.js",
      cwd: "C:\\Users\\o'neil\\mcproxy",
      envFile: "C:\\Users\\o'neil\\mcproxy\\.env",
    },
    "C:\\Users\\o'neil\\AppData\\Local\\mcproxy\\mcproxy.log",
  );
  assert.match(script, /\$main = 'C:\\Users\\o''neil\\mcproxy\\apps\\server\\dist\\main\.js'/);
  assert.match(script, /-ArgumentList @\('"--env-file-if-exists=C:\\Users\\o''neil\\mcproxy\\\.env"', '"C:\\Users\\o''neil\\mcproxy\\apps\\server\\dist\\main\.js"'\)/);
  assert.match(script, /-FilePath 'C:\\Program Files\\nodejs\\node\.exe'/);
  assert.match(script, /-RedirectStandardError 'C:\\Users\\o''neil\\AppData\\Local\\mcproxy\\mcproxy\.err\.log'/);
  assert.match(script, /if \(\$running\) \{ exit 0 \}\r\n    \$env:PORT = '8080'/);
});
