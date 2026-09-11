// The login GUID is hex text; SAP consumes the underlying hardware bytes.
export function machineIdentity(deviceId: string): { guid: string; hardwareID: Uint8Array } {
  const guid = deviceId.replace(/[:\s-]/g, '').toUpperCase();
  if (!/^[0-9A-F]{12}$/.test(guid)) {
    throw new Error('Device ID must contain 12 hexadecimal digits');
  }
  return {
    guid,
    hardwareID: Uint8Array.from(guid.match(/../g)!, (byte) => Number.parseInt(byte, 16)),
  };
}
