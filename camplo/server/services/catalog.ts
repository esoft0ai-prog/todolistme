/**
 * Integration catalog: every tool Camplo connects to, the exact fields it needs, which webhook(s) Camplo gives it,
 * how its requests are authenticated, and the setup steps shown to the operator.
 *
 * webhooks:
 *   'leads'     — the tool sends new leads (form submissions, warm replies). Creates leads, starts SLA timers.
 *   'lifecycle' — the tool sends what happened to a lead afterwards (CRM stage, email enrolment). Feeds the
 *                 lead timeline and cross-tool SLA.
 * signing (for 'leads'):
 *   'camplo'   — X-Camplo-Signature: sha256=<hex HMAC-SHA256 of the raw body>, or the URL token
 *   'tally'    — Tally-Signature: <base64 HMAC-SHA256>, secret pasted into Tally
 *   'typeform' — Typeform-Signature: sha256=<base64 HMAC-SHA256>, secret pasted into Typeform
 *   'token'    — the tool cannot sign, so the webhook URL carries a secret token (?token=…)
 */
export type FieldType = 'text' | 'url' | 'secret';
export interface Field { key: string; label: string; type: FieldType; required?: boolean; placeholder?: string; help?: string; default?: string }
export type Mode = 'receive' | 'send' | 'query';
export type Provider =
  | 'systeme_io' | 'gohighlevel' | 'tally' | 'typeform' | 'custom' | 'instantly' | 'apollo' | 'lemlist' | 'smartlead'
  | 'twenty_crm' | 'hubspot' | 'salesforce' | 'umami' | 'activecampaign' | 'mailchimp' | 'brevo' | 'notifuse'
  | 'meta_ads' | 'google_ads' | 'slack' | 'zapier' | 'make';

export interface CatalogEntry {
  provider: Provider; name: string; category: string; blurb: string;
  methods: Array<'webhook' | 'api_key' | 'oauth'>; modes: Mode[];
  fields: Field[];
  webhooks: Array<'leads' | 'lifecycle'>;
  signing?: 'camplo' | 'tally' | 'typeform' | 'token';
  setup: string[];
  docsUrl?: string;
  comingSoon?: boolean;
  /** Counts toward the plan's "connected tools" limit (CRM, email, ads, analytics, team chat). */
  isTool?: boolean;
}

const warmReplySetup = (tool: string, where: string, event: string) => [
  `In ${tool}, open ${where}.`,
  `Create a webhook for the "${event}" event and paste the Camplo lead webhook URL (it already contains your secret token).`,
  'Send a test reply. It appears in the Lead Inbox within seconds, and the SLA timer starts.',
];

