import { beforeEach, expect, it, vi } from 'vitest';
import { appleRequest } from '../../src/apple/request';
import { fetchSetupCertificate, exchangeSetupBuffer } from '../../src/apple/sap/protocol';
import type { SapEndpoints } from '../../src/apple/sap/types';

vi.mock('../../src/apple/request', () => ({ appleRequest: vi.fn() }));
const endpoints: SapEndpoints = {
  certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist?private=query',
  setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy?private=query',
  version: 200,
};
const response = (body: string) => ({ status: 200, statusText: '', headers: {}, rawHeaders: [] as [string, string][], body });
beforeEach(() => vi.resetAllMocks());
it('accepts a binary certificate inside the Apple Document wrapper', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response('<Document><dict><key>sign-sap-setup-cert</key><data>AQID</data></dict></Document>'));
  await expect(fetchSetupCertificate(endpoints)).resolves.toEqual(new Uint8Array([1, 2, 3]));
});
it('distinguishes certificate HTML failures from authentication failures', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response('<html>private certificate response</html>'));
  await expect(fetchSetupCertificate(endpoints)).rejects.toThrow('Apple SAP certificate: invalid plist response (HTTP 200; s.mzstatic.com/sap/setupCert.plist; body=html)');
});
it('distinguishes setup HTML failures without including the exchange body or query', async () => {
  vi.mocked(appleRequest).mockResolvedValue(response('<html>private exchange response</html>'));
  await expect(exchangeSetupBuffer(endpoints, new Uint8Array([1, 2, 3]))).rejects.toThrow('Apple SAP setup: invalid plist response (HTTP 200; fpinit.itunes.apple.com/v1/signSapSetup/legacy; body=html)');
});
