import { appleRequest } from "./request";
import { buildPlist, parsePlist } from "./plist";
import { extractAndMergeCookies } from "./cookies";
import {
  RETRYABLE_FAILURE_TYPE,
  redownloadEndpoint,
  volumeStoreEndpoint,
} from "./config";
import { storeDiagnostic, storeRedirect } from "./storeResponse";
import i18n from "../i18n";
import type { Account, Software, DownloadOutput, Sinf } from "../types";

export class DownloadError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "DownloadError";
  }
}

export async function getDownloadInfo(
  account: Account,
  app: Software,
  externalVersionId?: string,
): Promise<{ output: DownloadOutput; updatedCookies: typeof account.cookies }> {
  const deviceId = account.deviceIdentifier;

  let endpoint = volumeStoreEndpoint(account.pod, deviceId);
  let requestHost = endpoint.host;
  let requestPath = endpoint.path;
  let triedRedownload = false;
  let cookies = [...account.cookies];
  let redirectAttempt = 0;

  while (redirectAttempt <= 3) {
    const payload: Record<string, any> = {
      creditDisplay: "",
      serialNumber: "0",
      guid: deviceId,
      salableAdamId: app.id,
    };

    if (externalVersionId) {
      payload[endpoint.externalVersionIdKey] = externalVersionId;
    }

    const plistBody = buildPlist(payload);

    const headers: Record<string, string> = {
      "Content-Type": "application/x-apple-plist",
      "iCloud-DSID": account.directoryServicesIdentifier,
      "X-Dsid": account.directoryServicesIdentifier,
    };

    const response = await appleRequest({
      method: "POST",
      host: requestHost,
      path: requestPath,
      headers,
      body: plistBody,
      cookies,
    });

    cookies = extractAndMergeCookies(response.rawHeaders, cookies, `https://${requestHost}${requestPath}`);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers["location"];
      if (!location) {
        throw new DownloadError(i18n.t("errors.download.redirectLocation"));
      }
      const url = storeRedirect(location, requestHost, requestPath, [
        '/WebObjects/MZFinance.woa/wa/volumeStoreDownloadProduct', '/r/redownload',
      ]);
      requestHost = url.hostname;
      requestPath = url.pathname + url.search;
      redirectAttempt++;
      continue;
    }

    let dict: Record<string, any>;
    try { dict = parsePlist(response.body); } catch {
      throw new DownloadError('Invalid Apple download response (' + storeDiagnostic(response, requestHost, requestPath) + ')');
    }
    const fail = (message: string, code?: string) => new DownloadError(
      message + ' (' + storeDiagnostic(response, requestHost, requestPath, dict) + ')', code,
    );

    if (dict.failureType) {
      const failureType = String(dict.failureType);

      // volumeStore intermittently returns 5002; retry once via the
      // redownload dispatch endpoint, which serves the same payload.
      if (failureType === RETRYABLE_FAILURE_TYPE && !triedRedownload) {
        triedRedownload = true;
        endpoint = redownloadEndpoint(deviceId);
        requestHost = endpoint.host;
        requestPath = endpoint.path;
        redirectAttempt = 0;
        continue;
      }

      const customerMessage = dict.customerMessage as string | undefined;
      switch (failureType) {
        case "2034":
        case "2042":
        case "1008":
          throw fail(
            i18n.t("errors.download.passwordExpired"),
            failureType,
          );
        case "9610":
          throw fail(
            i18n.t("errors.download.licenseRequired"),
            "9610",
          );
        default: {
          if (customerMessage === "Your password has changed.") {
            throw fail(
              i18n.t("errors.download.passwordExpired"),
              failureType,
            );
          }
          // If apple provides a specific string, we fall back to it, otherwise we use the localized default.
          throw fail(
            customerMessage ??
              i18n.t("errors.download.downloadFailed", { failureType }),
            failureType,
          );
        }
      }
    }

    const songList = dict.songList as Record<string, any>[] | undefined;
    if (response.status !== 200 || !Array.isArray(songList) || songList.length === 0) {
      const message = dict.customerMessage || dict.dialog?.explanation;
      throw fail(typeof message === 'string' ? message : i18n.t("errors.download.noItems"));
    }

    const item = songList[0];
    const url = item.URL as string;
    if (!url) {
      throw fail(i18n.t("errors.download.missingUrl"));
    }

    const metadata = item.metadata as Record<string, any>;
    if (!metadata) {
      throw fail(i18n.t("errors.download.missingMetadata"));
    }

    const version = metadata.bundleShortVersionString as string;
    const bundleVersion = metadata.bundleVersion as string;
    if (!version || !bundleVersion) {
      throw fail(i18n.t("errors.download.missingVersion"));
    }

    const sinfs: Sinf[] = [];
    const sinfData = item.sinfs as Record<string, any>[] | undefined;
    if (sinfData) {
      for (const sinfItem of sinfData) {
        const id = sinfItem.id as number;
        const sinf = sinfItem.sinf;
        if (id !== undefined && sinf) {
          let sinfBase64: string;
          if (sinf instanceof Uint8Array || sinf instanceof ArrayBuffer) {
            const bytes =
              sinf instanceof ArrayBuffer ? new Uint8Array(sinf) : sinf;
            sinfBase64 = base64FromBytes(bytes);
          } else if (typeof sinf === "string") {
            sinfBase64 = sinf;
          } else {
            throw fail(i18n.t("errors.download.invalidSinf"));
          }
          sinfs.push({ id, sinf: sinfBase64 });
        }
      }
    }

    if (sinfs.length === 0) {
      throw fail(i18n.t("errors.download.noSinf"));
    }

    // Build iTunesMetadata plist
    const metadataDict: Record<string, any> = { ...metadata };
    metadataDict["apple-id"] = account.email;
    metadataDict["userName"] = account.email;
    delete metadataDict.passwordToken;
    delete metadataDict["passwordToken"];
    const iTunesMetadata = base64FromString(buildPlist(metadataDict));

    return {
      output: {
        downloadURL: url,
        sinfs,
        bundleShortVersionString: version,
        bundleVersion,
        iTunesMetadata,
      },
      updatedCookies: cookies,
    };
  }

  throw new DownloadError(i18n.t("errors.download.tooManyRedirects"));
}

function base64FromString(value: string): string {
  const bytes = new TextEncoder().encode(value);
  return base64FromBytes(bytes);
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}
