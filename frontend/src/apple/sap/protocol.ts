// SAP setup protocol: fetches the Apple certificate and performs the key
// exchange. Both endpoints are public Apple services (no credentials);
// requests travel through the wisp tunnel via appleRequest like every other
// Apple API call. Ported from ipatool's internal/sap/protocol.go.

import { appleRequest } from "../request";
import { buildPlist } from "../plist";
import { readPlistResponse } from '../plistResponse';
import type { AppleResponse } from '../request';
import type { SapEndpoints } from "./types";

const SETUP_CERTIFICATE_KEY = "sign-sap-setup-cert";
const SETUP_BUFFER_KEY = "sign-sap-setup-buffer";
const MAX_SETUP_BODY = 1 << 20;

function plistBytes(response: AppleResponse, key: string, phase: string, endpoint: string): Uint8Array {
  const url = new URL(endpoint);
  const values = readPlistResponse(response, phase, url.hostname, url.pathname);
  const value = values[key];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new Error(`Apple plist is missing ${key}`);
  }
  return value;
}

export async function fetchSetupCertificate(
  endpoints: SapEndpoints,
): Promise<Uint8Array> {
  const response = await appleRequest({
    method: "GET",
    host: new URL(endpoints.certificateURL).hostname,
    path: `${new URL(endpoints.certificateURL).pathname}${new URL(endpoints.certificateURL).search}`,
  });
  if (response.status !== 200) {
    throw new Error(`SAP certificate request returned ${response.status}`);
  }
  if (response.body.length > MAX_SETUP_BODY) {
    throw new Error("SAP certificate response exceeds 1 MiB");
  }
  return plistBytes(response, SETUP_CERTIFICATE_KEY, 'SAP certificate', endpoints.certificateURL);
}

export async function exchangeSetupBuffer(
  endpoints: SapEndpoints,
  input: Uint8Array,
): Promise<Uint8Array> {
  const envelope = buildPlist({ [SETUP_BUFFER_KEY]: input });
  const url = new URL(endpoints.setupURL);
  const response = await appleRequest({
    method: "POST",
    host: url.hostname,
    path: `${url.pathname}${url.search}`,
    headers: {
      "Content-Type": "application/x-plist",
    },
    body: envelope,
  });
  if (response.status !== 200) {
    throw new Error(`SAP setup exchange returned ${response.status}`);
  }
  if (response.body.length > MAX_SETUP_BODY) {
    throw new Error("SAP setup response exceeds 1 MiB");
  }
  return plistBytes(response, SETUP_BUFFER_KEY, 'SAP setup', endpoints.setupURL);
}
