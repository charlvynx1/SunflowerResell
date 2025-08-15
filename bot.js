require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const fetch = require('node-fetch');
const fs = require('fs-extra');
const express = require('express');

const bot = new Telegraf(process.env.BOT_TOKEN);
const OWNER = Number(process.env.OWNER_ID);
let USD_TO_MMK = Number(process.env.USD_TO_MMK || 2100);

// === DATABASE ===
const DB_PATH = './db.json';
const db = fs.existsSync(DB_PATH)
  ? fs.readJSONSync(DB_PATH)
  : {
      services: {},
      whitelist: [],
      users: {},
      custom_prices: {},
      admins: [],
      groupOwners: {},
    };

// Auto-save db.json every 5 seconds
setInterval(() => {
  fs.writeJSONSync(DB_PATH, db, { spaces: 2 });
}, 5000);

// === HELPERS ===
function isOwner(id) {
  return id === OWNER;
}

function isAdmin(id) {
  return db.admins.includes(id);
}

function hasAccess(id) {
  return isOwner(id) || isAdmin(id) || (db.users[id] && db.users[id].is_whitelisted);
}

function usdToMmk(usd) {
  return usd * USD_TO_MMK;
}

async function callAPI(params) {
  const res = await fetch('https://shweboost.com/api/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: process.env.SHWEBOOST_KEY, ...params }),
  });
  return await res.json();
}

// Get group owner ID dynamically from Telegram API
async function getGroupOwnerId(ctx) {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return null;
  try {
    const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
    const owner = admins.find(adm => adm.status === 'creator');
    return owner ? owner.user.id : null;
  } catch (e) {
    console.error('Error fetching chat administrators:', e);
    return null;
  }
}

// Middleware helper: only group owner can run group commands
async function groupOwnerOnly(ctx, next) {
  const ownerId = await getGroupOwnerId(ctx);
  if (ownerId === ctx.from.id) return next();
}

// Middleware helper: only owner in private chat for sensitive commands
function ownerOnlyPrivate(ctx, next) {
  if (ctx.chat.type !== 'private') return;
  if (!isOwner(ctx.from.id)) return;
  return next();
}

// === OWNER-ONLY COMMANDS IN PRIVATE CHAT ===
bot.command('post', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, serviceId, name] = ctx.message.text.split(' ');
  if (!serviceId || !name) return ctx.reply('Usage: /post <service_id> <name>');
  db.services[name] = { service_id: serviceId, price_mmk: 0 };
  ctx.reply(`✅ Service '${name}' posted.`);
}));

bot.command('setprice', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, name, price] = ctx.message.text.split(' ');
  if (!name || !price) return ctx.reply('Usage: /setprice <name> <price>');
  if (!db.services[name]) return ctx.reply('❌ Unknown service.');
  db.services[name].price_mmk = Number(price);
  ctx.reply(`✅ '${name}' price set to ${price} MMK/1k`);
}));

bot.command('wl', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, name] = ctx.message.text.split(' ');
  if (!name) return ctx.reply('Usage: /wl <service_name>');
  if (!db.services[name]) return ctx.reply('❌ Unknown service.');
  if (!db.whitelist.includes(name)) db.whitelist.push(name);
  ctx.reply(`✅ '${name}' whitelisted.`);
}));

bot.command('unwl', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, name] = ctx.message.text.split(' ');
  if (!name) return ctx.reply('Usage: /unwl <service_name>');
  db.whitelist = db.whitelist.filter(n => n !== name);
  ctx.reply(`✅ '${name}' removed from whitelist.`);
}));

bot.command('adduser', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, id] = ctx.message.text.split(' ');
  if (!id) return ctx.reply('Usage: /adduser <tg_id>');
  const uid = Number(id);
  db.users[uid] = db.users[uid] || { balance: 0, is_whitelisted: true };
  db.users[uid].is_whitelisted = true;
  ctx.reply(`✅ User ${id} whitelisted.`);
}));

bot.command('addbalance', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, id, amt] = ctx.message.text.split(' ');
  if (!id || !amt) return ctx.reply('Usage: /addbalance <tg_id> <amount>');
  const uid = Number(id), a = Number(amt);
  db.users[uid] = db.users[uid] || { balance: 0, is_whitelisted: false };
  db.users[uid].balance += a;
  ctx.reply(`✅ Added ${a} MMK to user ${id}.`);
}));

