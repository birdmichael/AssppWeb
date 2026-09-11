import { describe, expect, it } from 'vitest';
import { machineIdentity } from '../../src/apple/machineIdentity';

describe('machineIdentity', () => {
  it('uses the same raw MAC bytes and uppercase GUID as ipatool', () => {
    const identity = machineIdentity('aa:bb:01:02:00:ff');
    expect(identity.guid).toBe('AABB010200FF');
    expect([...identity.hardwareID]).toEqual([170, 187, 1, 2, 0, 255]);
  });
  it.each(['', 'xyzxyzxyzxyz', 'AABB', 'AABBCCDDEEFF00'])('rejects invalid identity %s', (value) => {
    expect(() => machineIdentity(value)).toThrow('Device ID');
  });
});
