// Settings come from the environment (see .env.example). Logbill only talks to the PayPal sandbox.

const env = (name: string, fallback = ''): string => (process.env[name] ?? fallback).trim();

export const config = {
  port: Number(env('PORT', '8787')),
  production: env('NODE_ENV') === 'production',
  paypal: {
    clientId: env('PAYPAL_CLIENT_ID'),
    clientSecret: env('PAYPAL_CLIENT_SECRET'),
    baseUrl: 'https://api-m.sandbox.paypal.com',
    /** The sandbox business account the app was created under; it is the invoicer on every invoice. */
    invoicerEmail: env('PAYPAL_INVOICER_EMAIL')
  },
  ai: {
    apiKey: env('AI_API_KEY'),
    baseUrl: env('AI_BASE_URL', 'https://openrouter.ai/api/v1').replace(/\/$/, ''),
    model: env('AI_MODEL', 'anthropic/claude-haiku-5.5'),
    /** Most AI calls the whole server makes in a day, so a public demo cannot run up a bill. */
    dailyLimit: Number(env('AI_DAILY_LIMIT', '400'))
  },
  demo: {
    /** Sandbox buyer account the sample invoices go to, so anyone can pay them in the sandbox. */
    recipientEmail: env('DEMO_RECIPIENT_EMAIL'),
    /** Invoices may only go to these email domains (sandbox accounts use example.com). */
    recipientDomains: env('RECIPIENT_DOMAINS', 'example.com').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean)
  },
  dataDir: env('DATA_DIR', 'data')
};

export function missingSettings(): string[] {
  const missing: string[] = [];
  if (!config.paypal.clientId) missing.push('PAYPAL_CLIENT_ID');
  if (!config.paypal.clientSecret) missing.push('PAYPAL_CLIENT_SECRET');
  if (!config.paypal.invoicerEmail) missing.push('PAYPAL_INVOICER_EMAIL');
  return missing;
}

export function recipientAllowed(email: string): boolean {
  const domain = email.toLowerCase().split('@')[1] ?? '';
  return config.demo.recipientDomains.includes('*') || config.demo.recipientDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}