bot.command('setrate', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, rate] = ctx.message.text.split(' ');
  if (!rate) return ctx.reply('Usage: /setrate <rate>');
  USD_TO_MMK = Number(rate);
  ctx.reply(`✅ Exchange rate set to ${USD_TO_MMK} MMK/USD`);
}));

bot.command('send', ctx => ownerOnlyPrivate(ctx, () => {
  const [s, id, ...rest] = ctx.message.text.split(' ');
  if (!id || rest.length === 0) return ctx.reply('Usage: /send <tg_id> <message>');
  const msg = rest.join(' ');
  ctx.telegram.sendMessage(Number(id), msg);
  ctx.reply('✅ Message sent.');
}));

bot.command('broadcast', ctx => ownerOnlyPrivate(async () => {
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('❌ Usage: /broadcast <message>');

  let count = 0;
  for (const [uid, user] of Object.entries(db.users)) {
    if (user.is_whitelisted) {
      try {
        await bot.telegram.sendMessage(Number(uid), `📢 ${text}`);
        count++;
      } catch {}
    }
  }
  ctx.reply(`✅ Broadcast sent to ${count} users.`);
}));

bot.command('load', ctx => ownerOnlyPrivate(ctx, () => {
  const presets = [
    { name: "view", service_id: "258", price: 50 },
    { name: "like", service_id: "182", price: 1000 },
  ];

  presets.forEach(({ name, service_id, price }) => {
    db.services[name] = { service_id, price_mmk: price };
    if (!db.whitelist.includes(name)) db.whitelist.push(name);
  });

  ctx.reply("✅ Preset services loaded:\n- view (500 MMK/10k)\n- like (1000 MMK/1k)");
}));

bot.command('promote', ctx => ownerOnlyPrivate(ctx, () => {
  const [cmd, idStr] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('❌ Invalid TG ID.');
  if (!db.admins.includes(id)) {
    db.admins.push(id);
    ctx.reply(`✅ User ${id} promoted to admin.`);
  } else {
    ctx.reply(`ℹ️ User ${id} is already an admin.`);
  }
}));

bot.command('demote', ctx => ownerOnlyPrivate(ctx, () => {
  const [cmd, idStr] = ctx.message.text.split(' ');
  const id = Number(idStr);
  if (!id) return ctx.reply('❌ Invalid TG ID.');
  db.admins = db.admins.filter(adminId => adminId !== id);
  ctx.reply(`✅ User ${id} demoted from admin.`);
}));

bot.command('userlist', ctx => ownerOnlyPrivate(ctx, () => {
  const userIds = Object.keys(db.users);
  if (userIds.length === 0) return ctx.reply('ℹ️ No users found.');
  ctx.reply('👥 User IDs:\n' + userIds.join('\n'));
}));

// === NEW /fetch & /listowners commands ===
bot.command('fetch', ctx => ownerOnlyPrivate(ctx, () => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('❌ Usage: /fetch <owner_tg_id> <owner_username>');
  const ownerId = parts[1];
  const ownerUsername = parts[2].startsWith('@') ? parts[2] : '@' + parts[2];
  db.groupOwners[ownerId] = ownerUsername;
  ctx.reply(`✅ Stored group owner info:\nID: ${ownerId}\nUsername: ${ownerUsername}`);
}));

bot.command('listowners', ctx => ownerOnlyPrivate(ctx, () => {
  const owners = db.groupOwners;
  if (!owners || Object.keys(owners).length === 0) return ctx.reply('ℹ️ No group owners stored yet.');
  let msg = '📋 Stored Group Owners:\n';
  for (const [id, username] of Object.entries(owners)) msg += `ID: ${id}, Username: ${username}\n`;
  ctx.reply(msg);
}));

