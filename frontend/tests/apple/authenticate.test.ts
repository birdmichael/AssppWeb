import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildPlist, parsePlist } from "../../src/apple/plist";
import { authenticate, AuthenticationError } from "../../src/apple/authenticate";
import { appleRequest } from "../../src/apple/request";
import { fetchBag } from "../../src/apple/bag";
import { prepareSigner } from '../../src/apple/sap/client';

vi.mock('../../src/apple/sap/client', () => ({
  prepareSigner: vi.fn(),
}));

vi.mock("../../src/apple/request", () => ({
  appleRequest: vi.fn(),
}));

vi.mock("../../src/apple/bag", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/apple/bag")>(),
  fetchBag: vi.fn(),
  defaultAuthURL:
    "https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate",
}));

describe("apple/authenticate", () => {
  beforeEach(() => {
    vi.resetAllMocks();
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
    expect(prepareSigner).toHaveBeenCalledWith('AABBCCDDEEFF', sapEndpoints);
    expect(sign).toHaveBeenCalledWith(new TextEncoder().encode(request.body));
    expect(request.headers?.['X-Apple-ActionSignature']).toBe('signed-body');
    expect(request.body).toContain('páss&amp;word123456');
    expect(parsePlist(request.body!).attempt).toBe('1');
    expect(request.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
  });

  function setupSignedLogin() {
    vi.mocked(fetchBag).mockResolvedValue({
      authURL: 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
      sapEndpoints: {
        certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist',
        setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
        version: 200,
      },
    });
    const sign = vi.fn().mockImplementation(async () => `signature-${sign.mock.calls.length}`);
    vi.mocked(prepareSigner).mockResolvedValue({ sign } as any);
    return sign;
  }

  const emptyResponse = (status: number) => ({
    status, statusText: '', headers: {}, rawHeaders: [] as [string, string][], body: '',
  });
  const successResponse = () => ({
    ...emptyResponse(200),
    body: buildPlist({
      accountInfo: { appleId: 'test@example.com', address: { firstName: 'Test', lastName: 'User' } },
      passwordToken: 'token', dsPersonId: '123',
    }),
  });

  it('recovers from 204 and 404 without changing the body or reusing signatures', async () => {
    const sign = setupSignedLogin();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({ ...emptyResponse(204), rawHeaders: [['set-cookie', 'session=abc; Domain=.itunes.apple.com; Path=/']] })
      .mockResolvedValueOnce(emptyResponse(404))
      .mockResolvedValueOnce(successResponse());
    const account = await authenticate('test@example.com', 'password', '123 456', undefined, 'aabbccddeeff');
    expect(account.passwordToken).toBe('token');
    expect(sign).toHaveBeenCalledTimes(3);
    const calls = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(new Set(calls.map((request) => request.body)).size).toBe(1);
    expect(calls.map((request) => request.headers?.['X-Apple-ActionSignature']))
      .toEqual(['signature-1', 'signature-2', 'signature-3']);
    expect(calls[1].cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'session', value: 'abc' })]));
    expect(parsePlist(calls[0].body!).password).toBe('password123456');
    expect(parsePlist(calls[0].body!).attempt).toBe('1');
  });

  it.each([204, 503])('stops after three transient HTTP %i responses', async (status) => {
    setupSignedLogin();
    vi.mocked(appleRequest).mockResolvedValue(emptyResponse(status));
    await expect(authenticate('test@example.com', 'password', '123456', undefined, 'aabbccddeeff'))
      .rejects.toThrow(`HTTP ${status} after 3 attempts`);
    expect(appleRequest).toHaveBeenCalledTimes(3);
  });

  it('does not retry an unsigned/rejected HTTP 403 response', async () => {
    setupSignedLogin();
    vi.mocked(appleRequest).mockResolvedValue(emptyResponse(403));
    await expect(authenticate('test@example.com', 'password', '123456', undefined, 'aabbccddeeff')).rejects.toThrow();
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it('preserves the signed body across pod redirects and transient retries', async () => {
    setupSignedLogin();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({ ...emptyResponse(302), headers: { location: 'https://p18-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate?guid=aabbccddeeff' } })
      .mockResolvedValueOnce(emptyResponse(204))
      .mockResolvedValueOnce(successResponse());
    await authenticate('test@example.com', 'password', '123456', undefined, 'aabbccddeeff');
    const calls = vi.mocked(appleRequest).mock.calls.map(([request]) => request);
    expect(calls.map((request) => request.host)).toEqual(['buy.itunes.apple.com', 'p18-buy.itunes.apple.com', 'p18-buy.itunes.apple.com']);
    expect(new Set(calls.map((request) => request.body)).size).toBe(1);
    expect(parsePlist(calls[2].body!).attempt).toBe('1');
  });

  it("sets guid query exactly once from bag endpoint", async () => {
    setupSignedLogin();
    vi.mocked(fetchBag).mockResolvedValue({
      sapEndpoints: { certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist', setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy', version: 200 },
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

    expect(endpoint.searchParams.get("guid")).toBe("AABBCCDDEEFF");
    expect(endpoint.searchParams.getAll("guid")).toHaveLength(1);
    expect(endpoint.searchParams.get("foo")).toBe("1");
  });
  it('continues the verification challenge on the same pod with its cookies and storefront', async () => {
    setupSignedLogin();
    vi.mocked(appleRequest)
      .mockResolvedValueOnce({ ...emptyResponse(302), headers: { location: 'https://p18-buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate' } })
      .mockResolvedValueOnce({ ...emptyResponse(200),
        headers: { pod: '18', 'x-set-apple-store-front': '143465-1,29' },
        rawHeaders: [['set-cookie', 'challenge=keep-me; Domain=.itunes.apple.com; Path=/']],
        body: buildPlist({ failureType: '', customerMessage: 'MZFinance.BadLogin.Configurator_message' }),
      })
      .mockResolvedValueOnce(successResponse());
    const error = await authenticate('test@example.com', 'password', undefined, undefined, 'aabbccddeeff').catch(e => e);
    expect(error).toBeInstanceOf(AuthenticationError);
    expect(error.codeRequired).toBe(true);
    expect(error.continuation).toBeDefined();
    const account = await authenticate('test@example.com', 'password', '123456', undefined, 'aabbccddeeff', error.continuation);
    expect(fetchBag).toHaveBeenCalledTimes(1);
    const request = vi.mocked(appleRequest).mock.calls[2][0];
    expect(request.host).toBe('p18-buy.itunes.apple.com');
    expect(request.cookies).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'challenge', value: 'keep-me' })]));
    expect(account.store).toBe('143465');
    expect(account.storeFront).toBe('143465-1,29');
    expect(account.pod).toBe('18');
  });

  it('rejects a credential-bearing redirect to an unrelated endpoint before sending', async () => {
    setupSignedLogin();
    vi.mocked(appleRequest).mockResolvedValue({ ...emptyResponse(302), headers: { location: 'https://example.com/steal' } });
    await expect(authenticate('test@example.com', 'password', undefined, undefined, 'aabbccddeeff')).rejects.toThrow('endpoint');
    expect(appleRequest).toHaveBeenCalledTimes(1);
  });

  it.each(['expired', 'account', 'device'])('rejects a %s verification session before any network request', async (reason) => {
    setupSignedLogin();
    const continuation = {
      email: reason === 'account' ? 'other@example.com' : 'test@example.com',
      deviceId: reason === 'device' ? '001122334455' : 'AABBCCDDEEFF',
      expiresAt: reason === 'expired' ? 0 : Date.now() + 60000,
    } as any;
    await expect(authenticate('test@example.com', 'password', '123456', undefined, 'aabbccddeeff', continuation)).rejects.toThrow('session expired or changed');
    expect(appleRequest).not.toHaveBeenCalled();
    expect(fetchBag).not.toHaveBeenCalled();
  });
  it('reports the phase and HTTP sequence without including credentials, cookies or GUID', async () => {
    setupSignedLogin();
    vi.mocked(appleRequest).mockResolvedValue(emptyResponse(404));
    const error = await authenticate('test@example.com', 'secret-password', '123456', undefined, 'aabbccddeeff').catch(e => e);
    expect(error.message).toContain('verification; SAP signed; statuses 404, 404, 404');
    for (const secret of ['test@example.com', 'secret-password', '123456', 'AABBCCDDEEFF', '?guid=']) expect(error.message).not.toContain(secret);
  });
});
