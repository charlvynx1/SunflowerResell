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
function isOwner(id) { return id === OWNER; }
function isAdmin(id) { return db.admins.includes(id); }
function hasAccess(id) { return isOwner(id) || isAdmin(id) || (db.users[id] && db.users[id].is_whitelisted); }
function usdToMmk(usd) { return usd * USD_TO_MMK; }

async function callAPI(params) {
  const res = await fetch('https://shweboost.com/api/v2', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: process.env.SHWEBOOST_KEY, ...params }),
  });
  return await res.json();
}

async function getGroupOwnerId(ctx) {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return null;
  try {
    const admins = await ctx.telegram.getChatAdministrators(ctx.chat.id);
    const owner = admins.find(adm => adm.status === 'creator');
    return owner ? owner.user.id : null;
  } catch (e) { console.error(e); return null; }
}

async function groupOwnerOnly(ctx, next) {
  const ownerId = await getGroupOwnerId(ctx);
  if (ownerId === ctx.from.id) return next();
}
function ownerOnlyPrivate(ctx, next) {
  if (ctx.chat.type !== 'private') return;
  if (!isOwner(ctx.from.id)) return;
  return next();
}

// === OWNER/ADMIN COMMANDS ===
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
      try { await bot.telegram.sendMessage(Number(uid), `📢 ${text}`); count++; } catch {}
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
  if (!db.admins.includes(id)) db.admins.push(id);
  ctx.reply(`✅ User ${id} promoted to admin.`);
}));

bot.command('demote', ctx => ownerOnlyPrivate(ctx, () => {
  const [cmd, idStr] = ctx.message.text.split(' ');
  const id = Number(idStr);
  db.admins = db.admins.filter(adminId => adminId !== id);
  ctx.reply(`✅ User ${id} demoted from admin.`);
}));

bot.command('userlist', ctx => ownerOnlyPrivate(ctx, () => {
  const userIds = Object.keys(db.users);
  if (!userIds.length) return ctx.reply('ℹ️ No users found.');
  ctx.reply('👥 User IDs:\n' + userIds.join('\n'));
}));

bot.command('fetch', ctx => ownerOnlyPrivate(ctx, () => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) return ctx.reply('❌ Usage: /fetch <owner_tg_id> <owner_username>');
  const ownerId = parts[1], ownerUsername = parts[2].startsWith('@') ? parts[2] : '@' + parts[2];
  db.groupOwners[ownerId] = ownerUsername;
  ctx.reply(`✅ Stored group owner info:\nID: ${ownerId}\nUsername: ${ownerUsername}`);
}));

bot.command('listowners', ctx => ownerOnlyPrivate(ctx, () => {
  const owners = db.groupOwners;
  if (!owners || !Object.keys(owners).length) return ctx.reply('ℹ️ No group owners stored yet.');
  let msg = '📋 Stored Group Owners:\n';
  for (const [id, username] of Object.entries(owners)) msg += `ID: ${id}, Username: ${username}\n`;
  ctx.reply(msg);
}));

// === GROUP COMMANDS ===
bot.command('add', async ctx => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  await groupOwnerOnly(ctx, async () => {
    const parts = ctx.message.text.split(' ').slice(1); // remove '/add'
    if (!parts.length) return ctx.reply('❌ Usage: /add <link> <product_name> <qty> / <product_name> <qty> ...');

    const orders = [];
    let link = parts.shift();
    while (parts.length) {
      const [nameQty, ...rest] = parts;
      const [name, qty] = nameQty.split('/');
      const qtyNum = Number(qty || rest.shift());
      if (!name || !qtyNum) break;
      orders.push({ name, qty: qtyNum });
    }

    let receipt = `🛒 Order Summary:\n----------------\n`;
    let totalCost = 0;

    for (const { name, qty } of orders) {
      if (!db.services[name]) {
        receipt += `❌ Unknown service '${name}'\n`;
        continue;
      }
      if (!db.whitelist.includes(name) && !isOwner(ctx.from.id)) {
        receipt += `❌ '${name}' not allowed\n`;
        continue;
      }

      const svc = db.services[name];
      const cost = (svc.price_mmk * qty) / 1000;
      totalCost += cost;

      // Deduct balance if not owner
      if (!isOwner(ctx.from.id)) {
        const user = db.users[ctx.from.id] = db.users[ctx.from.id] || { balance: 0, is_whitelisted: false };
        if (user.balance < cost) {
          receipt += `❌ Insufficient balance for '${name}'\n`;
          continue;
        }
        user.balance -= cost;
      }

      const res = await callAPI({ action: 'add', service: svc.service_id, link, quantity: qty });
      receipt += `✅ ${name} x${qty} — ${cost} MMK — Order ID: ${res.order}\n`;
    }
    receipt += `----------------\nTotal Cost: ${totalCost} MMK`;
    ctx.reply(receipt);
  });
});

// Status & orders commands
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
      } catch { parts.push(`ID ${id}: Error fetching status`); }
    }
    ctx.reply(parts.join('\n'));
  });
});

