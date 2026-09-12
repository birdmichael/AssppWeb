import { expect, it } from 'vitest';
import { parseApplePlist, readPlistResponse } from '../../src/apple/plistResponse';

const dict = '<dict><key>passwordToken</key><string>private-token</string><key>status</key><integer>0</integer></dict>';
it.each([
  '<plist version="1.0">' + dict + '</plist>',
  dict,
  '<Document>' + dict + '</Document>',
  '<Document><plist version="1.0">' + dict + '</plist></Document>',
])('parses supported Apple XML envelopes', (body) => {
  expect(parseApplePlist(body)).toEqual({ passwordToken: 'private-token', status: 0 });
});
it.each([
  '', '<html><body>error</body></html>', '<html><plist>' + dict + '</plist></html>',
  '<Document>' + dict + dict + '</Document>', '<plist>' + dict + dict + '</plist>',
  '<plist><array/></plist>', '<plist><dict><key>broken</dict></plist>',
])('rejects HTML, malformed XML and ambiguous envelopes', (body) => {
  expect(() => parseApplePlist(body)).toThrow();
});
it('reports phase, HTTP status and endpoint without response content or query values', () => {
  const response = { status: 200, body: '<html>private-token test@example.com</html>' };
  expect(() => readPlistResponse(response, 'authentication', 'p34-buy.itunes.apple.com', '/authenticate?guid=private-guid'))
    .toThrow('Apple authentication: invalid plist response (HTTP 200; p34-buy.itunes.apple.com/authenticate; body=html)');
});
