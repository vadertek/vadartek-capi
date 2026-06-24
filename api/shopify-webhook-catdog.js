// api/shopify-webhook-catdog.js
// Vercel Serverless Function: Shopify orders/paid → Shopify Admin API → Facebook CAPI → CatPurchase / DogPurchase

const crypto = require('crypto');

// ─── Config ───────────────────────────────────────────────────────────────────
const PIXEL_ID = process.env.CATDOG_FB_PIXEL_ID;
const ACCESS_TOKEN = process.env.CATDOG_FB_TOKEN;
const FB_API_VERSION = 'v22.0';

// Vercel env: SHOPIFY_STORE_DOMAIN = yourstore.myshopify.com, SHOPIFY_ADMIN_TOKEN = shpat_xxx
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const SHOPIFY_ADMIN_TOKEN = process.env.SHOPIFY_ADMIN_TOKEN;
const SHOPIFY_API_VERSION = '2024-04';

// Must match product_type values in Shopify
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

function getLineTotal(li) {
  const qty = Number(li.quantity || 0);
  const unitPrice = Number(li.price || 0);
  const gross = unitPrice * qty;

  const discounts = (li.discount_allocations || []).reduce(
    (sum, discount) => sum + Number(discount.amount || 0),
    0
  );

  return round2(Math.max(gross - discounts, 0));
}

// ─── Raw body reader ──────────────────────────────────────────────────────────

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';

    req.on('data', (chunk) => {
      data += chunk;
    });

    req.on('end', () => {
      resolve(data);
    });

    req.on('error', reject);
  });
}

// ─── Shopify webhook signature verification ───────────────────────────────────

function verifyShopifyWebhook(rawBody, signature) {
  const secret = process.env.SHOPIFY_WEBHOOK_SECRET;

  if (!secret) {
    console.warn('⚠️ SHOPIFY_WEBHOOK_SECRET not set — skipping verification');
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
  } catch (error) {
    return false;
  }
}

// ─── Shopify Admin API: fetch product_type for product IDs ────────────────────

async function fetchProductTypes(productIds) {
  const uniqueIds = [...new Set(productIds.map(String).filter(Boolean))];

  if (!uniqueIds.length) {
    return {};
  }

  const ids = uniqueIds
    .map((id) => '"gid://shopify/Product/' + id + '"')
    .join(', ');

  const query =
    '{' +
      ' nodes(ids: [' + ids + ']) {' +
        ' ... on Product {' +
          ' id' +
          ' productType' +
        ' }' +
      ' }' +
    ' }';

  const url =
    'https://' +
    SHOPIFY_DOMAIN +
    '/admin/api/' +
    SHOPIFY_API_VERSION +
    '/graphql.json';

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': SHOPIFY_ADMIN_TOKEN,
    },
    body: JSON.stringify({ query: query }),
  });

  if (!response.ok) {
    const text = await response.text();

    throw new Error(
      'Shopify Admin API error ' + response.status + ': ' + text
    );
  }

  const json = await response.json();
  const nodes = (json && json.data && json.data.nodes) || [];

  console.log(
    '🛒 Shopify GraphQL raw response:',
    JSON.stringify(nodes, null, 2)
  );

  const map = {};

  for (const node of nodes) {
    if (!node || !node.id) {
      continue;
    }

    const numId = node.id.replace('gid://shopify/Product/', '');
    map[numId] = node.productType || '';
  }

  for (const pid of uniqueIds) {
    if (!(pid in map)) {
      console.warn(
        '⚠️ Product ' + pid + ' missing in Shopify GraphQL response'
      );
    }
  }

  console.log(
    '🏷️ Product type map:',
    JSON.stringify(map, null, 2)
  );

  return map;
}

// ─── Extract fbc (Facebook Click ID) ─────────────────────────────────────────

function extractFbc(order, attrs) {
  if (attrs._fbc) {
    return attrs._fbc;
  }

  const landingSite = order.landing_site || '';

  try {
    const url = new URL(landingSite, 'https://placeholder.com');
    const fbclid = url.searchParams.get('fbclid');

    if (fbclid) {
      const timestamp = Math.floor(
        new Date(order.created_at).getTime() / 1000
      );

      return 'fb.1.' + timestamp + '.' + fbclid;
    }
  } catch (error) {
    // Ignore malformed landing_site values.
  }

  return null;
}

