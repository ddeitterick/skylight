// Minimal ONVIF (Profile S) client for probe scripts: WS-UsernameToken auth,
// service discovery, PTZ ContinuousMove / Stop. Camera-agnostic; address from
// the tracker config, ONVIF_PORT / ONVIF_USER / ONVIF_PASS from the env.
import { createHash, randomBytes } from "node:crypto";
import { cameraTarget } from "./camera-config.js";

const IP = process.env.CAMERA_IP ?? cameraTarget().ip;
const PORT = Number(process.env.ONVIF_PORT ?? 8080);
const USER = process.env.ONVIF_USER ?? "admin";
const PASS = process.env.ONVIF_PASS ?? "admin";
export const DEVICE_URL = `http://${IP}:${PORT}/onvif/device_service`;
export const NS = {
  dev: "http://www.onvif.org/ver10/device/wsdl",
  media: "http://www.onvif.org/ver10/media/wsdl",
  ptz: "http://www.onvif.org/ver20/ptz/wsdl",
};

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

export async function soap(url: string, body: string): Promise<string> {
  const env = `<?xml version="1.0" encoding="UTF-8"?>` +
    `<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tt="http://www.onvif.org/ver10/schema">` +
    `${securityHeader()}<s:Body>${body}</s:Body></s:Envelope>`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/soap+xml" },
    body: env,
    signal: AbortSignal.timeout(8000),
  });
  return await res.text();
}

/** Strip namespaces + collapse whitespace for readable dumps. */
export const clean = (x: string) => x.replace(/<(\/?)[a-zA-Z0-9]+:/g, "<$1").replace(/\s+/g, " ");

export interface Onvif { media: string; ptz: string; profile: string }

export async function connectOnvif(): Promise<Onvif> {
  const r = await soap(DEVICE_URL, `<GetCapabilities xmlns="${NS.dev}"><Category>All</Category></GetCapabilities>`);
  const x = (tag: string) => r.match(new RegExp(`<[a-z]+:${tag}>\\s*<[a-z]+:XAddr>([^<]*)<`))?.[1];
  const media = x("Media") ?? DEVICE_URL;
  const ptz = x("PTZ") ?? DEVICE_URL;
  const p = await soap(media, `<GetProfiles xmlns="${NS.media}"/>`);
  const profile = p.match(/<[a-z]+:Profiles[^>]*token="([^"]+)"/)?.[1];
  if (!profile) throw new Error(`no media profile:\n${clean(p).slice(0, 800)}`);
  return { media, ptz, profile };
}

/** ContinuousMove in the generic velocity space ([-1, 1]); camera-side timeout. */
export async function continuousMove(o: Onvif, x: number, y: number, timeoutSec?: number): Promise<string> {
  return soap(o.ptz,
    `<ContinuousMove xmlns="${NS.ptz}"><ProfileToken>${o.profile}</ProfileToken>` +
    `<Velocity><tt:PanTilt x="${x}" y="${y}"/></Velocity>` +
    (timeoutSec ? `<Timeout>PT${timeoutSec}S</Timeout>` : "") + `</ContinuousMove>`);
}

export async function ptzStop(o: Onvif): Promise<string> {
  return soap(o.ptz, `<Stop xmlns="${NS.ptz}"><ProfileToken>${o.profile}</ProfileToken><PanTilt>true</PanTilt><Zoom>true</Zoom></Stop>`);
}
