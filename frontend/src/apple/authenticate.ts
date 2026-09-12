import { appleRequest } from "./request";
import { buildPlist } from "./plist";
import { parseApplePlist, readPlistResponse } from './plistResponse';
import { extractAndMergeCookies } from "./cookies";
import { fetchBag, validateAuthURL } from "./bag";
import { machineIdentity } from "./machineIdentity";
import { prepareSigner } from "./sap/client";
import i18n from "../i18n";
import type { AppleRequestOptions, AppleResponse } from './request';
import type { BagOutput } from "./bag";
import type { Account, Cookie } from '../types';

const MAX_REQUEST_ATTEMPTS = 3;

// Match ipatool's bounded retry of transient authentication responses.
// Keep the body (including attempt and 2FA code) unchanged, but sign each send.
async function sendAuthenticationRequest(
  options: AppleRequestOptions,
  signer: Awaited<ReturnType<typeof prepareSigner>>,
  phase: string,
): Promise<AppleResponse> {
  const statuses: number[] = [];
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt++) {
    const headers = { ...options.headers };
    headers['X-Apple-ActionSignature'] = await signer.sign(
      new TextEncoder().encode(options.body),
    );
    const response = await appleRequest({ ...options, headers });
    options.cookies = extractAndMergeCookies(
      response.rawHeaders, options.cookies ?? [],
      `https://${options.host}${options.path}`,
    );
    statuses.push(response.status);
    const transient = response.status === 204 || response.status === 404 ||
      (response.status >= 500 && response.status < 600);
    if (transient) {
      // A structured Apple refusal is actionable; do not resend a password
      // merely because its HTTP status is otherwise considered transient.
      try { parseApplePlist(response.body); return response; } catch { /* Non-plist transport response. */ }
    }
    if (!transient) {
      return response;
    }
    if (attempt === MAX_REQUEST_ATTEMPTS) {
      // Do not let the outer logical-login loop multiply transport retries.
      throw new AuthenticationError(
        `Apple authentication: HTTP ${response.status} after ${MAX_REQUEST_ATTEMPTS} attempts (${options.host}${options.path.split("?")[0]}; ${phase}; SAP signed; statuses ${statuses.join(", ")})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw new Error('Authentication retry limit exceeded');
}

// Kept only in the form's memory, never persisted or sent to our backend.
export interface AuthenticationContinuation {
  email: string;
  deviceId: string;
  expiresAt: number;
  cookies: Cookie[];
  endpoint: string;
  storeFront: string;
  pod?: string;
  bag: BagOutput;
}

export class AuthenticationError extends Error {
  constructor(
    message: string,
    public readonly codeRequired: boolean = false,
    public readonly continuation?: AuthenticationContinuation,
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
  continuation?: AuthenticationContinuation,
  previousAccount?: Account,
): Promise<Account> {
  deviceId = machineIdentity(deviceId).guid;
  if (previousAccount && (previousAccount.email !== email || machineIdentity(previousAccount.deviceIdentifier).guid !== deviceId)) {
    throw new AuthenticationError('Reauthentication account or device changed');
  }
  if (continuation && (!code || continuation.email !== email || continuation.deviceId !== deviceId || continuation.expiresAt < Date.now())) {
    throw new AuthenticationError('Verification session expired or changed; start sign-in again');
  }
  let cookies: Cookie[] = [...(continuation?.cookies ?? existingCookies ?? [])];
  let storeFront = continuation?.storeFront ?? previousAccount?.storeFront ?? previousAccount?.store ?? '';
  let pod = continuation?.pod ?? previousAccount?.pod;
  let lastError: Error | null = null;
  const bag = continuation?.bag ?? await fetchBag(deviceId);
  const authEndpoint = validateAuthURL(continuation?.endpoint ?? reauthenticationURL(previousAccount, bag.authURL));
  authEndpoint.searchParams.set('guid', deviceId);
  let requestHost = authEndpoint.hostname;
  let requestPath = authEndpoint.pathname + authEndpoint.search;
  if (!bag.sapEndpoints) throw new AuthenticationError('Apple bag: SAP configuration missing');
  const sapSigner = await prepareSigner(deviceId, bag.sapEndpoints);

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
      const response = await sendAuthenticationRequest(options, sapSigner, code ? 'verification' : 'password');

      cookies = options.cookies;

      // Read store front
      const storeHeader = response.headers["x-set-apple-store-front"];
      if (storeHeader) {
        storeFront = storeHeader;
      }

      // Read pod
      const podHeader = response.headers["pod"];
      pod = podHeader || pod;

      // Follow store pod redirects without changing the signed request body.
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers["location"];
        if (!location) {
          // A missing Location cannot be repaired by inventing a pod URL.
          // Stop here instead of silently posting a second password attempt.
          const bodyKind = !response.body.trim() ? 'empty' : response.body.includes('<plist') ? 'plist' : 'other';
          throw new AuthenticationError(
            i18n.t("errors.auth.redirectLocation") +
            ` (HTTP ${response.status}; ${requestHost}${requestPath.split('?')[0]}; Location=missing; body=${bodyKind}; freshSession=${!existingCookies?.length})`,
          );
        }
        let url: URL;
        try {
          url = validateAuthURL(new URL(location, 'https://' + requestHost + requestPath).href);
        } catch {
          throw new AuthenticationError('Unsupported Apple authentication redirect endpoint');
        }
        url.searchParams.set('guid', deviceId);
        requestHost = url.hostname;
        requestPath = url.pathname + url.search;
        currentAttempt--;
        redirectAttempt++;
        continue;
      }

      // Handle non-plist responses (e.g. 403 with empty body)
      if (!response.body.trim()) {
        throw new AuthenticationError(
          i18n.t("errors.auth.emptyBody", { status: response.status }) + ` (${requestHost}${requestPath.split("?")[0]}; ${code ? "verification" : "password"}; SAP signed)`,
        );
      }

      let dict: Record<string, any>;
      try {
        dict = readPlistResponse(response, 'authentication', requestHost, requestPath);
      } catch (error) {
        throw new AuthenticationError((error as Error).message);
      }

      // Check for 2FA requirement
      if (
        dict.failureType === "" &&
        !code &&
        dict.customerMessage === "MZFinance.BadLogin.Configurator_message"
      ) {
        throw new AuthenticationError(
          i18n.t("errors.auth.requiresVerification"),
          true,
          { email, deviceId, cookies, storeFront, pod, bag,
            endpoint: 'https://' + requestHost + requestPath,
            expiresAt: Date.now() + 10 * 60 * 1000 },
        );
      }

      const failureMessage =
        (dict.dialog as Record<string, any>)?.explanation ??
        dict.customerMessage;
      if (dict.failureType) {
        throw new AuthenticationError(failureMessage || 'Apple authentication was rejected');
      }

      const dsid = String(dict.dsPersonId ?? (previousAccount ? dict['download-queue-info']?.dsid : undefined) ?? '');
      if (previousAccount && dsid && dsid !== previousAccount.directoryServicesIdentifier) {
        throw new AuthenticationError('Reauthentication returned a different account');
      }
      const accountInfo = dict.accountInfo as Record<string, any> | undefined;
      if (!accountInfo && !previousAccount) {
        throw new Error(
          failureMessage ?? i18n.t("errors.auth.missingAccountInfo"),
        );
      }

      const address = accountInfo?.address as Record<string, any> | undefined;
      if (!address && !previousAccount) {
        throw new Error(failureMessage ?? i18n.t("errors.auth.missingAddress"));
      }

      if (response.status !== 200 || !dict.passwordToken || !dsid || dict.failureType) {
        throw new AuthenticationError(failureMessage ?? 'Apple authentication response has no valid session token');
      }

      const successfulEndpoint = validateAuthURL('https://' + requestHost + requestPath);
      successfulEndpoint.searchParams.delete('guid');
      const account: Account = {
        email,
        password,
        appleId: (accountInfo?.appleId as string) ?? previousAccount?.appleId ?? '',
        store: storeFront.split("-")[0],
        storeFront,
        firstName: (address?.firstName as string) ?? previousAccount?.firstName ?? '',
        lastName: (address?.lastName as string) ?? previousAccount?.lastName ?? '',
        passwordToken: (dict.passwordToken as string) ?? "",
        directoryServicesIdentifier: dsid,
        cookies,
        deviceIdentifier: deviceId,
        pod,
        authEndpoint: successfulEndpoint.href,
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

function reauthenticationURL(account: Account | undefined, bagURL: string): string {
  if (!account) return bagURL;
  // Prefer Apple's last successful redirect, including its routing query.
  if (account.authEndpoint) {
    const saved = validateAuthURL(account.authEndpoint);
    if (saved.hostname !== 'buy.itunes.apple.com') return saved.href;
  }
  // Existing accounts predate authEndpoint storage. Their pod was returned by
  // successful authentication, so reuse that assignment instead of a default.
  if (account.pod && /^\d{1,3}$/.test(account.pod)) {
    return `https://p${account.pod}-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate`;
  }
  return bagURL;
}
