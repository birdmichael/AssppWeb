import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import { storeDiagnostic, storeRedirect } from "./storeResponse";
import { purchaseAPIHost } from "./config";
import i18n from "../i18n";
import type { Account, Software } from "../types";

export class PurchaseError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "PurchaseError";
  }
}

export async function purchaseApp(
  account: Account,
  app: Software,
): Promise<{ updatedCookies: typeof account.cookies }> {
  if ((app.price ?? 0) > 0) {
    throw new PurchaseError(i18n.t("errors.purchase.paidNotSupported"));
  }

  try {
    return await purchaseWithParams(account, app, "STDQ");
  } catch (e) {
    // Rely on error code instead of translated message string to prevent matching issues
    if (e instanceof PurchaseError && e.code === "2059") {
      return await purchaseWithParams(account, app, "GAME");
    }
    throw e;
  }
}

async function purchaseWithParams(
  account: Account,
  app: Software,
  pricingParameters: string,
): Promise<{ updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;
  let host = purchaseAPIHost(account.pod);
  let path = "/WebObjects/MZFinance.woa/wa/buyProduct";

  const payload: Record<string, any> = {
    appExtVrsId: "0",
    hasAskedToFulfillPreorder: "true",
    buyWithoutAuthorization: "true",
    hasDoneAgeCheck: "true",
    guid: deviceId,
    needDiv: "0",
    origPage: `Software-${app.id}`,
    origPageLocation: "Buy",
    price: "0",
    pricingParameters,
    productType: "C",
    salableAdamId: app.id,
  };

  const plistBody = buildPlist(payload);

  const headers: Record<string, string> = {
    "Content-Type": "application/x-apple-plist",
    "iCloud-DSID": account.directoryServicesIdentifier,
    "X-Dsid": account.directoryServicesIdentifier,
    "X-Apple-Store-Front": account.storeFront || `${account.store}-1`,
    "X-Token": account.passwordToken,
  };

  let updatedCookies = [...account.cookies];
  let response;
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await appleRequest({ method: 'POST', host, path, headers, body: plistBody, cookies: updatedCookies });
    updatedCookies = extractAndMergeCookies(response.rawHeaders, updatedCookies, 'https://' + host + path);
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    if (!response.headers.location || redirects === 3) {
      throw new PurchaseError('Apple purchase redirect failed (' + storeDiagnostic(response, host, path) + ')');
    }
    const url = storeRedirect(response.headers.location, host, path, ['/WebObjects/MZFinance.woa/wa/buyProduct']);
    host = url.hostname;
    path = url.pathname + url.search;
  }
  if (!response) throw new PurchaseError('No Apple purchase response');
  let dict: Record<string, any>;
  try { dict = parsePlist(response.body); } catch {
    throw new PurchaseError('Invalid Apple purchase response (' + storeDiagnostic(response, host, path) + ')');
  }
  const fail = (message: string, code?: string) => new PurchaseError(
    message + ' (' + storeDiagnostic(response!, host, path, dict) + ')', code,
  );

  // Apple explicitly reports an existing license with this code.
  if (String(dict.failureType) === '5002') return { updatedCookies };

  if (dict.failureType) {
    const failureType = String(dict.failureType);
    const customerMessage = dict.customerMessage as string | undefined;
    switch (failureType) {
      case "2059":
        throw fail(i18n.t("errors.purchase.unavailable"), "2059");
      case "2034":
      case "2042":
      case "1008":
        throw fail(
          i18n.t("errors.purchase.passwordExpired"),
          failureType,
        );
      default: {
        if (customerMessage === "Your password has changed.") {
          throw fail(
            i18n.t("errors.purchase.passwordExpired"),
            failureType,
          );
        }
        if (customerMessage === "Subscription Required") {
          throw fail(
            i18n.t("errors.purchase.subscriptionRequired"),
            failureType,
          );
        }
        // Check for terms page action
        const action = dict.action as Record<string, any> | undefined;
        if (action) {
          const actionUrl = (action.url || action.URL) as string | undefined;
          if (actionUrl && actionUrl.endsWith("termsPage")) {
            throw fail(
              i18n.t("errors.purchase.termsRequired", { url: actionUrl }),
              failureType,
            );
          }
        }

        // Handle unknown error specific fallback mappings
        let msg = customerMessage;
        if (
          msg === "An unknown error has occurred" ||
          msg === "An unknown error has occurred."
        ) {
          msg = i18n.t("errors.purchase.unknownError");
        }

        throw fail(
          msg ?? i18n.t("errors.purchase.failed", { failureType }),
          failureType,
        );
      }
    }
  }

  const jingleDocType = dict.jingleDocType as string | undefined;
  const status = dict.status as number | undefined;

  if (response.status !== 200 || jingleDocType !== "purchaseSuccess" || status !== 0) {
    throw fail(i18n.t("errors.purchase.failedGeneral"));
  }

  return { updatedCookies };
}