// ─── Build user_data payload for Meta CAPI ───────────────────────────────────

function buildUserData(order, attrs) {
  const userData = {};

  const phone =
    order.phone ||
    (order.shipping_address && order.shipping_address.phone) ||
    (order.billing_address && order.billing_address.phone) ||
    null;

  if (order.email) {
    userData.em = [sha256(order.email)];
  }

  if (phone) {
    userData.ph = [sha256(phone.replace(/\D/g, ''))];
  }

  if (order.billing_address && order.billing_address.first_name) {
    userData.fn = [sha256(order.billing_address.first_name)];
  }

  if (order.billing_address && order.billing_address.last_name) {
    userData.ln = [sha256(order.billing_address.last_name)];
  }

  if (order.billing_address && order.billing_address.city) {
    userData.ct = [sha256(order.billing_address.city)];
  }

  if (order.billing_address && order.billing_address.zip) {
    userData.zp = [sha256(order.billing_address.zip)];
  }

  if (order.billing_address && order.billing_address.country_code) {
    userData.country = [
      sha256(order.billing_address.country_code.toLowerCase()),
    ];
  }

  if (order.browser_ip) {
    userData.client_ip_address = order.browser_ip;
  }

  if (order.client_details && order.client_details.user_agent) {
    userData.client_user_agent = order.client_details.user_agent;
  }

  const fbc = extractFbc(order, attrs);
  const fbp = attrs._fbp || null;

  if (fbc) {
    userData.fbc = fbc;
  }

  if (fbp) {
    userData.fbp = fbp;
  }

  return userData;
}

// ─── Send a single CAPI event to Meta ─────────────────────────────────────────

