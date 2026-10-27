/**
 * One-line, timestamped daemon logs, greppable by scope and key (the format
 * mergeatron uses):
 *
 *   2026-10-27 10:03:12.345 INFO  [proxy] session closed session=3f2a... profile=linear/work reason=idle
 *
 * `logger(scope)` returns plain functions: the daemon is Promise-based, so
 * there is no Effect logger to route through. Timestamps are local time.
 * Values containing spaces, quotes or `=` are JSON-quoted; undefined fields
 * are dropped. Errors print `reason(error)`, never their message, so upstream
 * error text stays out of the logs. Never pass tokens, headers, bodies or
 * authorization URLs as fields.
 */
import { AppError } from "./model.js";

type Level = "info" | "warn" | "error";
export type LogFields = Record<string, unknown>;

const WRITERS: Record<Level, (line: string) => void> = {
  info: (line) => console.log(line),
  warn: (line) => console.warn(line),
  error: (line) => console.error(line),
};

/** Logger bound to a scope such as `http`, `proxy`, `toolkit` or `oauth`. */
export function logger(scope: string) {
  const write = (level: Level) => (message: string, fields?: LogFields) =>
    WRITERS[level](formatLine(level, scope, message, fields));
  return { info: write("info"), warn: write("warn"), error: write("error") };
}

export function formatLine(
  level: Level,
  scope: string,
  message: string,
  fields: LogFields = {},
  date = new Date(),
): string {
  const pairs = Object.entries(fields).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${formatValue(value)}`],
  );
  return [
    timestamp(date),
    level.toUpperCase().padEnd(5),
    `[${scope}]`,
    message,
    ...pairs,
  ].join(" ");
}

/**
 * Why something failed, without its message: an AppError's code, else the
 * error's name plus any errno or protocol code (`TypeError:ECONNREFUSED`,
 * `McpError:-32001`).
 */
export function reason(error: unknown): string {
  if (error instanceof AppError) return error.code;
  if (!(error instanceof Error)) return "unknown";
  const code = codeOf(error) ?? codeOf(error.cause);
  return code === undefined ? error.name : `${error.name}:${code}`;
}

const untrustedCertificateCodes = new Set([
  "SELF_SIGNED_CERT_IN_CHAIN",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

/**
 * Whether TLS verification failed because the upstream's certificate chain
 * ends in a CA Node does not trust, as behind a TLS-inspecting proxy.
 */
export function isUntrustedCertificate(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = codeOf(error) ?? codeOf(error.cause);
  return typeof code === "string" && untrustedCertificateCodes.has(code);
}

function codeOf(value: unknown) {
  if (typeof value !== "object" || value === null || !("code" in value))
    return undefined;
  return typeof value.code === "string" || typeof value.code === "number"
    ? value.code
    : undefined;
}

function formatValue(value: unknown): string {
  const text =
    value instanceof Error
      ? reason(value)
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return text === "" || /[\s"=]/.test(text) ? JSON.stringify(text) : text;
}

function timestamp(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}
