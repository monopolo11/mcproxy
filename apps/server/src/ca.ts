import { readFileSync } from "node:fs";
import { getCACertificates, setDefaultCACertificates } from "node:tls";

/**
 * Trusts the CA bundle in NODE_EXTRA_CA_CERTS when Node did not already read it
 * at startup, as when it comes from `.env` (loaded by `--env-file`, after Node
 * reads that variable). Needed behind TLS-inspecting proxies.
 */
export function trustExtraCertificates(
  path = process.env.NODE_EXTRA_CA_CERTS,
) {
  if (!path) return;
  setDefaultCACertificates([
    ...getCACertificates("default"),
    readFileSync(path, "utf8"),
  ]);
}