async function sendCAPIEvent(params) {
  const eventName = params.eventName;
  const items = params.items;
  const order = params.order;
  const userData = params.userData;
  const eventId = params.eventId;

  const value = round2(
    items.reduce(
      (sum, item) => sum + Number(item.line_total || 0),
      0
    )
  );

  const originalEventTime = Math.floor(
    new Date(order.created_at).getTime() / 1000
  );

  const now = Math.floor(Date.now() / 1000);
  const sevenDaysAgo = now - (7 * 24 * 60 * 60);

  const safeEventTime =
    originalEventTime < sevenDaysAgo
      ? now
      : originalEventTime;

  if (safeEventTime === now) {
    console.log(
      '⚠️ Order ' +
      order.id +
      ' older than 7 days → using current timestamp for Meta'
    );
  }

  const payload = {
    data: [
      {
        event_name: eventName,
        event_time: safeEventTime,
        event_id: eventId,
        action_source: 'website',
        user_data: userData,
        custom_data: {
          currency: order.currency || 'PLN',
          value: value,
          order_id: String(order.id),
          num_items: items.reduce(
            (sum, item) => sum + Number(item.quantity || 0),
            0
          ),
          content_type: 'product',
          content_ids: items.map((item) => String(item.product_id)),
          contents: items.map((item) => ({
            id: String(item.product_id),
            quantity: Number(item.quantity || 0),
            item_price: round2(item.unit_price),
          })),
        },
      },
    ],
  };

  console.log(eventName + ' value:', value);

  console.log(
    eventName + ' contents:',
    JSON.stringify(payload.data[0].custom_data.contents)
  );

  if (process.env.FB_TEST_EVENT_CODE) {
    payload.test_event_code = process.env.FB_TEST_EVENT_CODE;
  }

  const url =
    'https://graph.facebook.com/' +
    FB_API_VERSION +
    '/' +
    PIXEL_ID +
    '/events?access_token=' +
    ACCESS_TOKEN;

  console.log('🆔 Meta event_id: ' + eventId);

  console.log(
    eventName + ' product_ids:',
    items.map((item) => item.product_id)
  );

  console.log(
    eventName + ' variant_ids:',
    items.map((item) => item.variant_id)
  );

  console.log(
    '🚀 ' + eventName + ' payload:',
    JSON.stringify(payload, null, 2)
  );

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const responseText = await response.text();
  let result;

  try {
    result = JSON.parse(responseText);
  } catch (error) {
    result = { raw_response: responseText };
  }

  console.log(
    '📨 Meta response (' + eventName + '):',
    JSON.stringify(result, null, 2)
  );

  if (!response.ok || result.error) {
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

    return res.status(500).json({
      error: 'Shopify Admin API config missing',
    });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-shopify-hmac-sha256'];

  if (!signature || !verifyShopifyWebhook(rawBody, signature)) {
    console.error('❌ Invalid signature');

    return res.status(401).json({ error: 'Unauthorized' });
  }

  let order;

  try {
    order = JSON.parse(rawBody);
  } catch (error) {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const attrs = {};

  (order.note_attributes || []).forEach((attribute) => {
    attrs[attribute.name] = attribute.value;
  });

  const lineItems = order.line_items || [];

  console.log(
    '🔍 line_items from webhook:',
    JSON.stringify(
      lineItems.map((lineItem) => ({
        product_id: lineItem.product_id,
        variant_id: lineItem.variant_id,
        title: lineItem.title,
        product_type: lineItem.product_type,
        quantity: lineItem.quantity,
        price: lineItem.price,
        line_total: getLineTotal(lineItem),
      })),
      null,
      2
    )
  );

  const productIds = lineItems
    .map((lineItem) => lineItem.product_id)
    .filter(Boolean);

  let productTypeMap = {};

  try {
    productTypeMap = await fetchProductTypes(productIds);
  } catch (error) {
    console.error(
      '❌ Failed to fetch product types from Shopify Admin API:',
      error.message
    );
  }

  const items = lineItems.map((lineItem) => {
    const productType =
      productTypeMap[String(lineItem.product_id)] ||
      lineItem.product_type ||
      '';

    if (!productType) {
      console.warn(
        '⚠️ Missing product type | product=' +
        lineItem.product_id +
        ' variant=' +
        lineItem.variant_id +
        ' title="' +
        lineItem.title +
        '"'
      );
    }

    return {
      product_id: lineItem.product_id,
      variant_id: lineItem.variant_id,
      quantity: Number(lineItem.quantity || 0),
      unit_price: Number(lineItem.price || 0),
      line_total: getLineTotal(lineItem),
      product_type: productType,
    };
  });

  console.log('🔎 FINAL ITEMS:', JSON.stringify(items, null, 2));

  items.forEach((item) => {
    console.log(
      '📦 product=' +
      item.product_id +
      ' variant=' +
      item.variant_id +
      ' type="' +
      item.product_type +
      '" qty=' +
      item.quantity
    );
  });

  const catItems = items.filter((item) => {
    return isType(item.product_type, CAT_TYPE);
  });

  const dogItems = items.filter((item) => {
    return isType(item.product_type, DOG_TYPE);
  });

  console.log(
    '📦 Order ' +
    order.id +
    ' | cats: ' +
    catItems.length +
    ' | dogs: ' +
    dogItems.length
  );

  console.log('🐶 Dog items:', JSON.stringify(dogItems, null, 2));
  console.log('🐱 Cat items:', JSON.stringify(catItems, null, 2));

  if (!catItems.length && !dogItems.length) {
    console.warn('⚠️ No cat/dog items in order ' + order.id);

    console.warn(
      '⚠️ ALL ITEMS:',
      JSON.stringify(items, null, 2)
    );

    return res.status(200).json({
      skipped: true,
      reason: 'no cat/dog items',
    });
  }

  const userData = buildUserData(order, attrs);
  const results = {};

  if (dogItems.length) {
    try {
      results.dog = await sendCAPIEvent({
        eventName: 'DogPurchase',
        items: dogItems,
        order: order,
        userData: userData,
        eventId: String(order.id) + '-dog',
      });

      console.log('✅ DogPurchase → order ' + order.id);
    } catch (error) {
      console.error('❌ DogPurchase error:', error.message);
      results.dogError = error.message;
    }
  }

  if (catItems.length) {
    try {
      results.cat = await sendCAPIEvent({
        eventName: 'CatPurchase',
        items: catItems,
        order: order,
        userData: userData,
        eventId: String(order.id) + '-cat',
      });

      console.log('✅ CatPurchase → order ' + order.id);
    } catch (error) {
      console.error('❌ CatPurchase error:', error.message);
      results.catError = error.message;
    }
  }

  return res.status(200).json({
    success: true,
    orderId: order.id,
    results: results,
  });
};

module.exports.config = {
  api: {
    bodyParser: false,
  },
};
