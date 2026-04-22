// api/shopify-webhook-catdog.js
// Vercel Serverless Function
// Shopify orders/paid → Facebook CAPI → CatPurchase / DogPurchase

const crypto = require('crypto');

// ─── Конфіг ───────────────────────────────────────────────────────────────────
const PIXEL_ID     = process.env.CATDOG_FB_PIXEL_ID;
const ACCESS_TOKEN = process.env.CATDOG_FB_TOKEN;
const FB_API_VERSION = 'v19.0';

const CAT_TYPE = 'cat';
const DOG_TYPE = 'dog';

// ─── Utils ────────────────────────────────────────────────────────────────────
function sha256(value) {
  if (!value) return undefined;
  return crypto
    .createHash('sha256')
    .update(String(value).trim().toLowerCase())
    .digest('hex');
}

function normalizeType(type) {
  if (!type) return '';
  return String(type).toLowerCase().trim();
}

function isType(type, target) {
  return normalizeType(type).includes(target);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

// ─── Raw body для верифікації підпису ─────────────────────────────────────────
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => (data += chunk));
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ─── Верифікація Shopify webhook ──────────────────────────────────────────────
function verifyShopifyWebhook(rawBody, signature) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
  if (!secret) {
    console.warn('⚠️  SHOPIFY_WEBHOOK_SECRET not set — skipping verification');
    return true;
  }
  const hash = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(hash),
      Buffer.from(signature)
    );
  } catch {
    return false;
  }
}

// ─── Збираємо userData з замовлення ──────────────────────────────────────────
function buildUserData(order, attrs) {
  const ud = {};

  if (order.email)
    ud.em = [sha256(order.email)];
  if (order.phone)
    ud.ph = [sha256(order.phone.replace(/\D/g, ''))];
  if (order.billing_address?.first_name)
    ud.fn = [sha256(order.billing_address.first_name)];
  if (order.billing_address?.last_name)
    ud.ln = [sha256(order.billing_address.last_name)];
  if (order.billing_address?.city)
    ud.ct = [sha256(order.billing_address.city)];
  if (order.billing_address?.country_code)
    ud.country = [sha256(order.billing_address.country_code.toLowerCase())];
  if (order.browser_ip)
    ud.client_ip_address = order.browser_ip;
  if (order.client_details?.user_agent)
    ud.client_user_agent = order.client_details.user_agent;

  if (attrs._fbc) ud.fbc = attrs._fbc;
  if (attrs._fbp) ud.fbp = attrs._fbp;

  return ud;
}

// ─── Відправка одного CAPI-евента ─────────────────────────────────────────────
async function sendCAPIEvent({ eventName, items, order, userData, eventId }) {
  const value = round2(
    items.reduce((sum, i) => sum + i.price * i.quantity, 0)
  );

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

// ─── Головний обробник ────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!PIXEL_ID || !ACCESS_TOKEN) {
    console.error('❌ Missing CATDOG_FB_PIXEL_ID or CATDOG_FB_TOKEN');
    return res.status(500).json({ error: 'Pixel config missing' });
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

  // note_attributes → зручний об'єкт
  const attrs = {};
  (order.note_attributes || []).forEach(a => { attrs[a.name] = a.value; });

  // ── DEBUG: дивимось що реально приходить у line_items ──
  console.log('🔍 line_items raw:', JSON.stringify(
    (order.line_items || []).map(li => ({
      product_id:   li.product_id,
      title:        li.title,
      vendor:       li.vendor,
      product_type: li.product_type,
      sku:          li.sku,
    }))
  ));

  // Маппимо line_items
  const items = (order.line_items || []).map(li => ({
    product_id:   li.product_id,
    variant_id:   li.variant_id,
    quantity:     Number(li.quantity || 0),
    price:        Number(li.price || 0),
    product_type: li.product_type || '',
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

module.exports.config = {
  api: { bodyParser: false },
};
