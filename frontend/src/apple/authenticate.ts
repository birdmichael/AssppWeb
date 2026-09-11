import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, defaultAuthURL } from "./bag";
import { prepareSigner } from "./sap/client";
import i18n from "../i18n";
import type { AppleRequestOptions, AppleResponse } from './request';
import type { Account, Cookie } from '../types';

const MAX_REQUEST_ATTEMPTS = 3;

// Match ipatool's bounded retry of transient authentication responses.
// Keep the body (including attempt and 2FA code) unchanged, but sign each send.
async function sendAuthenticationRequest(
  options: AppleRequestOptions,
  signer: Awaited<ReturnType<typeof prepareSigner>> | null,
): Promise<AppleResponse> {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const headers = { ...options.headers };
    if (signer) {
      headers['X-Apple-ActionSignature'] = await signer.sign(
        new TextEncoder().encode(options.body),
      );
    }
    const response = await appleRequest({ ...options, headers });
    options.cookies = extractAndMergeCookies(
      response.rawHeaders, options.cookies ?? [],
    );
    const transient = response.status === 204 || response.status === 404 ||
      (response.status >= 500 && response.status < 600);
    if (!transient) {
      return response;
    }
    if (attempt === MAX_REQUEST_ATTEMPTS) {
      // Do not let the outer logical-login loop multiply transport retries.
      throw new AuthenticationError(
        `Apple authentication: HTTP ${response.status} after ${MAX_REQUEST_ATTEMPTS} attempts`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error('Authentication retry limit exceeded');
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
  ) {
    super(message);
    this.name = "AuthenticationError";
  }
}

export async function authenticate(
  email: string,
  password: string,
  code?: string,
  existingCookies?: Cookie[],
  deviceId: string = "",
): Promise<Account> {
  let cookies: Cookie[] = existingCookies ? [...existingCookies] : [];
  let storeFront = "";
  let lastError: Error | null = null;

  const defaultAuthEndpoint = new URL(defaultAuthURL);
  defaultAuthEndpoint.searchParams.set("guid", deviceId);
  let requestHost = defaultAuthEndpoint.hostname;
  let requestPath = `${defaultAuthEndpoint.pathname}${defaultAuthEndpoint.search}`;

  const bag = await fetchBag(deviceId);
  const authEndpoint = new URL(bag.authURL);
  authEndpoint.searchParams.set("guid", deviceId);
  requestHost = authEndpoint.hostname;
  requestPath = `${authEndpoint.pathname}${authEndpoint.search}`;

  // When the bag advertises the SAP signing protocol, every request to the
  // auth endpoint must carry X-Apple-ActionSignature over its body bytes.
  // The signer sees only the hardware ID and public Apple assets — never the
  // password — because signing happens here in the browser. It is kept as a
  // singleton between attempts (2FA retries reuse the same session).
  let sapSigner = null as Awaited<ReturnType<typeof prepareSigner>> | null;
  if (bag.sapEndpoints) {
    sapSigner = await prepareSigner(deviceId, bag.sapEndpoints);
  }

  let currentAttempt = 0;
  let redirectAttempt = 0;

  while (currentAttempt < 2 && redirectAttempt <= 3) {
    currentAttempt++;

    try {
      const body: Record<string, string> = {
        appleId: email,
        attempt: String(currentAttempt),
        guid: deviceId,
        password: code ? `${password}${code.replace(/\s/g, '')}` : password,
        rmp: "0",
        why: "signIn",
      };

      const plistBody = buildPlist(body);

      const headers: Record<string, string> = {
        "Content-Type": "application/x-www-form-urlencoded",
      };

      const requestCookies = [...cookies];
      const options = {
        method: "POST",
        host: requestHost,
        path: requestPath,
        headers,
        body: plistBody,
        cookies: requestCookies,
      };
      const response = await sendAuthenticationRequest(options, sapSigner);

      cookies = options.cookies;

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        const parts = storeHeader.split("-");
        if (parts[0]) {
          storeFront = parts[0];
        }
      }

      // Read pod
      const podHeader = response.headers["pod"];
      const pod = podHeader || undefined;

      // Handle redirect. The native /fast auth host can answer with 301 as
      // well as the usual 302, so follow the full set of redirect statuses.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          throw new Error(i18n.t("errors.auth.redirectLocation"));
        }
        const url = new URL(location);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        throw new AuthenticationError(
          i18n.t("errors.auth.emptyBody", { status: response.status }),
        );
      }

      const dict = parsePlist(response.body) as Record<string, any>;

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;

      const accountInfo = dict.accountInfo as Record<string, any>;
      if (!accountInfo) {
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo.address as Record<string, any>;
      if (!address) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      const account: Account = {
        email,
        password,
        appleId: (accountInfo.appleId as string) ?? "",
        store: storeFront,
        firstName: (address.firstName as string) ?? "",
        lastName: (address.lastName as string) ?? "",
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: String(dict.dsPersonId ?? ""),
        cookies,
        deviceIdentifier: deviceId,
        pod,
      };

      return account;
    } catch (e) {
      if (e instanceof AuthenticationError) {
        throw e;
      }
      lastError = e instanceof Error ? e : new Error(String(e));
    }
  }

  throw lastError ?? new Error(i18n.t("errors.auth.unknownReason"));
}
