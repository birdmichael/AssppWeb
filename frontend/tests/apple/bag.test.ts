import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildPlist } from '../../src/apple/plist';
import { fetchBag, validateAuthURL } from '../../src/apple/bag';

const config = {
  authenticateAccount: 'https://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
  'sign-sap-setup': 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy',
  'sign-sap-setup-cert': 'https://s.mzstatic.com/sap/setupCert.plist',
  'sign-sap-version': 200,
};
const mockBag = (dict: object) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, text: async () => buildPlist(dict) }));

describe('apple/bag', () => {
  afterEach(() => vi.unstubAllGlobals());
  it.each([config, { urlBag: config }])('reads complete signed configuration at either supported location', async (dict) => {
    mockBag(dict);
    expect(await fetchBag('AABBCCDDEEFF')).toEqual({ authURL: config.authenticateAccount, sapEndpoints: {
      setupURL: config['sign-sap-setup'], certificateURL: config['sign-sap-setup-cert'], version: 200,
    } });
  });
  it('fails explicitly when the bag proxy fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502 }));
    await expect(fetchBag('AABBCCDDEEFF')).rejects.toThrow('Apple bag: HTTP 502');
  });
  it('does not silently continue unsigned when SAP data is missing', async () => {
    mockBag({ authenticateAccount: config.authenticateAccount });
    await expect(fetchBag('AABBCCDDEEFF')).rejects.toThrow('SAP configuration');
  });
  it('rejects missing authentication URL', async () => {
    mockBag({});
    await expect(fetchBag('AABBCCDDEEFF')).rejects.toThrow('endpoint missing');
  });
  it.each([
    'https://auth.itunes.apple.com/auth/v1/native/fast/',
    'http://buy.itunes.apple.com/WebObjects/MZFinance.woa/wa/authenticate',
    'https://buy.itunes.apple.com.evil.example/WebObjects/MZFinance.woa/wa/authenticate',
    'https://buy.itunes.apple.com/other-path',
  ])('rejects incompatible authentication endpoint %s', (url) => {
    expect(() => validateAuthURL(url)).toThrow('endpoint');
  });
  it('accepts a store pod endpoint', () => {
    expect(validateAuthURL(config.authenticateAccount.replace('buy.', 'p18-buy.')).hostname).toBe('p18-buy.itunes.apple.com');
  });
});
