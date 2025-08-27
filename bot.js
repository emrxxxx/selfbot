const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const config = require('./config/config.json');

// --- Yapılandırma ---
const token = process.argv[2];
const {
    CH_IDS: initialChannelIds = [],
    owo_ID,
    reaction_ID,
    webhookUrl,
    webhookUrls: configWebhookUrls = [],
    DEFAULT_PRESENCE = 'invisible'
} = config;

// --- Sabitler ---
const DELAYS = {
    TYPING: { MIN: 200, MAX: 1000 },
    MESSAGE: { MIN: 200, MAX: 500 },
    OWO: { MIN: 12000, MAX: 13500 },
    WHWB: { MIN: 17000, MAX: 18500 },
    SLEEP: { MIN: 30000, MAX: 60000 },
    CHANNEL_CYCLE: { MIN: 600000, MAX: 900000 },
    COMMAND_DELETE: { MIN: 300, MAX: 800 },
    STATUS_MESSAGE_DELETE: 30000,
    INFO_MESSAGE_DELETE: 15000,
    CAPTCHA_WEBHOOK_DELETE: 10 * 60 * 1000
};

const PROBABILITIES = {
    SLEEP: 0.016,
    TYPING: 0.28
};

const CAPTCHA_KEYWORDS = ['captcha', 'verify', 'real', 'human?', 'ban', 'banned', 'suspend', 'complete verification'];
const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

// --- Bot Durumu ---
let botState = {
    isRunning: false,
    isOwoEnabled: false,
    isSleeping: false,
    captchaDetected: false,
    isProcessingOwo: false,
    isProcessingWhWb: false,
    isCaptchaDmHandlerEnabled: true, // Varsayılan: true, ancak devre dışı bırakılırsa mantık uyum sağlayacaktır
    currentChannelIndex: 0,
    channelIds: [...initialChannelIds],
    captchaWebhookMessages: [],
    captchaWebhookDeleteTimer: null
};

// --- Doğrulama ---
if (!token) {
    console.error('Token sağlanmadı!');
    process.exit(1);
}
if (!Array.isArray(initialChannelIds) || initialChannelIds.length === 0) {
    console.error('config.json CH_IDS eksik veya geçersiz!');
    process.exit(1);
}

let activeWebhookUrls = configWebhookUrls.filter(url =>
    typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/')
);
if (activeWebhookUrls.length === 0 && typeof webhookUrl === 'string' && webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    activeWebhookUrls = [webhookUrl];
}

// --- Yardımcı Fonksiyonlar ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const getCurrentChannelId = () => botState.channelIds[botState.currentChannelIndex];

// --- Çekirdek Mantık Kontrolü ---
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

// --- Discord İstemcisi ---
const client = new Client({
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } }
});

// --- Çekirdek Fonksiyonlar ---
async function updateBotStatus() {
    if (!client?.user) return;

    let newStatus;
    if (botState.captchaDetected) {
        newStatus = 'dnd';
    } else if (!botState.isRunning) {
        newStatus = 'idle';
    } else if (botState.isOwoEnabled) {
        newStatus = 'online';
    } else {
        newStatus = DEFAULT_PRESENCE;
    }

    try {
        await client.user.setPresence({ status: newStatus });
        console.log(`Durum güncellendi: ${newStatus}`);
    } catch (error) {
        console.error(`Durum güncellenemedi: ${error.message}`);
    }
}

async function safeDeleteMessage(message, delayMs = 0) {
    if (!message || typeof message.delete !== 'function') return;
    const del = () => message.delete().catch(() => {});
    if (delayMs > 0) {
        setTimeout(del, delayMs);
    } else {
        await del();
    }
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
        } catch (error) {
            // Yazma hatalarını yoksay
        }
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
        username: username || 'SelfBot Bildiricisi',
        avatar_url: avatarUrl || client.user?.displayAvatarURL()
    };

    const results = [];

    for (const webhookUrl of activeWebhookUrls) {
        let targetUrl = webhookUrl;
        const webhookInfo = parseWebhookUrl(webhookUrl);

        if (!webhookInfo) continue;

        if (options.wait) {
            targetUrl += (targetUrl.includes('?') ? '&wait=true' : '?wait=true');
        } else {
            targetUrl = targetUrl.replace(/[?&]wait=true/, '');
        }

        try {
            const response = await axios.post(targetUrl, payload, {
                headers: { 'Content-Type': 'application/json' },
                timeout: 15000
            });
            if (options.wait && response.data?.id) {
                results.push({
                    messageId: response.data.id,
                    webhookId: webhookInfo.id,
                    webhookToken: webhookInfo.token
                });
            }
        } catch (err) {
            // Webhook hatalarını yoksay
        }
    }

    return results;
}

