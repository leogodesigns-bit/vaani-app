// scripts/register-webhook.js
// Run once: node scripts/register-webhook.js
// Registers orders/paid webhook with Woof Parade Shopify

const SHOP = 'thewoofparade.myshopify.com';
const TOKEN = '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';
const WEBHOOK_URL = 'https://vaani-app-production-6407.up.railway.app/shopify-webhook/orders-paid';
const API_VERSION = '2024-10';

async function registerWebhook() {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/webhooks.json`;

  const body = {
    webhook: {
      topic: 'orders/paid',
      address: WEBHOOK_URL,
      format: 'json'
    }
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Shopify-Access-Token': TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

  const result = await res.json();
  if (res.ok) {
    console.log('✅ Webhook registered:', result.webhook.id);
    console.log('Topic:', result.webhook.topic);
    console.log('Address:', result.webhook.address);
    console.log('');
    console.log('⚠️  IMPORTANT: Get the webhook secret from Shopify Admin → Settings → Notifications → scroll to bottom → "All webhooks" section → copy the secret.');
    console.log('Then add to Railway env: SHOPIFY_WEBHOOK_SECRET=<that_secret>');
  } else {
    console.error('❌ Failed:', result);
  }
}

registerWebhook();
