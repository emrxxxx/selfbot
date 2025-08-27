const axios = require('axios');
const { Client, Intents } = require('discord.js-selfbot-v13');
const config = require('./config/config.json');
const { logPre } = require('./modules/logger');

// Yapılandırma ve Sabitler
const token = process.argv[2];
const { 
    CH_IDS: initialChannelIds = [], 
    owo_ID, 
    reaction_ID, 
    webhookUrl, 
    webhookUrls: configWebhookUrls = [], 
    DEFAULT_PRESENCE = 'invisible' 
} = config;

const DELAYS = {
    TYPING: { MIN: 200, MAX: 1000 },           // Yazma efekti gecikmesi
    MESSAGE: { MIN: 200, MAX: 500 },           // Mesaj gönderme gecikmesi
    OWO: { MIN: 11000, MAX: 15000 },           // "Owo" komutu arası gecikme
    WHWB: { MIN: 16000, MAX: 20000 },          // "Owo h" ve "Owo b" komutları arası gecikme
    SLEEP: { MIN: 30000, MAX: 60000 },         // Rastgele uyuma gecikmesi
    CHANNEL_CYCLE: { MIN: 600000, MAX: 900000 }, // Kanal değiştirme aralığı (10-15 dakika)
    COMMAND_DELETE: { MIN: 300, MAX: 800 },    // Komut mesajlarını silme gecikmesi
    STATUS_MESSAGE_DELETE: 30000,              // Durum mesajını silme süresi (30 sn)
    INFO_MESSAGE_DELETE: 15000,                // Bilgi mesajını silme süresi (15 sn)
    CAPTCHA_WEBHOOK_DELETE: 10 * 60 * 1000     // Captcha webhook mesajını silme süresi (10 dakika)
};

const PROBABILITIES = {
    SLEEP: 0.016,    // Rastgele uyuma olasılığı (~%1.6)
    TYPING: 0.28     // Yazma efekti gösterme olasılığı (%28)
};

// Captcha anahtar kelimeleri (küçük harfe çevrilerek kontrol edilir)
const CAPTCHA_KEYWORDS = ['captcha', 'verify', 'real', 'human?', 'ban', 'banned', 'suspend', 'complete verification'];
const ERROR_WEBHOOK_USERNAME = 'Bot Hatası';
const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// Bot Durumu
let botState = {
    isRunning: false,                    // Bot çalışıyor mu?
    isOwoEnabled: false,                 // OwO/WhWb farming aktif mi?
    isSleeping: false,                   // Bot şu anda uyuyor mu?
    captchaDetected: false,              // Captcha algılandı mı?
    isProcessingOwo: false,              // "Owo" döngüsü çalışıyor mu?
    isProcessingWhWb: false,             // "WhWb" döngüsü çalışıyor mu?
    isCaptchaDmHandlerEnabled: true,     // Captcha DM dinleyicisi aktif mi?
    currentChannelIndex: 0,              // Mevcut kanal indeksi
    channelIds: [...initialChannelIds],  // Farming yapılacak kanal ID'leri
    // voiceConnection alanı kaldırıldı
    captchaWebhookMessages: [],          // Webhook ile gönderilen captcha mesajlarının ID'leri (silme için)
    captchaWebhookDeleteTimer: null      // Captcha mesajlarını otomatik silmek için zamanlayıcı
};

// Doğrulama
if (!token) {
    console.error('Token sağlanmadı!');
    process.exit(1);
}
if (!Array.isArray(initialChannelIds) || initialChannelIds.length === 0) {
    console.error('config.json CH_IDS eksik veya geçersiz!');
    process.exit(1);
}

let activeWebhookUrls = configWebhookUrls.filter(url => typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/'));
if (activeWebhookUrls.length === 0 && typeof webhookUrl === 'string' && webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    activeWebhookUrls = [webhookUrl];
}

// Utility Functions
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const getCurrentChannelId = () => botState.channelIds[botState.currentChannelIndex];
const shouldRunLoop = (loopType = 'any') => {
    if (!botState.isRunning || botState.isSleeping || botState.captchaDetected || !client?.user) return false;
    if (loopType === 'owo' && (!botState.isOwoEnabled || botState.isProcessingWhWb)) return false;
    if (loopType === 'whwb' && (!botState.isOwoEnabled || botState.isProcessingOwo)) return false;
    return true;
};
const parseWebhookUrl = (url) => {
    const match = url.match(/webhooks\/(\d+)\/([^\/?]+)/);
    return match && match.length === 3 ? { id: match[1], token: match[2] } : null;
};

// Discord Client
const client = new Client({
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } }
});

