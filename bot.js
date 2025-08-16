// bot.js
// Telegram bot for ShweBoost API v2 – owner-only ordering with local JSON DB
// Requires: node 18+, npm i telegraf axios qs express

require('dotenv').config();
const { Telegraf } = require('telegraf');
const axios = require('axios');
const qs = require('qs');
const fs = require('fs');
const path = require('path');
const express = require('express');

// ==== ENV ====
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = String(process.env.OWNER_ID || '').trim(); // single owner ID
const SHWEBOOST_API_KEY = process.env.SHWEBOOST_API_KEY;
const TIMEZONE = process.env.TIMEZONE || 'Asia/Yangon';

// Validate env
if (!BOT_TOKEN || !OWNER_ID || !SHWEBOOST_API_KEY) {
  console.error('❌ Missing env. Required: BOT_TOKEN, OWNER_ID, SHWEBOOST_API_KEY');
  process.exit(1);
}

// ==== CONSTANTS ====
const API_URL = 'https://shweboost.com/api/v2';
const USD_TO_MMK = 2098; // fixed rate as requested
const DB_FILE = path.join(__dirname, 'db.json');

// ==== SIMPLE JSON DB ====
function defaultDB() {
  return {
    products: {
      // nameLower: { id: "serviceIdString", price_mmk_per_1k: number }
      // example: "instagram followers": { id: "101", price_mmk_per_1k: 2500 }
    },
    users: {
      // allowed users record-keeping (from /fetch); currently not used for auth
      // "123456789": "@username"
    },
    orders: [
      // { id: "12345", name: "Instagram Followers", qty: 1000, cost_mmk: 2098, link: "https://...", ts: 1712345678901 }
    ],
  };
}

function loadDB() {
  try {
    if (!fs.existsSync(DB_FILE)) {
      fs.writeFileSync(DB_FILE, JSON.stringify(defaultDB(), null, 2));
    }
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const data = JSON.parse(raw);
    // Ensure required keys
    return { ...defaultDB(), ...data };
  } catch (e) {
    console.error('DB load error:', e);
    return defaultDB();
  }
}

let DB = loadDB();
let saveTimeout = null;
function saveDB() {
  try {
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      fs.writeFileSync(DB_FILE, JSON.stringify(DB, null, 2));
    }, 150);
  } catch (e) {
    console.error('DB save error:', e);
  }
}

// ==== HELPERS ====
const bot = new Telegraf(BOT_TOKEN);
const app = express();

// Keep-alive (useful on Render)
const PORT = process.env.PORT || 3000;
app.get('/', (_req, res) => res.send('ShweBoost Telegram Bot is running'));
app.listen(PORT, () => console.log(`🌐 Express listening on :${PORT}`));

// Call ShweBoost API (form-encoded)
async function callAPI(params) {
  const body = { key: SHWEBOOST_API_KEY, ...params };
  const { data } = await axios.post(API_URL, qs.stringify(body), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    timeout: 20000,
  });
  return data;
}

// Owner guard (always enforce in groups; in DMs for owner-only commands)
function isOwner(ctx) {
  return ctx.from && String(ctx.from.id) === OWNER_ID;
}

function isGroup(ctx) {
  return ctx.chat && ['group', 'supergroup'].includes(ctx.chat.type);
}

// Format money
function fmtMMK(n) {
  try {
    const rounded = Math.round(n);
    return `${rounded.toLocaleString('en-US')} MMK`;
  } catch {
    return `${Math.round(n)} MMK`;
  }
}

// Monospace receipt block
function codeBlock(text) {
  return '```\n' + text + '\n```';
}

// Find product by name (case-insensitive)
function getProductByName(nameInput) {
  const key = String(nameInput).trim().toLowerCase();
  return DB.products[key] ? { name: nameInput, key, ...DB.products[key] } : null;
}

// Parse /post and /setprice arguments where the last token is numeric/id
function parseTrailingNumberOrId(argsText) {
  const parts = argsText.trim().split(/\s+/);
  if (parts.length < 2) return null;
  const tail = parts.pop();
  const head = parts.join(' ');
  return { head, tail };
}

// Get last N orders
function getLastNOrders(n) {
  const N = Math.max(1, Math.min(100, Number(n) || 1));
  const list = DB.orders.slice(-N).reverse();
  return list;
}

// Compute cost based on stored price per 1k
function calcCostMMK(pricePer1k, qty) {
  return (Number(pricePer1k) / 1000) * Number(qty);
}

// Prepare greedy matcher for multi-item parsing using known product names
function prepareNameMatcher() {
  const names = Object.keys(DB.products); // already lowercase
  // Sort by length desc to match the longest names first
  return names.sort((a, b) => b.length - a.length);
}