// === USER COMMANDS ===
bot.start(async ctx => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id, username = ctx.from.username || '(no username)';
  if (!db.users[id]) {
    db.users[id] = { balance: 0, is_whitelisted: true };
    if (!db.whitelist.includes(id)) db.whitelist.push(id);
    [...db.admins, OWNER].forEach(async adminId => {
      try { await ctx.telegram.sendMessage(adminId, `👤 New user whitelisted:\nID: ${id}\nUsername: @${username}`); } catch {}
    });
    return ctx.reply('🎉 သင်သည် whitelist သို့ထည့်သွင်းပြီးဖြစ်ပါသည်။\n\nကျေးဇူးပြု၍ /recharge command ဖြင့် balance ထည့်ပါ။');
  }
  const user = db.users[id];
  if (!user.is_whitelisted) { user.is_whitelisted = true; if (!db.whitelist.includes(id)) db.whitelist.push(id); }
  ctx.reply(`👋 မင်္ဂလာပါ! သင်၏ ကျန်ရှိသော Balance: ${user.balance} MMK`);
});

// Recharge flow
const rechargeSessions = {};
bot.command('recharge', ctx => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id; rechargeSessions[id] = { step: 1 };
  ctx.reply('ထည့်လိုသည့်ပမာဏအားပို့ပေးပါ။\n500,1000,2000,...', Markup.inlineKeyboard([Markup.button.callback('Cancel ❌', 'recharge_cancel')]));
});
bot.action('recharge_cancel', async ctx => {
  const id = ctx.from.id;
  if (rechargeSessions[id]) { delete rechargeSessions[id]; await ctx.editMessageText('Recharge cancelled ❌'); } 
  else { await ctx.answerCbQuery('No active recharge.'); }
});
bot.on('message', async ctx => {
  const id = ctx.from.id;
  if (!rechargeSessions[id]) return;
  const session = rechargeSessions[id];
  if (session.step === 1) {
    const text = ctx.message.text;
    if (!text || !/^\d+$/.test(text)) return ctx.reply('❌ Please send a valid number');
    const amount = Number(text);
    const allowed = [500,1000,2000,5000,10000];
    if (!allowed.includes(amount)) return ctx.reply('❌ Allowed amounts are 500,1000,2000,5000,10000 only.');
    session.amount = amount; session.step = 2;
    return ctx.reply(`WavePay/Kpay info\nSend payment screenshot`, Markup.inlineKeyboard([Markup.button.callback('Cancel ❌', 'recharge_cancel')]));
  }
  if (session.step === 2 && ctx.message.photo) {
    const amount = session.amount; delete rechargeSessions[id];
    const adminId = OWNER; 
    const caption = `💰 Recharge request from user ${id}\nAmount: ${amount} MMK`;
    const buttons = Markup.inlineKeyboard([
      Markup.button.callback(`Confirm ✅ ${id}_${amount}`, `recharge_confirm_${id}_${amount}`),
      Markup.button.callback(`Failed ❌ ${id}_${amount}`, `recharge_failed_${id}_${amount}`)
    ]);
    const fileId = ctx.message.photo[ctx.message.photo.length-1].file_id;
    await ctx.telegram.sendPhoto(adminId, fileId, { caption, ...buttons });
    return ctx.reply('🔔 Payment proof sent to admin for confirmation.');
  }
});

// Confirm/Fail actions
bot.action(/recharge_confirm_(\d+)_(\d+)/, async ctx => {
  if (!isAdmin(ctx.from.id) && !isOwner(ctx.from.id)) return ctx.answerCbQuery('❌ Permission denied.');
  const [_, uidStr, amtStr] = ctx.match; const userId = Number(uidStr), amount = Number(amtStr);
  db.users[userId] = db.users[userId] || { balance: 0, is_whitelisted: true };
  db.users[userId].balance += amount;
  try { await ctx.telegram.sendMessage(userId, `✅ Recharge successful! +${amount} MMK`);
        await ctx.editMessageCaption(`✅ Recharge confirmed for user ${userId} amount ${amount} MMK.`); } catch {}
  await ctx.answerCbQuery('Recharge confirmed.');
});
bot.action(/recharge_failed_(\d+)_(\d+)/, async ctx => {
  if (!isAdmin(ctx.from.id) && !isOwner(ctx.from.id)) return ctx.answerCbQuery('❌ Permission denied.');
  const [_, uidStr, amtStr] = ctx.match; const userId = Number(uidStr), amount = Number(amtStr);
  try { await ctx.telegram.sendMessage(userId, `❌ Recharge failed.`); await ctx.editMessageCaption(`❌ Recharge failed for user ${userId} amount ${amount} MMK.`); } catch {}
  await ctx.answerCbQuery('Recharge failed marked.');
});

// === EXPRESS SERVER ===
bot.launch();
console.log('🤖 Bot started');
const app = express();
app.get('/', (req, res) => res.send('✅ CharlvynX Telegram Bot is alive!'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Express server running on port ${PORT}`));
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