// === MULTI-ORDER /add command ===
bot.command('add', async ctx => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  await groupOwnerOnly(ctx, async () => {
    const text = ctx.message.text.split(' ').slice(1).join(' ').trim();
    if (!text) return ctx.reply('❌ Usage: /add <link1> <service1> <qty1>, <link2> <service2> <qty2>, ...');

    const ordersRaw = text.split(',');
    const orders = [];
    let totalCost = 0;

    for (let raw of ordersRaw) {
      const parts = raw.trim().split(' ');
      if (parts.length < 3) return ctx.reply(`❌ Invalid order format: ${raw}`);
      const [link, name, qtyStr] = parts;
      const qty = Number(qtyStr);
      if (!link || !name || !qty || qty <= 0) return ctx.reply(`❌ Invalid order details: ${raw}`);

      if (!db.whitelist.includes(name) && !isOwner(ctx.from.id)) return ctx.reply(`❌ '${name}' is not allowed.`);
      const svc = db.services[name];
      if (!svc) return ctx.reply(`❌ Unknown service: ${name}`);

      const cost = (svc.price_mmk * qty) / 1000;
      totalCost += cost;
      orders.push({ link, name, qty, service_id: svc.service_id, cost });
    }

    if (!isOwner(ctx.from.id)) {
      const user = db.users[ctx.from.id] = db.users[ctx.from.id] || { balance: 0, is_whitelisted: false };
      if (user.balance < totalCost) return ctx.reply(`❌ Insufficient balance. Required: ${totalCost} MMK`);
      user.balance -= totalCost;
    }

    const receipts = [];
    for (let order of orders) {
      try {
        const res = await callAPI({
          action: 'add',
          service: order.service_id,
          link: order.link,
          quantity: order.qty
        });
        receipts.push(`Order ID: ${res.order}\nService: ${order.name}\nLink: ${order.link}\nQuantity: ${order.qty}\nCost: ${order.cost} MMK`);
      } catch (e) {
        receipts.push(`❌ Failed to place order for ${order.name} (${order.link})`);
      }
    }

    const receiptMsg = `📋 Orders placed successfully ✅\n-----------------------\n${receipts.join('\n-----------------------\n')}\n\n💰 Total cost: ${totalCost} MMK\n----Sunflower----\nOwner - @Shiao_Riua🌻`;
    ctx.reply(receiptMsg);
  });
});

// === STATUS / ORDERS commands (group only) ===
bot.command('status', async ctx => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  await groupOwnerOnly(ctx, async () => {
    const id = ctx.message.text.split(' ')[1];
    if (!id) return ctx.reply('❌ Usage: /status <order_id>');
    const res = await callAPI({ action: 'status', order: id });
    const mmk = usdToMmk(Number(res.charge));
    ctx.reply(`📦 ID ${id} — Status: ${res.status}, Charge: ${mmk} MMK`);
  });
});

bot.command('orders', async ctx => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  await groupOwnerOnly(ctx, async () => {
    const idsText = ctx.message.text.split(' ')[1];
    if (!idsText) return ctx.reply('❌ Usage: /orders <id1,id2,...>');
    const ids = idsText.split(',');
    const parts = [];

    for (let id of ids) {
      try {
        const res = await callAPI({ action: 'status', order: id });
        const mmk = usdToMmk(Number(res.charge));
        parts.push(`ID ${id}: ${res.status}, ${mmk} MMK`);
      } catch (e) {
        parts.push(`ID ${id}: Error fetching status`);
      }
    }

    ctx.reply(parts.join('\n'));
  });
});

// === PRIVATE HELP & SERVICE COMMANDS ===
bot.command('services', ctx => ownerOnlyPrivate(ctx, () => {
  if (Object.keys(db.services).length === 0) return ctx.reply('ℹ️ No services available.');
  const lines = Object.entries(db.services).map(([name, svc]) => {
    const display = name === 'view'
      ? `${svc.price_mmk * 10} MMK /10k`
      : `${svc.price_mmk} MMK /1k`;
    return `${name} — ${display}`;
  });
  ctx.reply('📦 Services:\n' + lines.join('\n'));
}));

bot.command('wl_list', ctx => ownerOnlyPrivate(ctx, () => {
  if (db.whitelist.length === 0) return ctx.reply('ℹ️ No whitelisted services.');
  ctx.reply(`✅ Whitelisted services:\n${db.whitelist.join('\n')}`);
}));

bot.command('balance', async ctx => {
  if (ctx.chat.type !== 'private') return;

  const id = ctx.from.id;

  if (isOwner(id) || isAdmin(id)) {
    const res = await callAPI({ action: 'balance' });
    let msg = `💰 API balance: ${usdToMmk(Number(res.balance))} MMK\n\n📊 Users:\n`;
    for (const [uid, user] of Object.entries(db.users)) msg += `${uid}: ${user.balance} MMK\n`;
    return ctx.reply(msg);
  }

  const user = db.users[id];
  const bal = user ? user.balance : 0;
  ctx.reply(`💰 Your balance: ${bal} MMK`);
});

// === START & RECHARGE FLOW ===
const rechargeSessions = {};