async function deleteWebhookMessage(messageId, webhookId, webhookToken, reason = "Doğrulama") {
    if (!messageId || !webhookId || !webhookToken) return false;

    const deleteUrl = `https://discord.com/api/v9/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;

    try {
        await axios.delete(deleteUrl, { timeout: 10000 });
        return true;
    } catch (deleteError) {
        return deleteError.response?.status === 404; // Bulunamazsa silindiğini varsay
    }
}

function stopBot(log = true) {
    if (botState.isRunning) {
        botState.isRunning = false;
        if (log) console.log('Bot duraklatıldı');
        updateBotStatus();
    }
}

async function resumeBot({ skipCaptchaCheck = false } = {}) {
    // Eğer .captcha işleyicisi devre dışıysa, devam ettirildiğinde captcha kontrolünü her zaman atla
    const effectiveSkipCaptchaCheck = skipCaptchaCheck || !botState.isCaptchaDmHandlerEnabled;

    if (!effectiveSkipCaptchaCheck && botState.captchaDetected) {
        console.log("Devam ettirilemiyor: Captcha aktif (.captcha işleyicisi etkin)");
        return;
    }
    
    // Eğer işleyici devre dışıysa, devam ettirildiğinde kalan captcha durumunu temizle
    if (!botState.isCaptchaDmHandlerEnabled && botState.captchaDetected) {
         console.log("Captcha işleyicisi devre dışı. Devam ettirildiğinde captcha durumu temizleniyor.");
         await clearCaptchaState("Captcha işleyicisi devre dışıyken devam et");
    }

    if (!botState.isRunning) {
        botState.isRunning = true;
        console.log("Bot devam ettirildi");
        await updateBotStatus();
    }
}

function toggleBooleanState(stateKey, name) {
    botState[stateKey] = !botState[stateKey];
    console.log(`${name}: ${botState[stateKey] ? 'Etkin' : 'Devre Dışı'}`);
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
    console.log(`CAPTCHA TESPİT EDİLDİ: ${client.user?.username || 'Bilinmeyen'}`);
    stopBot(false); // Captcha'da botu duraklat

    await clearCaptchaState("Yeni Captcha Tetiklendi");
    botState.captchaDetected = true;
    await updateBotStatus();
    
    const captchaWebhookUsername = `${client.user?.displayName || 'Bilinmeyen Kullanıcı'}`;
    const captchaWebhookAvatar = client.user?.displayAvatarURL({ dynamic: true, format: "png" });
    const captchaMsg = `## [Captcha!](https://www.owobot.com/captcha) ||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​|| <@&1402022346675720303> <@&1402022568730558615>`;

    const messageInfos = await sendWebhookMessage(captchaMsg, captchaWebhookUsername, captchaWebhookAvatar, { wait: true });

    if (messageInfos.length > 0) {
        botState.captchaWebhookMessages = messageInfos;
        botState.captchaWebhookDeleteTimer = setTimeout(() => {
            clearCaptchaState("Zaman Aşımı");
        }, DELAYS.CAPTCHA_WEBHOOK_DELETE);
    }

    if (reaction_ID) {
        try {
            const userToDm = await client.users.fetch(reaction_ID);
            await userToDm.send(`## ** Captcha **\n> -# [**Çözmek için buraya tıkla**](https://owobot.com/captcha)`);
            const sentMessage = await userToDm.send("!r cat");
            setTimeout(() => {
                safeDeleteMessage(sentMessage).catch(() => {});
            }, 3000);
        } catch (dmError) {
            console.error("Captcha için DM gönderilemedi:", dmError.message);
        }
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
    // Yalnızca işleyici açıkça etkinleştirilmişse işle
    if (!botState.isCaptchaDmHandlerEnabled || message.channel.type !== 'DM' || message.author.id !== owo_ID) {
        return;
    }

    const isVerified = message.content.includes('insan olduğunuzu doğruladı') || message.content.includes('Doğruladığınız için teşekkür ederiz');
    if (isVerified) {
        console.log(`CAPTCHA DOĞRULANDI: ${client.user?.username}`);
        await clearCaptchaState("Doğrulama DM yoluyla alındı");
        await delay(getRandomInt(10000, 20000));
        // Doğrulamadan sonra botu devam ettir
        if (!botState.isRunning) {
            await resumeBot({ skipCaptchaCheck: true }); // Az önce temizlediğimiz için kontrolü atla
        }
    }
}

async function randomSleep() {
    if (shouldRunLoop() && Math.random() < PROBABILITIES.SLEEP) {
        botState.isSleeping = true;
        const sleepDuration = getRandomInt(DELAYS.SLEEP.MIN, DELAYS.SLEEP.MAX);
        console.log(`Uykuya geçiliyor: ${Math.round(sleepDuration / 1000)}s`);
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
            console.error("owoLoop'ta hata:", error.message);
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
            console.error("whwbLoop'ta hata:", error.message);
            await delay(5000);
        } finally {
            botState.isProcessingWhWb = false;
            await delay(getRandomInt(DELAYS.WHWB.MIN, DELAYS.WHWB.MAX));
        }
    }
}

