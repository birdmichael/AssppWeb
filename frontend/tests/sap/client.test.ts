import { afterEach, expect, it, vi } from 'vitest';
import { prepareSigner } from '../../src/apple/sap/client';
import { SapSigner } from '../../src/apple/sap/signer';
vi.mock('../../src/apple/sap/signer', () => ({ SapSigner: { create: vi.fn().mockResolvedValue({ sign: vi.fn() }) } }));
vi.mock('../../src/apple/sap/assets', () => ({ loadSapAssets: vi.fn().mockResolvedValue({ commerceKit: new Uint8Array(), commerceCore: new Uint8Array(), coreFP: new Uint8Array(), coreFPICXS: new Uint8Array() }) }));
vi.mock('../../src/apple/sap/protocol', () => ({ exchangeSetupBuffer: vi.fn(), fetchSetupCertificate: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
it('passes decoded hardware bytes into the real signer manager, including cached preparation', async () => {
  class FakeWorker {
    onmessage?: (event: any) => void;
    postMessage(message: any) { queueMicrotask(() => this.onmessage?.({ data: { type: 'result', id: message.id } })); }
  }
  vi.stubGlobal('Worker', FakeWorker);
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: async () => new ArrayBuffer(0) }));
  const endpoints = { setupURL: 'https://fpinit.itunes.apple.com/v1/signSapSetup/legacy', certificateURL: 'https://s.mzstatic.com/sap/setupCert.plist', version: 200 };
  const first = await prepareSigner('aa:bb:01:02:00:ff', endpoints);
  expect([...vi.mocked(SapSigner.create).mock.calls[0][0].hardwareID]).toEqual([170, 187, 1, 2, 0, 255]);
  expect(await prepareSigner('AABB010200FF', endpoints)).toBe(first);
  expect(SapSigner.create).toHaveBeenCalledTimes(1);
});
