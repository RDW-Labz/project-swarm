// SPDX-License-Identifier: Apache-2.0
const norm = (s) => ' ' + String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() + ' ';
const hit = (text, kw) => norm(text).includes(' ' + norm(kw).trim() + ' ');

export const DAY0_CATALOG = [
  { id: 'stripe', name: 'Stripe', kind: 'payments', keywords: ['stripe', 'payments', 'payment', 'checkout', 'billing'], steps: ['Create a Stripe account and switch it to test mode', 'Create API keys and store them in the secrets vault', 'Register a webhook endpoint and record its signing secret'] },
  { id: 'domain', name: 'Domain and DNS', kind: 'domain', keywords: ['domain', 'dns', 'custom domain'], steps: ['Choose a domain name and register it', 'Point its DNS records at the hosting provider', 'Confirm HTTPS works on the domain'] },
  { id: 'email', name: 'Transactional email', kind: 'email', keywords: ['email', 'sendgrid', 'postmark', 'resend', 'ses', 'mailgun'], steps: ['Create an email provider account (SendGrid, Postmark, Resend or SES)', 'Verify the sending domain with DNS records', 'Create an API key and store it in the secrets vault'] },
  { id: 'auth-google', name: 'Google sign-in', kind: 'auth', keywords: ['google sign in', 'sign in with google', 'google login'], steps: ['Create a Google Cloud project and an OAuth consent screen', 'Create OAuth client credentials for web and mobile', 'Add the redirect URLs for each environment'] },
  { id: 'auth-apple', name: 'Sign in with Apple', kind: 'auth', keywords: ['sign in with apple', 'apple sign in', 'apple login'], steps: ['Enable Sign in with Apple for the App ID in the Apple Developer portal', 'Create a Services ID and a private key', 'Record the team ID, key ID and redirect URL'] },
  { id: 'sms', name: 'SMS', kind: 'sms', keywords: ['sms', 'twilio', 'text message'], steps: ['Create a Twilio account and buy a sender number', 'Complete any sender registration the carrier requires', 'Store the account SID and auth token in the secrets vault'] },
  { id: 'hosting', name: 'Hosting', kind: 'hosting', keywords: ['hosting', 'vercel', 'fly io', 'cloudflare', 'aws', 'deploy'], steps: ['Create the hosting account and a project for staging', 'Connect the repository and set the build command', 'Set environment variables from the secrets vault'] },
  { id: 'error-tracking', name: 'Error tracking', kind: 'observability', keywords: ['sentry', 'error tracking', 'crash reporting'], steps: ['Create a Sentry project for each platform', 'Copy the DSN into the secrets vault', 'Confirm a test error shows up'] },
  { id: 'analytics', name: 'Analytics', kind: 'analytics', keywords: ['analytics', 'google analytics', 'mixpanel', 'posthog'], steps: ['Create an analytics property and a project key', 'Decide which events are collected and note the privacy impact', 'Store the write key in the secrets vault'] },
  { id: 'maps', name: 'Maps', kind: 'maps', keywords: ['google maps', 'mapbox', 'maps'], steps: ['Create a Google Cloud or Mapbox account', 'Create an API key and restrict it to the app domains', 'Set a usage budget alert'] },
  { id: 'push', name: 'Push notifications', kind: 'push', keywords: ['push notifications', 'push', 'firebase cloud messaging', 'apns', 'fcm'], steps: ['Create a Firebase project and add the iOS and Android apps', 'Create an APNs key in the Apple Developer portal', 'Store the service account and APNs key in the secrets vault'] },
  { id: 'storage', name: 'File storage', kind: 'storage', keywords: ['s3', 'r2', 'file storage', 'object storage', 'uploads'], steps: ['Create a bucket for each environment', 'Create an access key scoped to that bucket', 'Store the access key in the secrets vault'] },
  { id: 'app-store', name: 'Apple App Store', kind: 'store', keywords: ['app store', 'apple developer', 'testflight'], steps: ['Enroll in the Apple Developer Program', 'Create the App Store Connect listing and app record', 'Write the privacy policy and fill in the privacy labels', 'Submit the build for App Review'] },
  { id: 'play-store', name: 'Google Play', kind: 'store', keywords: ['google play', 'play store'], steps: ['Create a Google Play developer account', 'Create the app listing and complete the data safety form', 'Upload the first build to an internal test track'] },
  { id: 'secrets-vault', name: 'Secrets vault', kind: 'secrets', keywords: ['secrets', 'secret manager', 'vault', 'env vars', 'environment variables'], steps: ['Choose the vault and create the project', 'Grant access to the owner and the build only', 'Record where each key lives in the project notes'] }
];

export function day0Checklist(scope, { extra = [] } = {}) {
  const reqs = scope?.requirements ?? [];
  const ext = scope?.external ?? [];
  const reqIds = (c) => reqs.filter((r) => [r.text, ...(r.acceptance ?? [])].some((t) => c.keywords.some((k) => hit(t, k)))).map((r) => r.id);
  const otherHit = (c) => [scope?.overview ?? '', ...ext.map((e) => `${e.name} ${e.note ?? ''}`)].some((t) => c.keywords.some((k) => hit(t, k)));
  const items = [];
  for (const c of DAY0_CATALOG) {
    const ids = reqIds(c);
    if (ids.length || otherHit(c)) items.push({ service: c.name, kind: c.kind, why: ids.length ? ids : ['external'], steps: [...c.steps] });
  }
  for (const e of ext) {
    const txt = `${e.name} ${e.note ?? ''}`;
    if (!DAY0_CATALOG.some((c) => c.keywords.some((k) => hit(txt, k)))) {
      items.push({ service: e.name, kind: 'external', why: ['external'], steps: ['Decide who owns the account', 'Create it and record where the keys go'] });
    }
  }
  for (const x of extra) items.push({ ...x, steps: [...(x.steps ?? [])] });
  return items.map((it, i) => ({ id: 'H-' + String(i + 1).padStart(3, '0'), ...it }));
}

export function checklistToTickets(items, { startAt = 9001 } = {}) {
  return items.map((it, i) => ({
    id: 'T-' + (startAt + i), title: `Day 0: ${it.service}`, type: 'human', stage: 'S0', epic: 'E-00 Day 0',
    scopeRefs: [], acceptance: [], files: [], context: [], contracts: [], dependsOn: [], size: 'S', risk: 'low',
    sensitive: false, status: 'todo', steps: [...it.steps]
  }));
}
