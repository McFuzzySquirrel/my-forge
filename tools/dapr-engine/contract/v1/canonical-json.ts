import { createHash } from "node:crypto";
import type { Sha256Digest } from "./types.ts";

export class CanonicalJsonError extends Error {}

/**
 * RFC 8785 (JCS) canonical JSON. Object keys sort by UTF-16 code units and
 * numbers use ECMAScript serialization, which JSON.stringify already provides.
 * Object properties whose value is `undefined` are omitted, as in JSON; every
 * other non-JSON value is rejected rather than coerced.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new CanonicalJsonError("Non-finite numbers are not valid JSON");
      return JSON.stringify(value);
    case "string":
      if (/\p{Cs}/u.test(value)) throw new CanonicalJsonError("Strings must not contain lone surrogates");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value.map((item) => {
          if (item === undefined) throw new CanonicalJsonError("Arrays must not contain undefined");
          return canonicalJson(item);
        }).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new CanonicalJsonError("Only plain objects are valid JSON objects");
      }
      const record = value as Record<string, unknown>;
      const members = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort()
        .map((key) => `${canonicalJson(key)}:${canonicalJson(record[key])}`);
      return `{${members.join(",")}}`;
    }
    default:
      throw new CanonicalJsonError(`Unsupported JSON value of type ${typeof value}`);
  }
}

export function sha256Digest(bytes: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalDigest(value: unknown): Sha256Digest {
  return sha256Digest(Buffer.from(canonicalJson(value), "utf8"));
}
