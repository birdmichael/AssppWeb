import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist } from "../../src/apple/plist";
import { authenticate } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { prepareSigner } from '../../src/apple/sap/client';

vi.mock('../../src/apple/sap/client', () => ({
  prepareSigner: vi.fn(),
}));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", () => ({
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('signs the exact UTF-8 request body including the verification code', async () => {
    const sapEndpoints = {
      certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
      setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
      version: 200,
    };
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      sapEndpoints,
    });
    const sign = vi.fn().mockResolvedValue('signed-body');
    vi.mocked(prepareSigner).mockResolvedValue({ sign } as any);
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200, statusText: 'OK', headers: {}, rawHeaders: [],
      body: buildPlist({
        accountInfo: { appleId: 'test@example.com', address: { firstName: 'Test', lastName: 'User' } },
        passwordToken: 'token', dsPersonId: '123',
      }),
    });
    await authenticate('test@example.com', 'páss&word', '123456', undefined, 'aabbccddeeff');
    const request = vi.mocked(appleRequest).mock.calls[0][0];
    expect(prepareSigner).toHaveBeenCalledWith('aabbccddeeff', sapEndpoints);
    expect(sign).toHaveBeenCalledWith(new TextEncoder().encode(request.body));
    expect(request.headers?.['X-Apple-ActionSignature']).toBe('signed-body');
    expect(request.body).toContain('páss&amp;word123456');
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL:
        "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?foo=1&guid=old-value",
    });
    vi.mocked(appleRequest).mockResolvedValue({
      status: 200,
      statusText: "OK",
      headers: {},
      rawHeaders: [],
      body: buildPlist({
        accountInfo: {
          appleId: "test@example.com",
          address: {
            firstName: "Test",
            lastName: "User",
          },
        },
        passwordToken: "token",
        dsPersonId: "123",
      }),
    });

    await authenticate(
      "test@example.com",
      "password",
      undefined,
      undefined,
      "aabbccddeeff",
    );

    const requestCall = vi.mocked(appleRequest).mock.calls[0][0];
    const endpoint = new URL(`https://${requestCall.host}${requestCall.path}`);

    expect(endpoint.searchParams.get("guid")).toBe("aabbccddeeff");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });
});