async function cycleChannels() {
    if (botState.channelIds.length <= 1) return;
    console.log(`Kanal döngüsü etkinleştirildi (${botState.channelIds.length} kanal)`);

    while (true) {
        await delay(getRandomInt(DELAYS.CHANNEL_CYCLE.MIN, DELAYS.CHANNEL_CYCLE.MAX));
        if (shouldRunLoop() && botState.channelIds.length > 1) {
            botState.currentChannelIndex = (botState.currentChannelIndex + 1) % botState.channelIds.length;
            const nextChannelId = getCurrentChannelId();
            console.log(`Kanal şuna değiştirildi: #${await getChannelName(nextChannelId)}`);
        }
        if (!client?.user) return;
    }
}

// --- Komutlar ---
const commands = {
    '.capx': {
        description: 'Bir captcha tespitini simüle eder.',
        execute: async () => {
            await notifyCaptcha(); // Mevcut fonksiyonu yeniden kullan
        }
    },
    '.69': {
        description: 'OwO/WhWb mesaj döngüsünü açar/kapatır.',
        execute: () => toggleBooleanState('isOwoEnabled', 'OwO Farmlama')
    },
    '.on': {
        description: 'Mesaj göndermeye devam eder. Eğer .captcha işleyicisi devre dışıysa, herhangi bir captcha durumunu temizler.',
        execute: async () => {
             // İşleyici durumuna göre skipCaptchaCheck'i ilet
            await resumeBot({ skipCaptchaCheck: !botState.isCaptchaDmHandlerEnabled }); 
        }
    },
    '.off': {
        description: 'Mesaj göndermeyi duraklatır.',
        execute: () => stopBot()
    },
    '.next': {
        description: 'Manuel olarak bir sonraki kanala geçer.',
        execute: async () => {
            if (botState.channelIds.length > 1) {
                botState.currentChannelIndex = (botState.currentChannelIndex + 1) % botState.channelIds.length;
                const nextChannelId = getCurrentChannelId();
                console.log(`Kanal şuna değiştirildi: #${await getChannelName(nextChannelId)}`);
            } else {
                console.log("Sadece bir kanal yapılandırılmış");
            }
        }
    },
    '.captcha': {
        description: 'OwO captcha çözüldü DM işleyicisini açar/kapatır. Devre dışı bırakıldığında, .on komutu captcha durumunu temizler.',
        execute: () => toggleBooleanState('isCaptchaDmHandlerEnabled', 'Captcha DM İşleyicisi')
    },
    '.fstatus': null, // Takma Ad
    '.farmstatus': {
        description: 'Mevcut farmlama durumunu gösterir.',
        execute: async (message) => {
            const currentChannelId = getCurrentChannelId();
            const currentChannelName = await getChannelName(currentChannelId);
            const boolToCheck = (val) => val ? '✅ Evet' : '❌ Hayır';
            const enabledDisabled = (val) => val ? '✅ Etkin' : '❌ Devre Dışı';

            const statusMessage = `\`\`\`
Bot Farm Durumu (${client.user.username}):
---------------------------------
Çalışıyor      : ${boolToCheck(botState.isRunning)}
Uyuyor         : ${botState.isSleeping ? '💤 Evet' : '❌ Hayır'}
Captcha Aktif  : ${botState.captchaDetected ? '🚨 EVET' : '✅ Hayır'}

OwO Gönderimi  : ${enabledDisabled(botState.isOwoEnabled)}
Captcha İşleyicisi: ${enabledDisabled(botState.isCaptchaDmHandlerEnabled)}

Mevcut Kanal: #${currentChannelName} (${currentChannelId}) [${botState.currentChannelIndex + 1}/${botState.channelIds.length}]
\`\`\``;
            message.channel.send(statusMessage)
                .then(reply => safeDeleteMessage(reply, DELAYS.STATUS_MESSAGE_DELETE))
                .catch(() => {});
        }
    },
    '.setch': {
        description: 'Farmlama kanal ID\'lerini günceller (virgülle ayrılmış).',
        execute: async (message, args) => {
            const newChIds = args.join('').split(',')
                .map(id => id.trim())
                .filter(id => /^\d{17,20}$/.test(id));

            if (newChIds.length > 0) {
                stopBot(false);
                botState.channelIds = newChIds;
                botState.currentChannelIndex = 0;
                console.log(`Kanallar güncellendi: [${botState.channelIds.join(', ')}]`);
                await resumeBot(); // Kanal güncellemesinden sonra devam et
            } else {
                console.log(`Geçersiz format/ID'ler! Kullanım: .setch ID1,ID2,...`);
            }
        }
    },
    '.status': {
        description: `Discord durumunu ayarlar (${VALID_STATUSES.join(', ')}).`,
        execute: async (message, args) => {
            const status = args[0]?.toLowerCase();

            if (VALID_STATUSES.includes(status)) {
                try {
                    await client.user.setPresence({ status });
                    console.log(`Durum şuna ayarlandı: ${status}`);
                } catch (e) {
                    console.error(`Durum ayarlanamadı: ${e.message}`);
                }
            } else {
                console.log(`Geçersiz durum. Kullanım: ${VALID_STATUSES.join(', ')}`);
            }
        }
    },
    '.help': {
        description: 'Bu yardım mesajını gösterir.',
        execute: async (message) => {
            const helpMessage = `**Self-Bot Komutları**
*Dikkatli kullanın. Ön ek, kurulumunuza göre değişebilir.*

**Farmlama:**
📌 \`.on\` / \`.off\`: Mesaj döngülerini devam ettirir/duraklatır.
📌 \`.69\`: OwO/WhWb döngüsünü açar/kapatır.
📌 \`.farmstatus\` / \`.fstatus\`: Mevcut durumu gösterir.
📌 \`.next\`: Farm kanalını manuel olarak değiştirir.
📌 \`.setch <id1,id2...>\`: Farm kanal listesini günceller.
📌 \`.captcha\`: OwO çözüldü DM dinleyicisini açar/kapatır. Devre dışıysa, .on captcha durumunu temizler.

**Genel:**
📌 \`.status <online|idle|dnd|invisible>\`: Durumu ayarlar.
📌 \`.help\`: Bu mesajı görüntüler.
� \`.capx\`: Captcha tespitini simüle eder.`;
            try {
                await message.channel.send(helpMessage);
            } catch (helpErr) {
                console.error("Yardım mesajı gönderilemedi:", helpErr.message);
            }
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
    } catch (cmdError) {
        console.error(`Komut yürütülürken hata oluştu ${commandName}:`, cmdError.message);
    }
}

// --- Olay Dinleyicileri ---
client.on('ready', async () => {
    console.log(`Giriş yapıldı: ${client.user.username}`);
    
    try {
        await client.user.setPresence({ status: DEFAULT_PRESENCE });
    } catch (e) {
        console.error("Başlangıç durumu ayarlanamadı:", e.message);
    }

    owoLoop();
    whwbLoop();
    cycleChannels();

    if (!botState.captchaDetected) {
        await resumeBot();
    } else {
        console.log("Başlangıçta captcha tespit edildi. Bot duraklatılmış olarak kalıyor.");
    }
});

client.on('messageCreate', async message => {
    await handleSelfCommand(message);
    await handleIncomingMessage(message);
    await handleCaptchaDM(message);
});

client.on('error', error => {
    console.error('Discord İstemci Hatası:', error.message);
});

client.login(token).catch(err => {
    console.error(`GİRİŞ BAŞARISIZ: ${err.message}`);
    process.exit(1);
});

async function shutdown(signal) {
    console.log(`Kapatılıyor...`);
    stopBot(false);
    await clearCaptchaState("Kapatma");

    client.destroy();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
    console.error(`YAKALANAMAYAN İSTİSNA: ${error.message}`);
    console.error(error.stack);
    stopBot(false);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('İŞLENMEMİŞ PROMISE REDDİ:', promise, 'sebep:', reason);
    stopBot(false);
});
