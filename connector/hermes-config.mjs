import { readFile } from "node:fs/promises";
import { homedir } from "node:os";

// Hermes auto-denies an unanswered approval after `approvals.timeout` seconds, 300 unless set.
const DEFAULT_APPROVAL_TIMEOUT = 300;

export const defaultHermesConfigPath = () => `${process.env.HERMES_HOME ?? `${homedir()}/.hermes`}/config.yaml`;

// One YAML scalar as PyYAML writes it: plain (a trailing comment dropped), 'single' or "double" quoted.
function scalar(raw) {
  const value = raw.trim();
  if (value.startsWith("'")) return value.slice(1, value.lastIndexOf("'")).replaceAll("''", "'");
  if (value.startsWith('"')) { try { return JSON.parse(value.slice(0, value.lastIndexOf('"') + 1)); } catch { return value.slice(1, -1); } }
  return value.replace(/\s+#.*$/u, "");
}

/**
 * What a phone needs from Hermes's config.yaml, read without a YAML library: the two keys Apollo
 * shows, in the block style Hermes saves (`approvals:` with an indented `timeout:`, and a
 * top-level `command_allowlist:` list, block or `[]`). A missing file reads as Hermes's defaults.
 */
export async function readApprovalConfig(path = defaultHermesConfigPath()) {
  let text;
  try { text = await readFile(path, "utf8"); }
  catch (cause) { if (cause.code === "ENOENT") text = ""; else throw cause; }
  const lines = text.split(/\r?\n/u);
  let timeout = DEFAULT_APPROVAL_TIMEOUT;
  const allowlist = [];
  for (let i = 0; i < lines.length; i++) {
    const key = /^([A-Za-z_]+):(.*)$/u.exec(lines[i]);
    if (!key) continue;
    const rest = key[2].replace(/\s+#.*$/u, "").trim();
    // A key's block is every following line that is indented, a list item, blank or a comment.
    const block = [];
    for (let j = i + 1; j < lines.length && /^(\s|-|#|$)/u.test(lines[j]); j++) block.push(lines[j]);
    if (key[1] === "approvals") {
      const set = block.map((line) => /^\s+timeout:\s*(\d+(?:\.\d+)?)\s*(?:#.*)?$/u.exec(line)).find(Boolean);
      if (set) timeout = Number(set[1]);
    }
    if (key[1] === "command_allowlist") {
      if (rest.startsWith("[")) allowlist.push(...rest.slice(1, rest.lastIndexOf("]")).split(",").map(scalar).filter(Boolean));
      else for (const line of block) { const item = /^\s*- (.+)$/u.exec(line); if (item) allowlist.push(scalar(item[1])); }
    }
  }
  return { timeout_seconds: timeout, command_allowlist: allowlist };
}