// Parse /add command:
// /add <link> <product name> <qty> [<product name> <qty> ...]
function parseAddCommand(text) {
  // Remove the command
  const rest = text.replace(/^\/add(@\w+)?\s+/i, '').trim();
  if (!rest) return { error: 'Missing arguments. Usage: /add <link> <product name> <qty> ...' };

  // First token is link (until first space)
  const spaceIdx = rest.indexOf(' ');
  if (spaceIdx === -1) {
    return { error: 'Missing product/qty. Usage: /add <link> <product name> <qty> ...' };
  }
  const link = rest.slice(0, spaceIdx).trim();
  const after = rest.slice(spaceIdx + 1).trim();

  if (!/^https?:\/\//i.test(link)) {
    // still allow non-http links, but warn
    // but per requirement: no preview anyway
  }

  // Now we need to parse pairs: <product name> <qty> using known product names
  const matcher = prepareNameMatcher();
  if (matcher.length === 0) {
    return { error: 'No products imported. Use /post and /setprice first.' };
  }

  let remaining = after.toLowerCase();
  const originalAfter = after; // keep for slicing names in original casing
  const items = [];
  let cursor = 0; // position in originalAfter for slicing original names

  // Strategy: scan remaining text, repeatedly find any known product name at the start,
  // then the next integer as qty.
  // But names can appear anywhere; we’ll search for a known name boundary followed by qty.
  // We do a progressive match from the left.
  while (remaining.trim().length > 0) {
    let matchedNameKey = null;
    let matchedNameStart = -1;
    let matchedNameEnd = -1;

    // Find the earliest occurrence (lowest index) among all names
    let earliest = { idx: Infinity, nameKey: null, length: 0 };
    for (const nk of matcher) {
      const idx = remaining.indexOf(nk);
      if (idx !== -1 && idx < earliest.idx) {
        earliest = { idx, nameKey: nk, length: nk.length };
      }
    }

    if (!earliest.nameKey || earliest.idx === Infinity) break;

    matchedNameKey = earliest.nameKey;
    matchedNameStart = earliest.idx;
    matchedNameEnd = earliest.idx + earliest.length;

    // Cut off text before the match (irrelevant tokens)
    const beforeCut = remaining.slice(0, matchedNameStart);
    const consumedBefore = beforeCut.length;
    remaining = remaining.slice(matchedNameStart);
    cursor += consumedBefore;

    // Now matched name is at start of remaining
    // Move cursor over name
    const consumedName = matchedNameEnd - matchedNameStart;
    const nameLower = remaining.slice(0, consumedName);
    remaining = remaining.slice(consumedName).trim();
    cursor += consumedName;

    // Extract original-cased name from originalAfter using cursor history
    // We know the length in lowercase equals length in original
    const originalName = originalAfter.slice(cursor - consumedName, cursor);

    // Next token must be a quantity integer
    const qtyMatch = remaining.match(/^(\d+)(\s+|$)/);
    if (!qtyMatch) {
      // If no qty follows, stop here
      break;
    }
    const qtyStr = qtyMatch[1];
    const qty = Number(qtyStr);
    remaining = remaining.slice(qtyMatch[0].length).trim();
    cursor += qtyMatch[0].length;

    items.push({ nameKey: matchedNameKey, displayName: originalName.trim(), qty });
  }

  if (items.length === 0) {
    return { error: 'Could not parse items. Make sure your product names match imported names and include quantities.' };
  }

  return { link, items };
}

// ==== COMMANDS ====

// /start (DM only meaningful, but we’ll allow everywhere)
bot.start(async (ctx) => {
  const who = isOwner(ctx) ? 'Owner' : 'User';
  await ctx.reply(
    `✅ Bot is active.\nRole: ${who}\nTimezone: ${TIMEZONE}\n\nGroup commands (Owner only):\n/add <link> <product> <qty> [...]\n/orders\n/orderinfo <number>\n\nDM Owner commands:\n/post <product name> <product id>\n/setprice <product name> <mmk per 1000>\n/services\n/fetch <tg id> <@username>\n/balance`,
    { disable_web_page_preview: true }
  );
});

