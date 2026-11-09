import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { verifyLocally } from '../server/webhooks';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

function signed(body: string, opts: { certUrl?: string } = {}) {
  const headers: Record<string, string> = {
    'paypal-auth-algo': 'SHA256withRSA',
    'paypal-cert-url': opts.certUrl ?? 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-test',
    'paypal-transmission-id': 'b2384410-f8d2-11ee-8e7d-4f2bbd9d1d8f',
    'paypal-transmission-time': '2026-11-09T02:30:00Z'
  };
  const message = `${headers['paypal-transmission-id']}|${headers['paypal-transmission-time']}|WH-TEST|${crc32(Buffer.from(body)) >>> 0}`;
  const signer = createSign('RSA-SHA256'); signer.update(message);
  headers['paypal-transmission-sig'] = signer.sign(privateKey, 'base64');
  return (name: string) => headers[name] ?? '';
}

afterEach(() => vi.unstubAllGlobals());

describe('PayPal webhook signatures', () => {
  it('accepts a genuine delivery and rejects a tampered body', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pem)));
    const body = JSON.stringify({ event_type: 'INVOICING.INVOICE.PAID', resource: { invoice: { id: 'INV2-TEST' } } });
    const h = signed(body);
    expect(await verifyLocally(Buffer.from(body), h, 'WH-TEST')).toBe(true);
    expect(await verifyLocally(Buffer.from(body.replace('PAID', 'CANCELLED')), h, 'WH-TEST')).toBe(false);
    expect(await verifyLocally(Buffer.from(body), h, 'WH-OTHER')).toBe(false);
  });

  it('only trusts certificates served by PayPal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(pem)));
    const body = '{}';
    await expect(verifyLocally(Buffer.from(body), signed(body, { certUrl: 'https://evil.example.com/cert.pem' }), 'WH-TEST')).rejects.toThrow(/untrusted/);
    await expect(verifyLocally(Buffer.from(body), signed(body, { certUrl: 'http://api.sandbox.paypal.com/cert' }), 'WH-TEST')).rejects.toThrow(/untrusted/);
  });
});
