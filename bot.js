const axios = require('axios');
const { Client } = require('discord.js-selfbot-v13');
const config = require('./config/config.json');

// --- Configuration ---
const token = process.argv[2];
const {
    CH_IDS: initialChannelIds = [],
    owo_ID,
    reaction_ID,
    webhookUrl,
    webhookUrls: configWebhookUrls = [],
    DEFAULT_PRESENCE = 'invisible'
} = config;

// --- Constants ---
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

// --- Bot State ---
let botState = {
    isRunning: false,
    isOwoEnabled: false,
    isSleeping: false,
    captchaDetected: false,
    isProcessingOwo: false,
    isProcessingWhWb: false,
    isCaptchaDmHandlerEnabled: true, // Default: true, but logic will adapt if disabled
    currentChannelIndex: 0,
    channelIds: [...initialChannelIds],
    captchaWebhookMessages: [],
    captchaWebhookDeleteTimer: null
};

// --- Validation ---
if (!token) {
    console.error('Token was not provided!');
    process.exit(1);
}
if (!Array.isArray(initialChannelIds) || initialChannelIds.length === 0) {
    console.error('config.json CH_IDS is missing or invalid!');
    process.exit(1);
}

let activeWebhookUrls = configWebhookUrls.filter(url => 
    typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/')
);
if (activeWebhookUrls.length === 0 && typeof webhookUrl === 'string' && webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    activeWebhookUrls = [webhookUrl];
}

// --- Utility Functions ---
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const getRandomInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const getCurrentChannelId = () => botState.channelIds[botState.currentChannelIndex];

// --- Core Logic Control ---
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

// --- Discord Client ---
const client = new Client({
    checkUpdate: false,
    ws: { properties: { $browser: "Discord iOS" } }
});

// --- Core Functions ---
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
        console.log(`Status updated to: ${newStatus}`);
    } catch (error) {
        console.error(`Failed to update status: ${error.message}`);
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
            // Ignore typing errors
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
        username: username || 'SelfBot Notifier',
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
            // Ignore webhook errors
        }
    }

    return results;
}

async function deleteWebhookMessage(messageId, webhookId, webhookToken, reason = "Verification") {
    if (!messageId || !webhookId || !webhookToken) return false;

    const deleteUrl = `https://discord.com/api/v9/webhooks/${webhookId}/${webhookToken}/messages/${messageId}`;

    try {
        await axios.delete(deleteUrl, { timeout: 10000 });
        return true;
    } catch (deleteError) {
        return deleteError.response?.status === 404; // Assume deleted if not found
    }
}

function stopBot(log = true) {
    if (botState.isRunning) {
        botState.isRunning = false;
        if (log) console.log('Bot paused');
        updateBotStatus();
    }
}

async function resumeBot({ skipCaptchaCheck = false } = {}) {
    // If .captcha handler is disabled, always skip the captcha check on resume
    const effectiveSkipCaptchaCheck = skipCaptchaCheck || !botState.isCaptchaDmHandlerEnabled;

    if (!effectiveSkipCaptchaCheck && botState.captchaDetected) {
        console.log("Cannot resume: Captcha active (and .captcha handler is enabled)");
        return;
    }
    
    // If handler is disabled, clear any lingering captcha state on resume
    if (!botState.isCaptchaDmHandlerEnabled && botState.captchaDetected) {
         console.log("Captcha handler is disabled. Clearing captcha state on resume.");
         await clearCaptchaState("Resume with .captcha handler disabled");
    }

    if (!botState.isRunning) {
        botState.isRunning = true;
        console.log("Bot resumed");
        await updateBotStatus();
    }
}

function toggleBooleanState(stateKey, name) {
    botState[stateKey] = !botState[stateKey];
    console.log(`${name}: ${botState[stateKey] ? 'Enabled' : 'Disabled'}`);
    updateBotStatus();
}

async function clearCaptchaState(reason = "Verification") {
    botState.captchaDetected = false;

    if (botState.captchaWebhookDeleteTimer) {
        clearTimeout(botState.captchaWebhookDeleteTimer);
        botState.captchaWebhookDeleteTimer = null;
    }

    const messagesToDelete = [...botState.captchaWebhookMessages];
    botState.captchaWebhookMessages = [];

    if (messagesToDelete.length > 0) {
        console.log(`Clearing captcha state (${reason})`);
        const promises = messagesToDelete.map(msgInfo =>
            deleteWebhookMessage(msgInfo.messageId, msgInfo.webhookId, msgInfo.webhookToken, reason)
        );
        await Promise.allSettled(promises);
    }
}