// Core Functions
async function updateBotStatus() {
    if (!client?.user) return;

    let newStatus;
    if (botState.captchaDetected) newStatus = 'dnd'; // Captcha varsa rahatsız etmeyin
    else if (!botState.isRunning) newStatus = 'idle'; // Durdurulduysa boşta
    else if (botState.isOwoEnabled) newStatus = 'online'; // Farming aktifse çevrimiçi
    else newStatus = DEFAULT_PRESENCE; // Varsayılan durum

    try {
        await client.user.setPresence({ status: newStatus });
        console.log(`Durum güncellendi: ${newStatus}`);
    } catch (error) {
        console.log(`Durum güncellenemedi: ${error.message}`);
    }
}

async function safeDeleteMessage(message, delayMs = 0) {
    if (!message || typeof message.delete !== 'function') return;
    const del = () => message.delete().catch(e => {});
    if (delayMs > 0) setTimeout(del, delayMs);
    else await del();
}

async function getChannel(channelId) {
    if (!channelId) return null;
    try {
        return client.channels.cache.get(channelId) || await client.channels.fetch(channelId);
    } catch (error) {
        return null;
    }
}

async function getChannelName(channelId) {
    const channel = await getChannel(channelId);
    return channel?.name || `ID_${channelId}`;
}

async function sendTyping(channelId) {
    if (Math.random() >= PROBABILITIES.TYPING) return;
    const channel = await getChannel(channelId);
    if (channel?.isText() && channel.type !== 'GUILD_FORUM') {
        try {
            await channel.sendTyping();
            await delay(getRandomInt(DELAYS.TYPING.MIN, DELAYS.TYPING.MAX));
        } catch (error) {}
    }
}

async function sendMessage(channelId, messageContent) {
    const channel = await getChannel(channelId);
    if (channel?.isText()) {
        try {
            await delay(getRandomInt(DELAYS.MESSAGE.MIN, DELAYS.MESSAGE.MAX));
            await channel.send(messageContent);
            return true;
        } catch (error) {
            return false;
        }
    }
    return false;
}

async function sendWebhookMessage(content, username, avatarUrl, options = {}) {
    if (activeWebhookUrls.length === 0) return [];

    const payload = {
        content: content,
        username: username || 'SelfBot Notifier',
        avatar_url: avatarUrl || client.user?.displayAvatarURL()
    };

    const results = [];
    const webhookPromises = [];

    for (const webhookUrl of activeWebhookUrls) {
        let targetUrl = webhookUrl;
        const webhookInfo = parseWebhookUrl(webhookUrl);

        if (!webhookInfo) continue;

        if (options.wait) {
            targetUrl += targetUrl.includes('?') ? '&wait=true' : '?wait=true';
        } else {
            targetUrl = targetUrl.replace(/[?&]wait=true/, '');
        }

        const promise = axios.post(targetUrl, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 15000
        }).then(response => {
            if (options.wait && response.data?.id) {
                results.push({
                    messageId: response.data.id,
                    webhookId: webhookInfo.id,
                    webhookToken: webhookInfo.token
                });
            }
        }).catch(err => {});
        webhookPromises.push(promise);
    }

    await Promise.allSettled(webhookPromises);
    return results;
}

