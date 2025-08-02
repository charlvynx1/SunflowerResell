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
      groupOwners: {},      // For storing manual group owner info
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
  if (ownerId === ctx.from.id) {
    return next();
  } else {
    // silently ignore unauthorized group commands
    return;
  }
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
    { name: "view", service_id: "258", price: 50 },      // 500 MMK per 10k
    { name: "like", service_id: "182", price: 1000 },    // 1000 MMK per 1k
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

// === NEW /fetch command to store group owner info manually ===

bot.command('fetch', ctx => ownerOnlyPrivate(ctx, () => {
  const parts = ctx.message.text.split(' ');
  if (parts.length < 3) {
    return ctx.reply('❌ Usage: /fetch <owner_tg_id> <owner_username>');
  }
  const ownerId = parts[1];
  const ownerUsername = parts[2].startsWith('@') ? parts[2] : '@' + parts[2];

  db.groupOwners[ownerId] = ownerUsername;
  ctx.reply(`✅ Stored group owner info:\nID: ${ownerId}\nUsername: ${ownerUsername}`);
}));

bot.command('listowners', ctx => ownerOnlyPrivate(ctx, () => {
  const owners = db.groupOwners;
  if (!owners || Object.keys(owners).length === 0) {
    return ctx.reply('ℹ️ No group owners stored yet.');
  }
  let msg = '📋 Stored Group Owners:\n';
  for (const [id, username] of Object.entries(owners)) {
    msg += `ID: ${id}, Username: ${username}\n`;
  }
  ctx.reply(msg);
}));

// === GROUP COMMANDS — only group owner (dynamic) can run these in groups ===

bot.command('add', async ctx => {
  if (ctx.chat.type !== 'group' && ctx.chat.type !== 'supergroup') return;

  await groupOwnerOnly(ctx, async () => {
    const [s, link, name, qty] = ctx.message.text.split(' ');
    if (!link || !name || !qty) return ctx.reply('❌ Usage: /add <link> <service_name> <quantity>');

    if (!db.whitelist.includes(name) && !isOwner(ctx.from.id)) {
      return ctx.reply(`❌ '${name}' is not allowed.`);
    }

    const svc = db.services[name];
    if (!svc) return ctx.reply('❌ Unknown service.');

    const needed = (svc.price_mmk * Number(qty)) / 1000;

    // Deduct balance if not owner
    if (!isOwner(ctx.from.id)) {
      const user = db.users[ctx.from.id] = db.users[ctx.from.id] || { balance: 0, is_whitelisted: false };
      if (user.balance < needed) {
        return ctx.reply(`❌ Insufficient balance. Required: ${needed} MMK`);
      }
      user.balance -= needed;
    }

    const res = await callAPI({
      action: 'add',
      service: svc.service_id,
      link,
      quantity: qty
    });

    const receiptMsg = `Order placed successfully ✅
-----------------------
Order ID: ${res.order}
Link used: ${link}
Cost: ${needed} MMK
----Sunflower----
Owner - @Shiao_Riua🌻`;

    ctx.reply(receiptMsg);
  });
});

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

// === HELP & SERVICES COMMANDS (only in private chat for owner) ===

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

// === BALANCE command: owner/admin sees API balance + all users; user sees own balance (only in private chat) ===

bot.command('balance', async ctx => {
  if (ctx.chat.type !== 'private') return;  // Only in private chat

  const id = ctx.from.id;

  if (isOwner(id) || isAdmin(id)) {
    // Show API balance + all users' balances
    const res = await callAPI({ action: 'balance' });
    let msg = `💰 API balance: ${usdToMmk(Number(res.balance))} MMK\n\n📊 Users:\n`;
    for (const [uid, user] of Object.entries(db.users)) {
      msg += `${uid}: ${user.balance} MMK\n`;
    }
    return ctx.reply(msg);
  }

  // Normal user balance
  const user = db.users[id];
  const bal = user ? user.balance : 0;
  ctx.reply(`💰 Your balance: ${bal} MMK`);
});

// === START command ===
bot.start(async ctx => {
  if (ctx.chat.type !== 'private') return;  // Only respond in private chat

  const id = ctx.from.id;
  const username = ctx.from.username || '(no username)';

  if (!db.users[id]) {
    // New user: add to db and whitelist
    db.users[id] = { balance: 0, is_whitelisted: true };
    if (!db.whitelist.includes(id)) db.whitelist.push(id);

    // Notify admins + owner about new user
    const adminsAndOwner = [...db.admins, OWNER];
    for (const adminId of adminsAndOwner) {
      try {
        await ctx.telegram.sendMessage(adminId, `👤 New user whitelisted:\nID: ${id}\nUsername: @${username}`);
      } catch {}
    }

    return ctx.reply(
      '🎉 သင်သည် whitelist သို့ထည့်သွင်းပြီးဖြစ်ပါသည်။\n\nကျေးဇူးပြု၍ /recharge command ဖြင့် balance ထည့်ပါ။'
    );
  }

  // Existing user
  const user = db.users[id];
  if (!user.is_whitelisted) {
    user.is_whitelisted = true;
    if (!db.whitelist.includes(id)) db.whitelist.push(id);
  }

  ctx.reply(`👋 မင်္ဂလာပါ! သင်၏ ကျန်ရှိသော Balance: ${user.balance} MMK`);
});

