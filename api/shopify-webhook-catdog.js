// api/shopify-webhook-catdog.js
// Vercel Serverless Function: Shopify orders/paid → Shopify Admin API → Facebook CAPI → CatPurchase / DogPurchase

const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const PIXEL_ID        = process.env.CATDOG_FB_PIXEL_ID;
const ACCESS_TOKEN    = process.env.CATDOG_FB_TOKEN;
const FB_API_VERSION  = 'v22.0';

// Vercel env: SHOPIFY_STORE_DOMAIN = yourstore.myshopify.com, SHOPIFY_ADMIN_TOKEN = shpat_xxx
const SHOPIFY_DOMAIN      = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = '2024-04';

// Must match product_type values in Shopify
const CAT_TYPE = 'cat';
const DOG_TYPE = 'dog';

// ─── Utils ────────────────────────────────────────────────────────────────────

// SHA-256 hash — required for all PII fields sent to Meta CAPI
function sha256(value) {
  if (!value) return undefined;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
}

// Normalize product type to lowercase for reliable comparison
function normalizeType(type) {
  if (!type) return '';
  return String(type).toLowerCase().trim();
}

// Check if product type contains target keyword (e.g. "cat", "dog")
function isType(type, target) {
  return normalizeType(type).includes(target);
}

// Round to 2 decimal places for price/value fields
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─── Raw body reader ──────────────────────────────────────────────────────────
// Must read raw body before parsing — needed for HMAC signature verification
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end',  () => resolve(data));
    req.on('error', reject);
  });
}

// ─── Shopify webhook signature verification ───────────────────────────────────
// Validates request came from Shopify using HMAC-SHA256 + SHOPIFY_WEBHOOK_SECRET env var
function verifyShopifyWebhook(rawBody, signature) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — skipping verification');
    return true;
  }
  const hash = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ─── Shopify Admin API: fetch product_type for a list of product IDs ──────────
// Single GraphQL request instead of multiple REST calls — webhook line_items often have empty product_type
async function fetchProductTypes(productIds) {
  const uniqueIds = [...new Set(productIds.map(String).filter(Boolean))];
  if (!uniqueIds.length) return {};

  const ids = uniqueIds.map(id => `"gid://shopify/Product/${id}"`).join(', ');
  const query = `
    {
      nodes(ids: [${ids}]) {
        ... on Product {
          id
          productType
        }
      }
    }
  `;

  const url = `https://${SHOPIFY_DOMAIN}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type':           'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Shopify Admin API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const nodes = json?.data?.nodes || [];

  // Returns { "numericProductId": "productType" } — strips GID prefix
  const map = {};
  for (const node of nodes) {
    if (!node || !node.id) continue;
    const numId = node.id.replace('gid://shopify/Product/', '');
    map[numId] = node.productType || '';
  }

  console.log('🏷️  Product type map:', JSON.stringify(map));
  return map;
}

// ─── Extract fbc (Facebook Click ID) ─────────────────────────────────────────
// Priority: note_attributes._fbc (written by theme) → fbclid param from landing_site URL
function extractFbc(order, attrs) {
  if (attrs._fbc) return attrs._fbc;

  const landingSite = order.landing_site || '';
  try {
    const url = new URL(landingSite, 'https://placeholder.com');
    const fbclid = url.searchParams.get('fbclid');
    if (fbclid) {
      // Meta fbc format: fb.{version}.{timestamp}.{fbclid}
      const ts = Math.floor(new Date(order.created_at).getTime() / 1000);
      return `fb.1.${ts}.${fbclid}`;
    }
  } catch {}

  return null;
}

// ─── Build user_data payload for Meta CAPI ────────────────────────────────────
// More fields = higher Event Match Quality (EMQ) score in Meta Events Manager
function buildUserData(order, attrs) {
  const ud = {};

  const phone = order.phone
    || order.shipping_address?.phone
    || order.billing_address?.phone
    || null;

  if (order.email)                         ud.em      = [sha256(order.email)];
  if (phone)                               ud.ph      = [sha256(phone.replace(/\D/g, ''))];
  if (order.billing_address?.first_name)   ud.fn      = [sha256(order.billing_address.first_name)];
  if (order.billing_address?.last_name)    ud.ln      = [sha256(order.billing_address.last_name)];
  if (order.billing_address?.city)         ud.ct      = [sha256(order.billing_address.city)];
  if (order.billing_address?.zip)          ud.zp      = [sha256(order.billing_address.zip)];
  if (order.billing_address?.country_code)
    ud.country = [sha256(order.billing_address.country_code.toLowerCase())];
  if (order.browser_ip)                    ud.client_ip_address = order.browser_ip;
  if (order.client_details?.user_agent)    ud.client_user_agent = order.client_details.user_agent;

  const fbc = extractFbc(order, attrs);
  const fbp = attrs._fbp || null;
  if (fbc) ud.fbc = fbc;
  if (fbp) ud.fbp = fbp;

  return ud;
}

// ─── Send a single CAPI event to Meta ────────────────────────────────────────
async function sendCAPIEvent({ eventName, items, order, userData, eventId }) {
  const value = round2(items.reduce((sum, i) => sum + i.price * i.quantity, 0));

  const payload = {
    data: [{
      event_name:    eventName,
      event_time:    Math.floor(new Date(order.created_at).getTime() / 1000),
      event_id:      eventId,
      action_source: 'website',
      user_data:     userData,
      custom_data: {
        currency:     order.currency || 'PLN',
        value,
        order_id:     String(order.id),
        num_items:    items.reduce((s, i) => s + i.quantity, 0),
        content_type: 'product',
        content_ids:  items.map(i => String(i.product_id)),
        contents:     items.map(i => ({
          id:         String(i.product_id),
          quantity:   i.quantity,
          item_price: round2(i.price),
        })),
      },
    }],
  };

  if (process.env.FB_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.FB_TEST_EVENT_CODE;
  }

  const url = `https://graph.facebook.com/${FB_API_VERSION}/${PIXEL_ID}/events?access_token=${ACCESS_TOKEN}`;

  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });

  const result = await res.json();
  if (!res.ok || result.error) {
    throw new Error(JSON.stringify(result.error || result));
  }

  return result;
}

