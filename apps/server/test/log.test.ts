import { test } from "node:test";
import assert from "node:assert/strict";
import { formatLine, isUntrustedCertificate, reason } from "../src/log.js";
import { AppError } from "../src/model.js";

test("formatLine prefixes a local timestamp, level and scope, and quotes only values that need it", () => {
  const at = new Date(2026, 8, 23, 9, 5, 7, 42);
  const line = formatLine("warn", "proxy", "session closed", {
    session: "abc",
    profile: undefined,
    why: 'listens to "x"',
    count: 2,
  }, at);
  assert.equal(line, '2026-09-23 09:05:07.042 WARN  [proxy] session closed session=abc why="listens to \\"x\\"" count=2');
});

test("errors log a code or name, never their message", () => {
  const refused = new TypeError("fetch failed: token=secret", {
    cause: { code: "ECONNREFUSED" },
  });
  assert.equal(reason(refused), "TypeError:ECONNREFUSED");
  assert.equal(reason(new AppError("needs_auth", "Reconnect", 401)), "needs_auth");
  assert.equal(reason(new Error("upstream said token=secret")), "Error");
  assert.doesNotMatch(formatLine("error", "http", "failed", { error: refused }), /secret/);
});

test("untrusted certificates are told apart from other fetch failures", () => {
  const behindProxy = new TypeError("fetch failed", {
    cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" },
  });
  assert.equal(isUntrustedCertificate(behindProxy), true);
  assert.equal(isUntrustedCertificate(new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } })), false);
  assert.equal(isUntrustedCertificate("SELF_SIGNED_CERT_IN_CHAIN"), false);
});