// /services (DM owner) – list imported products & prices
bot.command('services', async (ctx) => {
  if (!isOwner(ctx)) return; // owner-only
  if (isGroup(ctx)) {
    // Allow owner to run anywhere if you prefer; here we reply but it's fine in group too
  }

  const names = Object.keys(DB.products);
  if (names.length === 0) {
    return ctx.reply('No products imported yet. Use /post and /setprice.', { disable_web_page_preview: true });
  }
  const lines = names
    .sort()
    .map((k) => {
      const p = DB.products[k];
      const title = k.replace(/\b\w/g, (c) => c.toUpperCase());
      const price = p.price_mmk_per_1k ? `${fmtMMK(p.price_mmk_per_1k)} / 1k` : 'price not set';
      return `${title} — id:${p.id} — ${price}`;
    })
    .join('\n');

  await ctx.reply(codeBlock(lines), { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
});

// /post <product name> <product id>  (DM owner)
bot.command('post', async (ctx) => {
  if (!isOwner(ctx)) return;
  const text = ctx.message.text || '';
  const args = text.replace(/^\/post(@\w+)?\s*/i, '');
  const parsed = parseTrailingNumberOrId(args);
  if (!parsed) {
    return ctx.reply('Usage: /post <product name> <product id>', { disable_web_page_preview: true });
  }
  const name = parsed.head.trim();
  const id = parsed.tail.trim();
  if (!name || !id) {
    return ctx.reply('Usage: /post <product name> <product id>', { disable_web_page_preview: true });
  }
  const key = name.toLowerCase();
  if (!DB.products[key]) DB.products[key] = { id: '', price_mmk_per_1k: 0 };
  DB.products[key].id = id;
  saveDB();
  return ctx.reply(`✅ Added/updated product:\n${name} → id ${id}`, { disable_web_page_preview: true });
});

// /setprice <product name> <mmk per 1000>  (DM owner)
bot.command('setprice', async (ctx) => {
  if (!isOwner(ctx)) return;
  const text = ctx.message.text || '';
  const args = text.replace(/^\/setprice(@\w+)?\s*/i, '');
  const parsed = parseTrailingNumberOrId(args);
  if (!parsed) {
    return ctx.reply('Usage: /setprice <product name> <mmk per 1000>', { disable_web_page_preview: true });
  }
  const name = parsed.head.trim();
  const priceStr = parsed.tail.trim();
  const price = Number(priceStr);
  if (!name || !Number.isFinite(price) || price <= 0) {
    return ctx.reply('Usage: /setprice <product name> <mmk per 1000>', { disable_web_page_preview: true });
  }
  const key = name.toLowerCase();
  if (!DB.products[key]) DB.products[key] = { id: '', price_mmk_per_1k: 0 };
  DB.products[key].price_mmk_per_1k = price;
  saveDB();
  return ctx.reply(`✅ Price set: ${name} → ${fmtMMK(price)} per 1k`, { disable_web_page_preview: true });
});

// /fetch <tg id> <@username>  (DM owner) – record-keeping
bot.command('fetch', async (ctx) => {
  if (!isOwner(ctx)) return;
  const text = ctx.message.text || '';
  const args = text.replace(/^\/fetch(@\w+)?\s*/i, '').trim();
  const m = args.match(/^(\d+)\s+(@?[A-Za-z0-9_]{5,})$/);
  if (!m) {
    return ctx.reply('Usage: /fetch <tg id> <@username>', { disable_web_page_preview: true });
  }
  const tgId = m[1];
  const username = m[2].startsWith('@') ? m[2] : '@' + m[2];
  DB.users[tgId] = username;
  saveDB();
  return ctx.reply(`✅ Recorded user: ${tgId} ${username}`, { disable_web_page_preview: true });
});

// /balance (DM owner) – show API balance (USD) + MMK conversion
bot.command('balance', async (ctx) => {
  if (!isOwner(ctx)) return;
  try {
    const res = await callAPI({ action: 'balance' });
    // Typical SMM response: { balance: "12.34", currency: "USD" }
    const usd = Number(res.balance || 0);
    const mmk = usd * USD_TO_MMK;
    await ctx.reply(
      codeBlock(`API Balance\nUSD : ${usd.toFixed(2)} ${res.currency || 'USD'}\nMMK : ${fmtMMK(mmk)}`),
      { parse_mode: 'MarkdownV2', disable_web_page_preview: true }
    );
  } catch (e) {
    await ctx.reply('❌ Failed to fetch balance.', { disable_web_page_preview: true });
  }
});

// /orders (group owner) – show recent orders (last 10)
bot.command('orders', async (ctx) => {
  if (!isGroup(ctx)) return; // Only meaningful in group per your design
  if (!isOwner(ctx)) return; // Owner-only in group

  if (DB.orders.length === 0) {
    return ctx.reply('No orders yet.', { disable_web_page_preview: true });
  }
  const list = DB.orders.slice(-10).reverse();
  const lines = list
    .map(
      (o) =>
        `OrderID : ${o.id || 'undefined'}\nOrderName: ${o.name}\nOrderQty : ${o.qty}\nOrderCost: ${fmtMMK(o.cost_mmk)}\n`
    )
    .join('\n');
  await ctx.reply(codeBlock(lines.trim()), { parse_mode: 'MarkdownV2', disable_web_page_preview: true });
});

// /orderinfo <number> (group owner) – last N orders with live status
bot.command('orderinfo', async (ctx) => {
  if (!isGroup(ctx)) return;
  if (!isOwner(ctx)) return;

  const text = ctx.message.text || '';
  const m = text.match(/^\/orderinfo(@\w+)?\s+(\d+)/i);
  if (!m) {
    return ctx.reply('Usage: /orderinfo <number>', { disable_web_page_preview: true });
  }
  const count = Number(m[2]);
  const list = getLastNOrders(count);
  if (list.length === 0) {
    return ctx.reply('No orders found.', { disable_web_page_preview: true });
  }

  // Fetch statuses in series (keeps it simple and avoids rate issues)
  const blocks = [];
  for (const o of list) {
    let statusText = 'Unknown';
    if (!o.id) {
      statusText = 'Failed (no order id)';
    } else {
      try {
        const res = await callAPI({ action: 'status', order: o.id });
        // Typical response: { status: 'Pending'|'Processing'|'Completed'|'Canceled', charge: '...', start_count: '...', remains: '...' }
        statusText = String(res.status || 'Unknown');
      } catch (_) {
        statusText = 'Status fetch failed';
      }
    }
    blocks.push(
      `OrderID   : ${o.id || 'undefined'}\nOrderCost : ${fmtMMK(o.cost_mmk)}\nStatus    : ${statusText}\n`
    );
  }

  await ctx.reply(codeBlock(`Last ${list.length} Orders:\n\n` + blocks.join('\n').trim()), {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true,
  });
});

// /add ... (group owner) – single or multiple orders
bot.command('add', async (ctx) => {
  if (!isGroup(ctx)) return; // per your design: ordering in group
  if (!isOwner(ctx)) return; // owner-only

  const text = ctx.message.text || '';
  const parsed = parseAddCommand(text);
  if (parsed.error) {
    return ctx.reply(parsed.error, { disable_web_page_preview: true });
  }

  const { link, items } = parsed;
  const receiptLines = [];
  receiptLines.push('Ordered Successfully✅');
  receiptLines.push(`Link.           : ${link}`);

  let totalCost = 0;
  const placedOrders = [];

  for (const it of items) {
    const prod = DB.products[it.nameKey];
    if (!prod || !prod.id) {
      // Missing mapping – treat as failed
      const cost = 0;
      receiptLines.push(`OrderName : ${it.displayName}`);
      receiptLines.push(`OrderID      : undefined`);
      receiptLines.push(`OrderQty    : ${it.qty}`);
      receiptLines.push(`OrderCost   : ${fmtMMK(cost)}`);
      receiptLines.push(''); // spacer
      // Store failed record (no id)
      DB.orders.push({
        id: undefined,
        name: it.displayName,
        qty: it.qty,
        cost_mmk: cost,
        link,
        ts: Date.now(),
      });
      continue;
    }

    // Compute cost from custom MMK/1k
    const pricePer1k = Number(prod.price_mmk_per_1k || 0);
    const itemCost = pricePer1k > 0 ? calcCostMMK(pricePer1k, it.qty) : 0;

    // Place real order
    let orderId = undefined;
    try {
      const res = await callAPI({
        action: 'add',
        service: prod.id,
        link: link,
        quantity: it.qty,
      });
      // Typical: { order: 123456 }
      orderId = res.order;
    } catch (e) {
      orderId = undefined;
    }

    // Accumulate receipt
    receiptLines.push(`OrderName : ${it.displayName}`);
    receiptLines.push(`OrderID      : ${orderId !== undefined ? orderId : 'undefined'}`);
    receiptLines.push(`OrderQty    : ${it.qty}`);
    receiptLines.push(`OrderCost   : ${fmtMMK(itemCost)}`);
    receiptLines.push('');

    // Store order record
    DB.orders.push({
      id: orderId,
      name: it.displayName,
      qty: it.qty,
      cost_mmk: itemCost,
      link,
      ts: Date.now(),
    });
    placedOrders.push({ orderId, cost: itemCost });
    totalCost += itemCost;
  }

  saveDB();

  receiptLines.push(`Total Cost - ${fmtMMK(totalCost)}`);

  await ctx.reply(codeBlock(receiptLines.join('\n')), {
    parse_mode: 'MarkdownV2',
    disable_web_page_preview: true, // IMPORTANT: no link preview
  });
});

// Fallback for unknown commands (ignore silently in groups if not owner)
bot.on('text', async (ctx) => {
  // No-op; helps keep bot quiet unless a command is used.
});

// Start polling
bot.launch().then(() => console.log('🤖 Bot started with Telegraf polling'));

// Graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