bot.start(async ctx => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  const username = ctx.from.username || '(no username)';

  if (!db.users[id]) {
    db.users[id] = { balance: 0, is_whitelisted: true };
    if (!db.whitelist.includes(id)) db.whitelist.push(id);

    const adminsAndOwner = [...db.admins, OWNER];
    for (const adminId of adminsAndOwner) {
      try { await ctx.telegram.sendMessage(adminId, `👤 New user whitelisted:\nID: ${id}\nUsername: @${username}`); } catch {}
    }

    return ctx.reply('🎉 သင်သည် whitelist သို့ထည့်သွင်းပြီးဖြစ်ပါသည်။\n\nကျေးဇူးပြု၍ /recharge command ဖြင့် balance ထည့်ပါ။');
  }

  const user = db.users[id];
  if (!user.is_whitelisted) {
    user.is_whitelisted = true;
    if (!db.whitelist.includes(id)) db.whitelist.push(id);
  }

  ctx.reply(`👋 မင်္ဂလာပါ! သင်၏ ကျန်ရှိသော Balance: ${user.balance} MMK`);
});

bot.command('recharge', ctx => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  rechargeSessions[id] = { step: 1 };
  ctx.reply(
    `ထည့်လိုသည့်ပမာဏအားပို့ပေးပါ။`,
    Markup.inlineKeyboard([ Markup.button.callback('Cancel ❌', 'recharge_cancel') ])
  );
});

bot.action('recharge_cancel', async ctx => {
  const id = ctx.from.id;
  if (rechargeSessions[id]) {
    delete rechargeSessions[id];
    await ctx.editMessageText('Recharge cancelled ❌');
  } else await ctx.answerCbQuery('No active recharge.');
});

bot.on('message', async ctx => {
  const id = ctx.from.id;
  if (!rechargeSessions[id]) return;
  const session = rechargeSessions[id];

  if (session.step === 1) {
    const text = ctx.message.text;
    if (!text || !/^\d+$/.test(text)) return ctx.reply('❌ Please send a valid number amount.');
    const amount = Number(text);
    const allowedAmounts = [500, 1000, 2000, 5000, 10000];
    if (!allowedAmounts.includes(amount)) return ctx.reply('❌ Allowed amounts: 500,1000,2000,5000,10000');
    session.amount = amount;
    session.step = 2;
    return ctx.reply(
      `Send payment proof for ${amount} MMK`,
      Markup.inlineKeyboard([ Markup.button.callback('Cancel ❌', 'recharge_cancel') ])
    );
  }

  if (session.step === 2 && ctx.message.photo) {
    const amount = session.amount;
    delete rechargeSessions[id];
    const adminId = 7573683327;
    const caption = `💰 Recharge request from user ${id}\nAmount: ${amount} MMK`;
    const buttons = Markup.inlineKeyboard([
      Markup.button.callback(`Confirm ✅ ${id} ${amount}`, `recharge_confirm ${id} ${amount}`),
      Markup.button.callback(`Cancel ❌ ${id}`, `recharge_reject ${id}`)
    ]);
    await ctx.telegram.sendPhoto(adminId, ctx.message.photo[0].file_id, { caption, ...buttons });
    return ctx.reply('✅ Payment proof sent to admin.');
  }
});

// === Recharge Confirm/Reject ===
bot.action(/recharge_confirm (\d+) (\d+)/, async ctx => {
  const [_, uidStr, amtStr] = ctx.match;
  const uid = Number(uidStr);
  const amt = Number(amtStr);
  db.users[uid] = db.users[uid] || { balance: 0, is_whitelisted: true };
  db.users[uid].balance += amt;
  await ctx.editMessageText(`✅ Recharge confirmed for user ${uid}, +${amt} MMK`);
  try { await ctx.telegram.sendMessage(uid, `💰 Recharge successful: +${amt} MMK`); } catch {}
});

bot.action(/recharge_reject (\d+)/, async ctx => {
  const uid = Number(ctx.match[1]);
  await ctx.editMessageText(`❌ Recharge rejected for user ${uid}`);
  try { await ctx.telegram.sendMessage(uid, `❌ Your recharge was rejected`); } catch {}
});

// === LAUNCH BOT ===
bot.launch();
console.log('✅ Bot is running...');

// === EXPRESS (optional webhook) ===
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Bot is running!'));
app.listen(PORT, () => console.log(`🌐 Express server running on port ${PORT}`));
