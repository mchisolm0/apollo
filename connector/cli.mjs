#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import qrcode from "qrcode-terminal";

import { createConnectorServer, configureTailscaleServe, tailscaleStatus } from "./index.mjs";

const args = process.argv.slice(2);
const command = args.shift() ?? "help";
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  const value = args[index + 1];
  args.splice(index, value?.startsWith("-") ? 1 : 2);
  return value?.startsWith("-") ? true : value;
};
const has = (name) => args.includes(name);
const numberFlag = (name, fallback) => Number(flag(name, fallback));
const baseUrl = (host, port) => `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`;

async function localAdminSecret(explicit) {
  if (typeof explicit === "string" && explicit) return explicit;
  const path = process.env.APOLLO_ADMIN_SECRET_FILE ?? `${homedir()}/.config/apollo/admin-secret`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (!existing) throw new Error(`Admin secret file is empty: ${path}`);
    await chmod(path, 0o600);
    return existing;
  } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    const created = randomBytes(32).toString("base64url");
    await writeFile(path, `${created}\n`, { mode: 0o600, flag: "wx" });
    return created;
  }
}

function usage() {
  console.log(`Apollo connector\n\n  apollo-connector serve [--port 8643]\n  apollo-connector pair [--tailscale] [--name "Matthew's phone"]\n  apollo-connector devices\n  apollo-connector revoke <device-id>`);
}

async function adminRequest(method, path, body, options) {
  const response = await fetch(`${options.base}${path}`, { method, headers: { "content-type": "application/json", "x-apollo-admin-secret": options.secret }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message ?? `connector returned ${response.status}`);
  return data;
}

if (command === "help" || command === "--help" || command === "-h") { usage(); process.exit(0); }

try {
  const port = numberFlag("--port", Number(process.env.APOLLO_CONNECTOR_PORT ?? 8643));
  const host = flag("--host", process.env.APOLLO_CONNECTOR_HOST ?? "127.0.0.1");
  const secret = await localAdminSecret(flag("--admin-secret", process.env.APOLLO_ADMIN_SECRET));
  const options = { base: baseUrl(host, port), secret };

  if (command === "serve") {
    const connector = createConnectorServer({ host, port, adminSecret: secret });
    const address = await connector.start();
    console.log(`Apollo connector listening on http://${address.address}:${address.port}`);
    console.log("Admin API is loopback-only. Press Ctrl-C to stop.");
    const stop = async () => { await connector.close(); process.exit(0); };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  } else if (command === "pair") {
    const tailscale = has("--tailscale");
    const name = flag("--name", "Apollo mobile");
    let publicBase = flag("--public-base-url", null);
    if (tailscale) {
      const { dnsName } = await tailscaleStatus();
      const servePort = numberFlag("--tailscale-serve-port", 8443);
      await configureTailscaleServe(port, servePort);
      publicBase = `https://${dnsName}${servePort === 443 ? "" : `:${servePort}`}`;
    }
    const data = await adminRequest("POST", "/admin/pair", { device_name: name, ttl_seconds: numberFlag("--ttl", 300), public_base_url: publicBase }, options);
    const pairingUrl = data.pairing_url ?? `apollo://pair?host=${encodeURIComponent(publicBase ?? options.base)}#token=${data.pairing_token}`;
    qrcode.generate(pairingUrl, { small: true }, (code) => console.log(`\n${code}`));
    console.log(`Pairing URL (expires ${data.expires_at}):\n${pairingUrl}`);
    console.log(`\nToken:\n${data.pairing_token}`);
  } else if (command === "devices") {
    console.log(JSON.stringify(await adminRequest("GET", "/admin/devices", undefined, options), null, 2));
  } else if (command === "revoke") {
    const id = args[0];
    if (!id) throw new Error("device id is required");
    console.log(JSON.stringify(await adminRequest("POST", `/admin/devices/${encodeURIComponent(id)}/revoke`, {}, options), null, 2));
  } else usage();
} catch (cause) {
  console.error(`apollo-connector: ${cause.message}`);
  process.exitCode = 1;
}