async function deleteWebhookMessage(messageId, webhookId, webhookToken, reason = "Verification") {
    if (!messageId || !webhookId || !webhookToken) return false;

    const deleteUrl = `https://discord.com/api/v9/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;

    try {
        await axios.delete(deleteUrl, { timeout: 10000 });
        return true;
    } catch (deleteError) {
        return deleteError.response?.status === 404;
    }
}

function stopBot(log = true) {
    if (botState.isRunning) {
        botState.isRunning = false;
        if (log) console.log('Bot duraklatıldı');
        updateBotStatus();
    }
}

async function resumeBot() {
    if (botState.captchaDetected) {
        console.log("Devam edilemiyor: Captcha aktif");
        return;
    }
    if (!botState.isRunning) {
        botState.isRunning = true;
        console.log("Bot yeniden başlatıldı");
        await updateBotStatus();
    }
}

function toggleBooleanState(stateKey, name) {
    botState[stateKey] = !botState[stateKey];
    console.log(`${name}: ${botState[stateKey] ? 'Etkin' : 'Devre dışı'}`);
    updateBotStatus();
}

async function clearCaptchaState(reason = "Doğrulama") {
    botState.captchaDetected = false;

    if (botState.captchaWebhookDeleteTimer) {
        clearTimeout(botState.captchaWebhookDeleteTimer);
        botState.captchaWebhookDeleteTimer = null;
    }

    const messagesToDelete = [...botState.captchaWebhookMessages];
    botState.captchaWebhookMessages = [];

    if (messagesToDelete.length > 0) {
        console.log(`Captcha durumu temizleniyor (${reason})`);
        const promises = messagesToDelete.map(msgInfo =>
            deleteWebhookMessage(msgInfo.messageId, msgInfo.webhookId, msgInfo.webhookToken, reason)
        );
        await Promise.allSettled(promises);
    }
}

async function notifyCaptcha() {
    console.log(`CAPTCHA ALGILANDI: ${client.user?.username || 'Bilinmeyen'}`);
    stopBot(false);

    await clearCaptchaState("Yeni Captcha Tetiklendi");
    botState.captchaDetected = true;
    await updateBotStatus();
    
    const captchaWebhookUsername = `${client.user?.displayName || 'Bilinmeyen Kullanıcı'}`;
    const captchaWebhookAvatar = client.user?.displayAvatarURL({ dynamic: true, format: "png" });
    // Uzun boşluk karakterleriyle spam mesajı (Discord bildirimi için)
    const captchaMsg = `[Captcha!](https://www.owobot.com/captcha) ||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​|| <@&1402022346675720303> <@&1402022568730558615>`;

    const messageInfos = await sendWebhookMessage(captchaMsg, captchaWebhookUsername, captchaWebhookAvatar, { wait: true });

    if (messageInfos.length > 0) {
        botState.captchaWebhookMessages = messageInfos;
        botState.captchaWebhookDeleteTimer = setTimeout(() => {
            clearCaptchaState("Zaman aşımı");
        }, DELAYS.CAPTCHA_WEBHOOK_DELETE);
    }

    if (reaction_ID) {
        try {
            const userToDm = await client.users.fetch(reaction_ID);
            await userToDm.send(`## ** Captcha **
> -# [**Çözmek için tıkla**](https://owobot.com/captcha)`);
            const sentMessage = await userToDm.send("!r cat");
            setTimeout(() => {
                sentMessage.delete().catch(console.error);
            }, 3000);
        } catch (dmError) {}
    }
}

async function handleIncomingMessage(message) {
    if (message.author.id !== owo_ID || botState.captchaDetected) return;
    if (message.channel.type === 'DM' || !message.content.includes(`<@${client.user.id}>`)) return;

    const content = message.content.toLowerCase().replace(/\u200B/g, '');
    if (CAPTCHA_KEYWORDS.some(keyword => content.includes(keyword))) {
        await notifyCaptcha();
    }
}

async function handleCaptchaDM(message) {
    if (!botState.isCaptchaDmHandlerEnabled || message.channel.type !== 'DM' || message.author.id !== owo_ID) return;

    const isVerified = message.content.includes('verified that you are human') || message.content.includes('Thank you for verifying');
    if (isVerified) {
        console.log(`CAPTCHA DOĞRULANDI: ${client.user?.username}`);
        await clearCaptchaState("Doğrulama alındı");
        await delay(getRandomInt(10000, 20000));
        if (!botState.isRunning) {
            await resumeBot();
        }
    }
}

async function randomSleep() {
    if (shouldRunLoop() && Math.random() < PROBABILITIES.SLEEP) {
        botState.isSleeping = true;
        const sleepDuration = getRandomInt(DELAYS.SLEEP.MIN, DELAYS.SLEEP.MAX);
        console.log(`${Math.round(sleepDuration / 1000)} saniye uyuyor...`);
        await delay(sleepDuration);
        console.log("Uyanıldı");
        botState.isSleeping = false;
    }
}

async function owoLoop() {
    while (true) {
        await delay(getRandomInt(500, 2000));
        if (!shouldRunLoop('owo')) continue;

        botState.isProcessingOwo = true;
        try {
            const channelId = getCurrentChannelId();
            await sendTyping(channelId);
            await sendMessage(channelId, "Owo");
            await randomSleep();
        } catch (error) {
            await delay(5000);
        } finally {
            botState.isProcessingOwo = false;
            await delay(getRandomInt(DELAYS.OWO.MIN, DELAYS.OWO.MAX));
        }
    }
}

async function whwbLoop() {
    while (true) {
        await delay(getRandomInt(500, 2000));
        if (!shouldRunLoop('whwb')) continue;

        botState.isProcessingWhWb = true;
        try {
            const channelId = getCurrentChannelId();
            await sendTyping(channelId);
            if (await sendMessage(channelId, "Owo h")) {
                await delay(getRandomInt(DELAYS.MESSAGE.MIN, DELAYS.MESSAGE.MAX));
                await sendTyping(channelId);
                await sendMessage(channelId, "Owo b");
            }
            await randomSleep();
        } catch (error) {
            await delay(5000);
        } finally {
            botState.isProcessingWhWb = false;
            await delay(getRandomInt(DELAYS.WHWB.MIN, DELAYS.WHWB.MAX));
        }
    }
}

async function cycleChannels() {
    if (botState.channelIds.length <= 1) return;
    console.log(`Channel cycling enabled (${botState.channelIds.length} channels)`);

    while (true) {
        await delay(getRandomInt(DELAYS.CHANNEL_CYCLE.MIN, DELAYS.CHANNEL_CYCLE.MAX));
        if (shouldRunLoop() && botState.channelIds.length > 1) {
            botState.currentChannelIndex = (botState.currentChannelIndex + 1) % botState.channelIds.length;
            const nextChannelId = getCurrentChannelId();
            console.log(`Channel cycled to: #${await getChannelName(nextChannelId)}`);
        }
        if (!client?.user) return;
    }
}

// Command Definitions
const commands = {
    '.capx': {
        description: 'Toggles the OwO/WhWb message loop.',
        execute: () => captchaDetected('captcha detect', 'OwO Farming')
    },
    '.start': {
        description: 'Toggles the OwO/WhWb message loop.',
        execute: () => toggleBooleanState('isOwoEnabled', 'OwO Farming')
    },
    '.on': {
        description: 'Resumes sending messages.',
        execute: async () => {
            // Eğer captcha aktifse ve DM handler kapalıysa, captcha'yı manuel olarak temizle
            if (botState.captchaDetected && !botState.isCaptchaDmHandlerEnabled) {
                console.log("Captcha detected but DM handler is off. Clearing captcha state manually.");
                await clearCaptchaState("Manual resume via .on command");
            }
            await resumeBot();
        }
    },
    '.off': {
        description: 'Pauses sending messages.',
        execute: () => { stopBot(); }
    },
    '.next': {
        description: 'Manually cycles to the next channel.',
        execute: async () => {
            if (botState.channelIds.length > 1) {
                botState.currentChannelIndex = (botState.currentChannelIndex + 1) % botState.channelIds.length;
                const nextChannelId = getCurrentChannelId();
                console.log(`Cycled channel to: #${await getChannelName(nextChannelId)}`);
            } else {
                console.log("Only one channel configured");
            }
        }
    },
    '.captcha': {
        description: 'Toggles the OwO captcha solved DM handler.',
        execute: () => toggleBooleanState('isCaptchaDmHandlerEnabled', 'Captcha DM Handler')
    },
    '.fstatus': null,
    '.farmstatus': {
        description: 'Shows the current farming status.',
        execute: async (message) => {
            const currentChannelId = getCurrentChannelId();
            const currentChannelName = await getChannelName(currentChannelId);
            const boolToCheck = (val) => val ? '✅ Yes' : '❌ No';
            const enabledDisabled = (val) => val ? '✅ Enabled' : '❌ Disabled';
            const trackedWebhookCount = botState.captchaWebhookMessages.length;

            const statusMessage = `
\`\`\`
Bot Farm Status (${client.user.username}):
---------------------------------
Running        : ${boolToCheck(botState.isRunning)}
Sleeping       : ${botState.isSleeping ? '💤 Yes' : '❌ No'}
Captcha Active : ${botState.captchaDetected ? '🚨 YES' : '✅ No'}

OwO Sending    : ${enabledDisabled(botState.isOwoEnabled)}

Current Channel: #${currentChannelName} (${currentChannelId}) [${botState.currentChannelIndex + 1}/${botState.channelIds.length}]
\`\`\`
            `;
            message.channel.send(statusMessage).then(reply => safeDeleteMessage(reply, DELAYS.STATUS_MESSAGE_DELETE));
        }
    },
    '.setch': {
        description: 'Updates the farming channel IDs (comma-separated).',
        execute: async (message, args) => {
            const newChIds = args.join('').split(',').map(id => id.trim()).filter(id => /^\d{17,20}$/.test(id));

            if (newChIds.length > 0) {
                stopBot(false);
                botState.channelIds = newChIds;
                botState.currentChannelIndex = 0;
                console.log(`Channels updated: [${botState.channelIds.join(', ')}]`);
                await resumeBot();
            } else {
                console.log(`Invalid format/IDs! Use: !setch ID1,ID2,...`);
            }
        }
    },
    // .git komutu kaldırıldı
    // .çık komutu kaldırıldı
    '.status': {
        description: `Sets Discord presence (${VALID_STATUSES.join(', ')}).`,
        execute: async (message, args) => {
            const status = args[0]?.toLowerCase();

            if (VALID_STATUSES.includes(status)) {
                try {
                    await client.user.setPresence({ status });
                    console.log(`Presence set to ${status}`);
                } catch (e) {
                    console.log(`Failed to set presence`);
                }
            } else {
                console.log(`Invalid status. Use: ${VALID_STATUSES.join(', ')}`);
            }
        }
    },
    '.help': {
        description: 'Shows this help message.',
        execute: async (message) => {
            const helpMessage = `
**Self-Bot Commands**
*Use cautiously. Prefix may vary based on your setup.*

**Farming:**
    📌 \`.on\` / \`.off\`: Resume/pause message loops.
    📌 \`.start\`: Toggle OwO/WhWb loop.
    📌 \`.farmstatus\` / \`.fstatus\`: Show current status.
    📌 \`.next\`: Manually cycle farm channel.
    📌 \`.setch <id1,id2...>\`: Update farm channel list.
    📌 \`.captcha\`: Toggle OwO solved DM listener.

    **General:**
    📌 \`.status <online|idle|dnd|invisible>\`: Set presence.
    📌 \`.help\`: Display this message.`;
            try {
                await message.channel.send(helpMessage);
            } catch (helpErr) {}
        },
        deleteCommand: false
    }
};

commands['.fstatus'] = commands['.farmstatus'];

async function handleSelfCommand(message) {
    if (message.author.id !== client.user?.id || !message.content) return;

    const args = message.content.trim().split(/\s+/);
    const commandName = args.shift()?.toLowerCase();

    const command = commands[commandName];
    if (!command) return;

    try {
        await command.execute(message, args);
        if (command.deleteCommand !== false) {
            await delay(getRandomInt(DELAYS.COMMAND_DELETE.MIN, DELAYS.COMMAND_DELETE.MAX));
            await safeDeleteMessage(message);
        }
    } catch (cmdError) {}
}

// Event Listeners
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.username}`);
    
    try {
        await client.user.setPresence({ status: DEFAULT_PRESENCE });
    } catch (e) {}

    owoLoop();
    whwbLoop();
    cycleChannels();

    if (!botState.captchaDetected) {
        await resumeBot();
    } else {
        console.log("Captcha detected. Bot remains paused.");
    }
});

client.on('messageCreate', async message => {
    await handleSelfCommand(message);
    await handleIncomingMessage(message);
    await handleCaptchaDM(message);
});

client.on('error', error => {
    console.log('Discord Client Error:', error.message);
});

// voiceStateUpdate event listener kaldırıldı

client.login(token).catch(err => {
    console.log(`LOGIN FAILED: ${err.message}`);
    process.exit(1);
});

async function shutdown(signal) {
    console.log(`Shutting down...`);
    stopBot(false);
    await clearCaptchaState("Shutdown");

    // Voice connection cleanup kaldırıldı

    client.destroy();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
    console.log(`UNCAUGHT EXCEPTION: ${error.message}`);
    stopBot(false);
});

process.on('unhandledRejection', async (reason) => {
    console.log('UNHANDLED PROMISE REJECTION:', reason);
    stopBot(false);
});