export const CATALOG: CatalogEntry[] = [
  // ------------------------------------------------------------ lead sources
  {
    provider: 'systeme_io', name: 'Systeme.io', category: 'Lead sources', methods: ['webhook', 'api_key'], modes: ['receive', 'query'], webhooks: ['leads'], signing: 'token',
    blurb: 'Opt-ins from your Systeme.io funnels arrive as Camplo leads.',
    fields: [{ key: 'apiKey', label: 'Public API key (optional)', type: 'secret', help: 'Settings → Public API keys. Lets Camplo look up contact details and tags.' }],
    setup: ['In Systeme.io go to Automations → Rules → Create.', 'Trigger: "Funnel step form subscribed" (choose your funnel step).', 'Action: "Send a webhook" and paste the Camplo lead webhook URL.', 'Submit the form once to test.'],
    docsUrl: 'https://help.systeme.io',
  },
  {
    provider: 'gohighlevel', name: 'GoHighLevel', category: 'Lead sources', methods: ['webhook', 'api_key'], modes: ['receive', 'send', 'query'], webhooks: ['leads', 'lifecycle'], signing: 'token',
    blurb: 'New contacts become Camplo leads; opportunity stage changes feed the lead timeline and cross-tool SLA.',
    fields: [
      { key: 'apiKey', label: 'Private Integration token', type: 'secret', help: 'Settings → Private Integrations → Create. Scopes: contacts.readonly, opportunities.readonly.' },
      { key: 'locationId', label: 'Location (sub-account) ID', type: 'text', placeholder: 'e.g. ve9EPM428h8vShlRW1KT', help: 'Settings → Business Profile → Location ID.' },
    ],
    setup: ['In GoHighLevel open Automation → Workflows → Create workflow.', 'Trigger "Contact Created" (or "Form Submitted") → action "Webhook" → paste the Camplo lead webhook URL.', 'Create a second workflow: trigger "Opportunity Stage Changed" → action "Webhook" → paste the Camplo lifecycle webhook URL.', 'Publish both workflows.'],
    docsUrl: 'https://help.gohighlevel.com',
  },
  {
    provider: 'tally', name: 'Tally', category: 'Lead sources', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'tally', fields: [],
    blurb: 'Every Tally form submission becomes a Camplo lead, with hidden-field UTMs captured.',
    setup: ['Open your form in Tally → Integrations → Webhooks → Connect.', 'Endpoint URL: paste the Camplo lead webhook URL.', 'Signing secret: paste the signing secret Camplo shows you, then save.', 'Add hidden fields utm_source, utm_medium, utm_campaign to capture attribution.'],
    docsUrl: 'https://tally.so/help/webhooks',
  },
  {
    provider: 'typeform', name: 'Typeform', category: 'Lead sources', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'typeform', fields: [],
    blurb: 'Every Typeform response becomes a Camplo lead.',
    setup: ['Open your form in Typeform → Connect → Webhooks → Add a webhook.', 'Paste the Camplo lead webhook URL.', 'Open the webhook\'s settings, turn on "Secret" and paste the signing secret Camplo shows you.', 'Turn the webhook on and send a test request.'],
    docsUrl: 'https://www.typeform.com/developers/webhooks/',
  },
  {
    provider: 'custom', name: 'Custom / any form', category: 'Lead sources', methods: ['webhook'], modes: ['receive', 'send'], webhooks: ['leads'], signing: 'camplo', fields: [],
    blurb: 'Send leads from any system that can make an HTTP POST. See the webhook reference for the payload format.',
    setup: ['POST JSON to the Camplo lead webhook URL (fields: name, email, phone, utm_*).', 'Sign the raw body: header X-Camplo-Signature: sha256=<hex HMAC-SHA256 using the signing secret>.', 'If your system cannot sign requests, use the URL as shown — it carries a secret token instead.'],
  },
  {
    provider: 'instantly', name: 'Instantly', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Warm replies from your Instantly campaigns become Camplo leads. Camplo\'s accountability starts the moment a prospect responds.',
    setup: warmReplySetup('Instantly', 'Settings → Integrations → Webhooks', 'Reply received'),
  },
  {
    provider: 'apollo', name: 'Apollo', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Warm replies from your Apollo sequences become Camplo leads.',
    setup: ['Apollo does not send reply webhooks directly — connect it through Zapier or Make.', 'Trigger: Apollo "Contact replied to sequence".', 'Action: "Webhooks → POST" to the Camplo lead webhook URL, mapping name, email and phone.'],
  },
  {
    provider: 'lemlist', name: 'Lemlist', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Warm replies from your Lemlist campaigns become Camplo leads.',
    setup: warmReplySetup('Lemlist', 'Settings → Integrations → Webhooks', 'emailsReplied'),
  },
  {
    provider: 'smartlead', name: 'Smartlead', category: 'Cold outreach (warm replies)', methods: ['webhook'], modes: ['receive'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Warm replies from your Smartlead campaigns become Camplo leads.',
    setup: warmReplySetup('Smartlead', 'Settings → Webhooks', 'EMAIL_REPLY'),
  },
  // ------------------------------------------------------------ CRM
  {
    provider: 'twenty_crm', name: 'Twenty CRM', category: 'CRM', methods: ['webhook', 'api_key'], modes: ['receive', 'send', 'query'], webhooks: ['lifecycle'], isTool: true,
    blurb: 'Pipeline stages from Twenty feed each lead\'s timeline and cross-tool SLA checks.',
    fields: [
      { key: 'baseUrl', label: 'Twenty workspace URL', type: 'url', required: true, placeholder: 'https://crm.yourcompany.com', default: 'https://api.twenty.com' },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Settings → APIs & Webhooks → Create API key.' },
    ],
    setup: ['In Twenty open Settings → APIs & Webhooks → Webhooks → Create webhook.', 'URL: paste the Camplo lifecycle webhook URL.', 'Events: person.updated, opportunity.created, opportunity.updated.'],
    docsUrl: 'https://twenty.com/developers',
  },
  {
    provider: 'hubspot', name: 'HubSpot', category: 'CRM', methods: ['oauth'], modes: ['receive', 'query'], webhooks: [], fields: [], isTool: true, comingSoon: true,
    blurb: 'Deal stages from HubSpot. Arrives with the OAuth connection flow.', setup: [],
  },
  {
    provider: 'salesforce', name: 'Salesforce', category: 'CRM', methods: ['oauth'], modes: ['receive', 'query'], webhooks: [], fields: [], isTool: true, comingSoon: true,
    blurb: 'Opportunity stages from Salesforce. Arrives with the OAuth connection flow.', setup: [],
  },
  // ------------------------------------------------------------ analytics
  {
    provider: 'umami', name: 'Umami', category: 'Analytics', methods: ['api_key'], modes: ['query'], webhooks: [], isTool: true,
    blurb: 'Page views, referrers and devices for your pages, so Camplo can tell traffic problems from page problems.',
    fields: [
      { key: 'baseUrl', label: 'Umami API URL', type: 'url', required: true, default: 'https://api.umami.is/v1', help: 'Umami Cloud: https://api.umami.is/v1. Self-hosted: https://your-umami-domain/api' },
      { key: 'websiteId', label: 'Website ID', type: 'text', required: true, placeholder: 'e.g. 4fb7fa4c-5b46-438d-94b3-3a8fb9bc2e8b', help: 'Settings → Websites → Edit → Website ID.' },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Umami Cloud: Settings → API keys. Self-hosted: an access token.' },
    ],
    setup: ['Add the Umami tracking script to the pages you host on Camplo (or your own site).', 'Fill in the API URL, website ID and API key, then press Verify.'],
    docsUrl: 'https://umami.is/docs/api',
  },
  // ------------------------------------------------------------ email platforms
  {
    provider: 'activecampaign', name: 'ActiveCampaign', category: 'Email platform', methods: ['api_key', 'webhook'], modes: ['receive', 'query'], webhooks: ['lifecycle'], isTool: true,
    blurb: 'Sequence enrolment and engagement, for the email-enrolment SLA and drop-off checks.',
    fields: [
      { key: 'baseUrl', label: 'API URL', type: 'url', required: true, placeholder: 'https://youraccount.api-us1.com', help: 'Settings → Developer → API Access → URL.' },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Settings → Developer → API Access → Key.' },
    ],
    setup: ['Fill in the API URL and key, then press Verify.', 'Optional: Settings → Developer → Webhooks → Add → paste the Camplo lifecycle webhook URL, events "Contact added to automation", "Contact subscribed".'],
    docsUrl: 'https://developers.activecampaign.com',
  },
  {
    provider: 'mailchimp', name: 'Mailchimp', category: 'Email platform', methods: ['api_key', 'webhook'], modes: ['receive', 'query'], webhooks: ['lifecycle'], isTool: true,
    blurb: 'Audience and campaign engagement for follow-up checks.',
    fields: [
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, placeholder: 'xxxxxxxxxxxxxxxx-us21', help: 'Profile → Extras → API keys. The data centre (e.g. us21) is read from the key.' },
      { key: 'audienceId', label: 'Audience ID', type: 'text', required: true, help: 'Audience → Settings → Audience name and defaults → Audience ID.' },
    ],
    setup: ['Fill in the API key and audience ID, then press Verify.', 'Optional: Audience → Settings → Webhooks → Create → paste the Camplo lifecycle webhook URL (events: subscribes, profile updates).'],
    docsUrl: 'https://mailchimp.com/developer/marketing/',
  },
  {
    provider: 'brevo', name: 'Brevo', category: 'Email platform', methods: ['api_key', 'webhook'], modes: ['receive', 'query'], webhooks: ['lifecycle'], isTool: true,
    blurb: 'Contact list membership and email engagement from Brevo.',
    fields: [{ key: 'apiKey', label: 'API key (v3)', type: 'secret', required: true, help: 'Profile → SMTP & API → API keys → Generate.' }],
    setup: ['Fill in the API key, then press Verify.', 'Optional: Contacts → Settings → Webhooks → Add → paste the Camplo lifecycle webhook URL (events: list addition, opened, clicked).'],
    docsUrl: 'https://developers.brevo.com',
  },
  {
    provider: 'notifuse', name: 'Notifuse', category: 'Email platform', methods: ['api_key'], modes: ['query'], webhooks: [], isTool: true,
    blurb: 'Broadcast and sequence engagement from your Notifuse workspace.',
    fields: [
      { key: 'baseUrl', label: 'Notifuse API URL', type: 'url', required: true, placeholder: 'https://notifuse.yourcompany.com' },
      { key: 'workspaceId', label: 'Workspace ID', type: 'text', required: true },
      { key: 'apiKey', label: 'API key', type: 'secret', required: true, help: 'Workspace settings → API keys.' },
    ],
    setup: ['Fill in the API URL, workspace ID and API key, then press Verify.'],
    docsUrl: 'https://docs.notifuse.com',
  },
  // ------------------------------------------------------------ ad platforms (read only)
  {
    provider: 'meta_ads', name: 'Meta Ads', category: 'Ad platforms', methods: ['api_key'], modes: ['query'], webhooks: [], isTool: true,
    blurb: 'Read-only spend and clicks per campaign, for live cost per lead and spend-without-leads alerts. Camplo never changes your ads.',
    fields: [
      { key: 'adAccountId', label: 'Ad account ID', type: 'text', required: true, placeholder: 'act_1234567890', help: 'Business Settings → Accounts → Ad accounts.' },
      { key: 'accessToken', label: 'System user access token', type: 'secret', required: true, help: 'Business Settings → Users → System users → Generate token with ads_read.' },
    ],
    setup: ['Create a system user with access to the ad account and generate a token with the ads_read permission.', 'Fill in the ad account ID and token, then press Verify.', 'Use utm_campaign values that match your Camplo campaigns so spend lines up with leads.'],
    docsUrl: 'https://developers.facebook.com/docs/marketing-api',
  },
  {
    provider: 'google_ads', name: 'Google Ads', category: 'Ad platforms', methods: ['api_key'], modes: ['query'], webhooks: [], isTool: true,
    blurb: 'Read-only spend and clicks per campaign. Camplo never changes your ads.',
    fields: [
      { key: 'customerId', label: 'Customer ID', type: 'text', required: true, placeholder: '123-456-7890' },
      { key: 'loginCustomerId', label: 'Manager account ID (if you use an MCC)', type: 'text', placeholder: '987-654-3210' },
      { key: 'developerToken', label: 'Developer token', type: 'secret', required: true, help: 'Google Ads → Tools → API Center.' },
      { key: 'clientId', label: 'OAuth client ID', type: 'text', required: true },
      { key: 'clientSecret', label: 'OAuth client secret', type: 'secret', required: true },
      { key: 'refreshToken', label: 'OAuth refresh token', type: 'secret', required: true, help: 'Generated with the adwords scope for a user who can read the account.' },
    ],
    setup: ['In Google Ads → Tools → API Center, copy your developer token.', 'Create an OAuth client in Google Cloud and generate a refresh token with the https://www.googleapis.com/auth/adwords scope.', 'Fill in all fields, then press Verify.'],
    docsUrl: 'https://developers.google.com/google-ads/api/docs/start',
  },
  // ------------------------------------------------------------ team communication
  {
    provider: 'slack', name: 'Slack', category: 'Team communication', methods: ['oauth'], modes: ['query'], webhooks: [], fields: [], isTool: true, comingSoon: true,
    blurb: 'Pattern signals from the channels you choose. Arrives with the OAuth connection flow.', setup: [],
  },
  // ------------------------------------------------------------ automation
  {
    provider: 'zapier', name: 'Zapier', category: 'Automation', methods: ['webhook'], modes: ['receive', 'send'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Send leads into Camplo from any of Zapier\'s apps, and send Camplo events back out.',
    setup: ['Into Camplo: add the action "Webhooks by Zapier → POST", URL = the Camplo lead webhook URL, payload type JSON, map name / email / phone.', 'Out of Camplo: create a "Catch Hook" trigger in Zapier, copy its URL and add it in Settings → Webhooks & API → Outbound webhooks.'],
  },
  {
    provider: 'make', name: 'Make', category: 'Automation', methods: ['webhook'], modes: ['receive', 'send'], webhooks: ['leads'], signing: 'token', fields: [],
    blurb: 'Send leads into Camplo from Make scenarios, and send Camplo events back out.',
    setup: ['Into Camplo: add an "HTTP → Make a request" module, method POST, URL = the Camplo lead webhook URL, body type JSON.', 'Out of Camplo: add a "Webhooks → Custom webhook" trigger, copy its URL and add it in Settings → Webhooks & API → Outbound webhooks.'],
  },
];

export function catalogEntry(provider: string) { return CATALOG.find((c) => c.provider === provider); }
