// Minimal ONVIF client for the TONGVEO — WS-UsernameToken (PasswordDigest)
// auth. Used to recover the camera when its RTSP server wedges (rapid repeated
// ffmpeg connects during measurement runs can do this; VISCA keeps working).
//
// When: the video (RTSP) is dead but VISCA still answers.
//   pnpm exec tsx scripts/onvif-cmd.ts info                 # GetDeviceInformation (auth test, harmless)
//   pnpm exec tsx scripts/onvif-cmd.ts reboot               # SystemReboot
//   ONVIF_USER=admin ONVIF_PASS=admin ...                   # creds (defaults admin/admin)

import { createHash, randomBytes } from "node:crypto";

const IP = process.env.CAMERA_IP ?? "192.168.5.206";
const USER = process.env.ONVIF_USER ?? "admin";
const PASS = process.env.ONVIF_PASS ?? "admin";
const URL = `http://${IP}:8080/onvif/device_service`;

function securityHeader(): string {
  const nonce = randomBytes(16);
  const created = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const digest = createHash("sha1")
    .update(Buffer.concat([nonce, Buffer.from(created), Buffer.from(PASS)]))
    .digest("base64");
  return `<s:Header><Security s:mustUnderstand="1" xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd">` +
    `<UsernameToken><Username>${USER}</Username>` +
    `<Password Type="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest">${digest}</Password>` +
    `<Nonce EncodingType="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary">${nonce.toString("base64")}</Nonce>` +
    `<Created xmlns="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">${created}</Created>` +
    `</UsernameToken></Security></s:Header>`;
}

async function call(action: string): Promise<string> {
  const body = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope">${securityHeader()}` +
    `<s:Body><${action} xmlns="http://www.onvif.org/ver10/device/wsdl"/></s:Body></s:Envelope>`;
  const res = await fetch(URL, {
    method: "POST",
    headers: { "Content-Type": "application/soap+xml" },
    body,
    signal: AbortSignal.timeout(8000),
  });
  return await res.text();
}

const cmd = process.argv[2];
if (cmd === "info") {
  const r = await call("GetDeviceInformation");
  const pick = (tag: string) => r.match(new RegExp(`<tds:${tag}>([^<]*)</tds:${tag}>`))?.[1] ?? "?";
  if (r.includes("Fault")) console.log(`FAULT:\n${r.slice(0, 1200)}`);
  else console.log(`auth OK — ${pick("Manufacturer")} ${pick("Model")} fw ${pick("FirmwareVersion")} serial ${pick("SerialNumber")}`);
} else if (cmd === "reboot") {
  const r = await call("SystemReboot");
  const msg = r.match(/<tds:Message>([^<]*)<\/tds:Message>/)?.[1];
  console.log(msg ? `reboot accepted: ${msg}` : `response:\n${r.slice(0, 1200)}`);
} else {
  console.log("usage: onvif-cmd.ts info|reboot");
}