// ─── Main handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.error('❌ Missing CATDOG_FB_PIXEL_ID or CATDOG_FB_TOKEN');
    return res.status(500).json({ error: 'Pixel config missing' });
  }

  if (!SHOPIFY_DOMAIN || !SHOPIFY_ADMIN_TOKEN) {
    console.error('❌ Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN');
    return res.status(500).json({ error: 'Shopify Admin API config missing' });
  }

  const rawBody   = await getRawBody(req);
  const signature = req.headers['x-shopify-hmac-sha256'];

  if (!signature || !verifyShopifyWebhook(rawBody, signature)) {
    console.error('❌ Invalid signature');
    return res.status(401).json({ error: 'Unauthorized' });
  }

  let order;
  try {
    order = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // Parse note_attributes into a flat key-value object
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  const lineItems = order.line_items || [];

  console.log('🔍 line_items from webhook:', JSON.stringify(
    lineItems.map(li => ({
      product_id:   li.product_id,
      title:        li.title,
      product_type: li.product_type,
    }))
  ));

  // Fetch product_type from Admin API — more reliable than webhook payload
  const productIds   = lineItems.map(li => li.product_id).filter(Boolean);
  let productTypeMap = {};

  try {
    productTypeMap = await fetchProductTypes(productIds);
  } catch (err) {
    console.error('❌ Failed to fetch product types from Shopify Admin API:', err.message);
  }

  // Admin API product_type takes priority over webhook field
  const items = lineItems.map(li => ({
    product_id:   li.product_id,
    variant_id:   li.variant_id,
    quantity:     Number(li.quantity || 0),
    price:        Number(li.price    || 0),
    product_type: productTypeMap[String(li.product_id)] || li.product_type || '',
  }));

  const catItems = items.filter(i => isType(i.product_type, CAT_TYPE));
  const dogItems = items.filter(i => isType(i.product_type, DOG_TYPE));

  console.log(`📦 Order ${order.id} | cats: ${catItems.length} | dogs: ${dogItems.length}`);

  if (!catItems.length && !dogItems.length) {
    console.warn('⚠️  No cat/dog items in order', order.id);
    return res.status(200).json({ skipped: true, reason: 'no cat/dog items' });
  }

  const userData = buildUserData(order, attrs);
  const results  = {};

  if (dogItems.length) {
    try {
      results.dog = await sendCAPIEvent({
        eventName: 'DogPurchase',
        items:     dogItems,
        order,
        userData,
        eventId:   `${order.id}-dog`,
      });
      console.log(`✅ DogPurchase → order ${order.id}`);
    } catch (err) {
      console.error('❌ DogPurchase error:', err.message);
      results.dogError = err.message;
    }
  }

  if (catItems.length) {
    try {
      results.cat = await sendCAPIEvent({
        eventName: 'CatPurchase',
        items:     catItems,
        order,
        userData,
        eventId:   `${order.id}-cat`,
      });
      console.log(`✅ CatPurchase → order ${order.id}`);
    } catch (err) {
      console.error('❌ CatPurchase error:', err.message);
      results.catError = err.message;
    }
  }

  return res.status(200).json({ success: true, orderId: order.id, results });
};

// Disable Vercel body parser — raw body needed for Shopify HMAC verification
module.exports.config = {
  api: { bodyParser: false },
};