// === RECHARGE FLOW (only in private chat) ===
const rechargeSessions = {};

bot.command('recharge', ctx => {
  if (ctx.chat.type !== 'private') return;
  const id = ctx.from.id;
  rechargeSessions[id] = { step: 1 };
  ctx.reply(
    `ထည့်လိုသည့်ပမာဏအားပို့ပေးပါ။
သတိပြုရန် - အင်္ဂလိပ်ဂဏန်းဖြင့် ထည့်လိုသည့်ပမာဏ 500,1000,2000, etc. သာပို့ပေးပါရန်`,
    Markup.inlineKeyboard([
      Markup.button.callback('Cancel ❌', 'recharge_cancel'),
    ])
  );
});

bot.action('recharge_cancel', async ctx => {
  const id = ctx.from.id;
  if (rechargeSessions[id]) {
    delete rechargeSessions[id];
    await ctx.editMessageText('Recharge cancelled ❌');
  } else {
    await ctx.answerCbQuery('No active recharge.');
  }
});

bot.on('message', async ctx => {
  const id = ctx.from.id;
  if (!rechargeSessions[id]) return;

  const session = rechargeSessions[id];

  if (session.step === 1) {
    const text = ctx.message.text;
    if (!text || !/^\d+$/.test(text)) {
      return ctx.reply('❌ Please send a valid number amount (e.g., 500, 1000)');
    }
    const amount = Number(text);
    const allowedAmounts = [500, 1000, 2000, 5000, 10000];
    if (!allowedAmounts.includes(amount)) {
      return ctx.reply('❌ Allowed amounts are 500, 1000, 2000, 5000, 10000 only.');
    }
    session.amount = amount;
    session.step = 2;
    return ctx.reply(
      `သင်ထည့်လိုသည့်ပမာဏ ${amount} အားပြီးမြောက်ရန်\n
WavePay - Khaing Pa Pa Linn
Ph No. - 09973117681

Kpay - San San Oo
Ph No. - 095062099

Note - Shop/Shopping ဖြင့် ငွေအတိအကျလွှဲပြီး ငွေလွှဲပြေစာအား ပုံပို့ပေးပါ`,
      Markup.inlineKeyboard([
        Markup.button.callback('Cancel ❌', 'recharge_cancel'),
      ])
    );
  }

  if (session.step === 2 && ctx.message.photo) {
    const amount = session.amount;
    delete rechargeSessions[id]; // clear session

    const adminId = 7573683327;
    const caption = `💰 Recharge request from user ${id}\nAmount: ${amount} MMK`;

    const buttons = Markup.inlineKeyboard([
      Markup.button.callback(`Confirm Recharging ✅ ${id} ${amount}`, `recharge_confirm_${id}_${amount}`),
      Markup.button.callback(`Failed ❌ ${id} ${amount}`, `recharge_failed_${id}_${amount}`)
    ]);

    // Get largest photo file_id
    const photoArray = ctx.message.photo;
    const fileId = photoArray[photoArray.length - 1].file_id;

    await ctx.telegram.sendPhoto(adminId, fileId, { caption, ...buttons });
    return ctx.reply('🔔 Payment proof sent to admin for confirmation.');
  }

  if (session.step === 2 && !ctx.message.photo) {
    return ctx.reply('❌ Please send a photo of payment proof or tap Cancel.');
  }
});

bot.action(/recharge_confirm_(\d+)_(\d+)/, async ctx => {
  if (!isAdmin(ctx.from.id) && !isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('❌ Permission denied.');
  }
  const [_, userIdStr, amountStr] = ctx.match;
  const userId = Number(userIdStr);
  const amount = Number(amountStr);

  db.users[userId] = db.users[userId] || { balance: 0, is_whitelisted: true };
  db.users[userId].balance += amount;

  try {
    await ctx.telegram.sendMessage(userId, `✅ Recharge successful! Your balance has increased by ${amount} MMK.`);
    await ctx.editMessageCaption(`✅ Recharge confirmed for user ${userId} amount ${amount} MMK.`);
  } catch (e) {
    console.error(e);
  }
  await ctx.answerCbQuery('Recharge confirmed.');
});

bot.action(/recharge_failed_(\d+)_(\d+)/, async ctx => {
  if (!isAdmin(ctx.from.id) && !isOwner(ctx.from.id)) {
    return ctx.answerCbQuery('❌ Permission denied.');
  }
  const [_, userIdStr, amountStr] = ctx.match;
  const userId = Number(userIdStr);
  const amount = Number(amountStr);

  try {
    await ctx.telegram.sendMessage(userId, `❌ Recharge failed. Please try again or contact support.`);
    await ctx.editMessageCaption(`❌ Recharge marked failed for user ${userId} amount ${amount} MMK.`);
  } catch (e) {
    console.error(e);
  }
  await ctx.answerCbQuery('Recharge failed marked.');
});

// === Launch bot and express server ===

bot.launch();
console.log('🤖 Bot started');

const app = express();
app.get('/', (req, res) => {
  res.send('✅ CharlvynX Telegram Bot is alive!');
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Graceful shutdown
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