async function notifyCaptcha() {
    console.log(`CAPTCHA DETECTED for ${client.user?.username || 'Unknown'}`);
    stopBot(false); // Pause bot on captcha

    await clearCaptchaState("New Captcha Triggered");
    botState.captchaDetected = true;
    await updateBotStatus();
    
    const captchaWebhookUsername = `${client.user?.displayName || 'Unknown User'}`;
    const captchaWebhookAvatar = client.user?.displayAvatarURL({ dynamic: true, format: "png" });
    const captchaMsg = `## [Captcha!](https://www.owobot.com/captcha) ||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​|| <@&1402022346675720303> <@&1402022568730558615>`;

    const messageInfos = await sendWebhookMessage(captchaMsg, captchaWebhookUsername, captchaWebhookAvatar, { wait: true });

    if (messageInfos.length > 0) {
        botState.captchaWebhookMessages = messageInfos;
        botState.captchaWebhookDeleteTimer = setTimeout(() => {
            clearCaptchaState("Timeout");
        }, DELAYS.CAPTCHA_WEBHOOK_DELETE);
    }

    if (reaction_ID) {
        try {
            const userToDm = await client.users.fetch(reaction_ID);
            await userToDm.send(`## ** Captcha **\n> -# [**Click here to solve**](https://owobot.com/captcha)`);
            const sentMessage = await userToDm.send("!r cat");
            setTimeout(() => {
                safeDeleteMessage(sentMessage).catch(() => {});
            }, 3000);
        } catch (dmError) {
            console.error("Failed to send DM for captcha:", dmError.message);
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
    // Only process if the handler is explicitly enabled
    if (!botState.isCaptchaDmHandlerEnabled || message.channel.type !== 'DM' || message.author.id !== owo_ID) {
        return;
    }

    const isVerified = message.content.includes('verified that you are human') || message.content.includes('Thank you for verifying');
    if (isVerified) {
        console.log(`CAPTCHA VERIFIED for ${client.user?.username}`);
        await clearCaptchaState("Verification received via DM");
        await delay(getRandomInt(10000, 20000));
        // Resume bot after verification
        if (!botState.isRunning) {
            await resumeBot({ skipCaptchaCheck: true }); // Skip check as we just cleared it
        }
    }
}

async function randomSleep() {
    if (shouldRunLoop() && Math.random() < PROBABILITIES.SLEEP) {
        botState.isSleeping = true;
        const sleepDuration = getRandomInt(DELAYS.SLEEP.MIN, DELAYS.SLEEP.MAX);
        console.log(`Sleeping for ${Math.round(sleepDuration / 1000)}s`);
        await delay(sleepDuration);
        console.log("Woke up");
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
            console.error("Error in owoLoop:", error.message);
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
            console.error("Error in whwbLoop:", error.message);
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

// --- Commands ---
const commands = {
    '.capx': {
        description: 'Simulates a captcha detection.',
        execute: async () => {
            await notifyCaptcha(); // Reuse the existing function
        }
    },
    '.69': {
        description: 'Toggles the OwO/WhWb message loop.',
        execute: () => toggleBooleanState('isOwoEnabled', 'OwO Farming')
    },
    '.on': {
        description: 'Resumes sending messages. If .captcha handler is disabled, clears any captcha state.',
        execute: async () => {
             // Pass skipCaptchaCheck based on the handler state
            await resumeBot({ skipCaptchaCheck: !botState.isCaptchaDmHandlerEnabled }); 
        }
    },
    '.off': {
        description: 'Pauses sending messages.',
        execute: () => stopBot()
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
        description: 'Toggles the OwO captcha solved DM handler. When disabled, .on will clear captcha state.',
        execute: () => toggleBooleanState('isCaptchaDmHandlerEnabled', 'Captcha DM Handler')
    },
    '.fstatus': null, // Alias
    '.farmstatus': {
        description: 'Shows the current farming status.',
        execute: async (message) => {
            const currentChannelId = getCurrentChannelId();
            const currentChannelName = await getChannelName(currentChannelId);
            const boolToCheck = (val) => val ? '✅ Yes' : '❌ No';
            const enabledDisabled = (val) => val ? '✅ Enabled' : '❌ Disabled';

            const statusMessage = `\`\`\`
Bot Farm Status (${client.user.username}):
---------------------------------
Running        : ${boolToCheck(botState.isRunning)}
Sleeping       : ${botState.isSleeping ? '💤 Yes' : '❌ No'}
Captcha Active : ${botState.captchaDetected ? '🚨 YES' : '✅ No'}

OwO Sending    : ${enabledDisabled(botState.isOwoEnabled)}
Captcha Handler: ${enabledDisabled(botState.isCaptchaDmHandlerEnabled)}

Current Channel: #${currentChannelName} (${currentChannelId}) [${botState.currentChannelIndex + 1}/${botState.channelIds.length}]
\`\`\``;
            message.channel.send(statusMessage)
                .then(reply => safeDeleteMessage(reply, DELAYS.STATUS_MESSAGE_DELETE))
                .catch(() => {});
        }
    },
    '.setch': {
        description: 'Updates the farming channel IDs (comma-separated).',
        execute: async (message, args) => {
            const newChIds = args.join('').split(',')
                .map(id => id.trim())
                .filter(id => /^\d{17,20}$/.test(id));

            if (newChIds.length > 0) {
                stopBot(false);
                botState.channelIds = newChIds;
                botState.currentChannelIndex = 0;
                console.log(`Channels updated: [${botState.channelIds.join(', ')}]`);
                await resumeBot(); // Resume after channel update
            } else {
                console.log(`Invalid format/IDs! Use: .setch ID1,ID2,...`);
            }
        }
    },
    '.status': {
        description: `Sets Discord presence (${VALID_STATUSES.join(', ')}).`,
        execute: async (message, args) => {
            const status = args[0]?.toLowerCase();

            if (VALID_STATUSES.includes(status)) {
                try {
                    await client.user.setPresence({ status });
                    console.log(`Presence set to ${status}`);
                } catch (e) {
                    console.error(`Failed to set presence: ${e.message}`);
                }
            } else {
                console.log(`Invalid status. Use: ${VALID_STATUSES.join(', ')}`);
            }
        }
    },
    '.help': {
        description: 'Shows this help message.',
        execute: async (message) => {
            const helpMessage = `**Self-Bot Commands**
*Use cautiously. Prefix may vary based on your setup.*

**Farming:**
📌 \`.on\` / \`.off\`: Resume/pause message loops.
📌 \`.69\`: Toggle OwO/WhWb loop.
📌 \`.farmstatus\` / \`.fstatus\`: Show current status.
📌 \`.next\`: Manually cycle farm channel.
📌 \`.setch <id1,id2...>\`: Update farm channel list.
📌 \`.captcha\`: Toggle OwO solved DM listener. If disabled, .on clears captcha state.

**General:**
📌 \`.status <online|idle|dnd|invisible>\`: Set presence.
📌 \`.help\`: Display this message.
📌 \`.capx\`: Simulate captcha detection.`;
            try {
                await message.channel.send(helpMessage);
            } catch (helpErr) {
                console.error("Failed to send help message:", helpErr.message);
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
        console.error(`Error executing command ${commandName}:`, cmdError.message);
    }
}

// --- Event Listeners ---
client.on('ready', async () => {
    console.log(`Logged in as ${client.user.username}`);
    
    try {
        await client.user.setPresence({ status: DEFAULT_PRESENCE });
    } catch (e) {
        console.error("Failed to set initial presence:", e.message);
    }

    owoLoop();
    whwbLoop();
    cycleChannels();

    if (!botState.captchaDetected) {
        await resumeBot();
    } else {
        console.log("Captcha detected on startup. Bot remains paused.");
    }
});

client.on('messageCreate', async message => {
    await handleSelfCommand(message);
    await handleIncomingMessage(message);
    await handleCaptchaDM(message);
});

client.on('error', error => {
    console.error('Discord Client Error:', error.message);
});

client.login(token).catch(err => {
    console.error(`LOGIN FAILED: ${err.message}`);
    process.exit(1);
});

async function shutdown(signal) {
    console.log(`Shutting down...`);
    stopBot(false);
    await clearCaptchaState("Shutdown");

    client.destroy();
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
    console.error(`UNCAUGHT EXCEPTION: ${error.message}`);
    console.error(error.stack);
    stopBot(false);
});

process.on('unhandledRejection', async (reason, promise) => {
    console.error('UNHANDLED PROMISE REJECTION at:', promise, 'reason:', reason);
    stopBot(false);
});
