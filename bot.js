const axios = require('axios');
const {
    Client,
    Intents,
    DiscordAPIError
} = require('discord.js-selfbot-v13');
const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    VoiceConnection,
    VoiceConnectionDisconnectReason
} = require('@discordjs/voice');
const config = require('./config/config.json');
const {
    logPre
} = require('./modules/logger');

const token = process.argv[2];
const {
    CH_IDS: initialChannelIds = [],
    owo_ID,
    reaction_ID,
    webhookUrl,
    webhookUrls: configWebhookUrls = [],
    DEFAULT_PRESENCE = 'invisible'
} = config;

const MIN_TYPING_DELAY = 200;
const MAX_TYPING_DELAY = 1000;
const MIN_MSG_DELAY = 200;
const MAX_MSG_DELAY = 500;
const MIN_OWO_INTERVAL = 10000;
const MAX_OWO_INTERVAL = 15000;
const MIN_WHWB_INTERVAL = 15000;
const MAX_WHWB_INTERVAL = 20000;
const MIN_SLEEP_DURATION = 30000;
const MAX_SLEEP_DURATION = 60000;
const MIN_CHANNEL_CYCLE_DELAY = 600000;
const MAX_CHANNEL_CYCLE_DELAY = 900000;
const COMMAND_DELETE_DELAY_MIN = 300;
const COMMAND_DELETE_DELAY_MAX = 800;
const STATUS_MESSAGE_DELETE_DELAY = 30000;
const INFO_MESSAGE_DELETE_DELAY = 15000;
const CAPTCHA_WEBHOOK_DELETE_TIMEOUT = 10 * 60 * 1000;

const SLEEP_CHANCE = 0.016;
const TYPING_CHANCE = 0.28;
const CAPTCHA_KEYWORDS = ['captcha', 'verify', 'real', 'human?', 'ban', 'banned', 'suspend', 'complete verification'];
const ERROR_WEBHOOK_USERNAME = 'Bot Error';
const VALID_STATUSES = ['online', 'idle', 'dnd', 'invisible'];

let botState = {
    isRunning: false,
    isOwoEnabled: false,
    isSleeping: false,
    captchaDetected: false,
    isProcessingOwo: false,
    isProcessingWhWb: false,
    isCaptchaDmHandlerEnabled: true,
    currentChannelIndex: 0,
    channelIds: [...initialChannelIds],
    voiceConnection: null,
    captchaWebhookMessages: [],
    captchaWebhookDeleteTimer: null
};

if (!token) {
    console.error('Token was not provided!');
    process.exit(1);
}
if (!Array.isArray(initialChannelIds) || initialChannelIds.length === 0) {
    console.error('config.json CH_IDS is missing or invalid!');
    process.exit(1);
}

let activeWebhookUrls = configWebhookUrls.filter(url => typeof url === 'string' && url.startsWith('https://discord.com/api/webhooks/'));
if (activeWebhookUrls.length === 0 && typeof webhookUrl === 'string' && webhookUrl.startsWith('https://discord.com/api/webhooks/')) {
    activeWebhookUrls = [webhookUrl];
}

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
    if (match && match.length === 3) {
        return {
            id: match[1],
            token: match[2]
        };
    }
    return null;
};

const client = new Client({
    checkUpdate: false,
    ws: {
        properties: {
            $browser: "Discord iOS"
        }
    }
});

async function updateBotStatus() {
    if (!client?.user) return;

    let newStatus;
    if (botState.captchaDetected) {
        newStatus = 'dnd'; // "Busy" interpreted as "Do Not Disturb"
    } else if (!botState.isRunning) {
        newStatus = 'idle'; // Bot stopped/paused
    } else if (botState.isOwoEnabled) {
        newStatus = 'online'; // .69 farming active
    } else {
        newStatus = DEFAULT_PRESENCE; // Fallback to config default (e.g., 'invisible')
    }

    try {
        await client.user.setPresence({ status: newStatus });
        console.log(`Status updated to: ${newStatus}`);
    } catch (error) {
        console.log(`Failed to update status: ${error.message}`);
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
    if (Math.random() >= TYPING_CHANCE) return;
    const channel = await getChannel(channelId);
    if (channel?.isText() && channel.type !== 'GUILD_FORUM') {
        try {
            await channel.sendTyping();
            await delay(getRandomInt(MIN_TYPING_DELAY, MAX_TYPING_DELAY));
        } catch (error) {}
    }
}

async function sendMessage(channelId, messageContent) {
    const channel = await getChannel(channelId);
    if (channel?.isText()) {
        try {
            await delay(getRandomInt(MIN_MSG_DELAY, MAX_MSG_DELAY));
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
            headers: {
                'Content-Type': 'application/json'
            },
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
        await axios.delete(deleteUrl, {
            timeout: 10000
        });
        return true;
    } catch (deleteError) {
        return deleteError.response?.status === 404;
    }
}

function stopBot(log = true) {
    if (botState.isRunning) {
        botState.isRunning = false;
        if (log) console.log('Bot paused');
        updateBotStatus(); // Update status when stopping
    }
}

async function resumeBot() {
    if (botState.captchaDetected) {
        console.log("Cannot resume: Captcha active");
        return;
    }
    if (!botState.isRunning) {
        botState.isRunning = true;
        console.log("Bot resumed");
        await updateBotStatus(); // Update status when resuming
    }
}

function toggleBooleanState(stateKey, name) {
    botState[stateKey] = !botState[stateKey];
    console.log(`${name}: ${botState[stateKey] ? 'Enabled' : 'Disabled'}`);
    updateBotStatus(); // Update status after toggling
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
    stopBot(false);

    await clearCaptchaState("New Captcha Triggered");
    botState.captchaDetected = true;
    await updateBotStatus();
    
    const captchaWebhookUsername = `${client.user?.displayName || 'Unknown User'}`;
    const captchaWebhookAvatar = client.user?.displayAvatarURL({
        dynamic: true,
        format: "png"
    });
    const captchaMsg = `Captcha! ||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​||||​|| <@&1402022346675720303> <@&1402022568730558615>`;

    const messageInfos = await sendWebhookMessage(captchaMsg, captchaWebhookUsername, captchaWebhookAvatar, {
        wait: true
    });

    if (messageInfos.length > 0) {
        botState.captchaWebhookMessages = messageInfos;
        botState.captchaWebhookDeleteTimer = setTimeout(() => {
            clearCaptchaState("Timeout");
        }, CAPTCHA_WEBHOOK_DELETE_TIMEOUT);
    }

    if (reaction_ID) {
        try {
            const userToDm = await client.users.fetch(reaction_ID);
            await userToDm.send(`## ** Captcha **\n> -# [**Click here to solve**](https://owobot.com/captcha)`);
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
        console.log(`CAPTCHA VERIFIED for ${client.user?.username}`);
        await clearCaptchaState("Verification received");
        await delay(getRandomInt(10000, 20000));
        if (!botState.isRunning) {
            await resumeBot();
        }
    }
}

async function randomSleep() {
    if (shouldRunLoop() && Math.random() < SLEEP_CHANCE) {
        botState.isSleeping = true;
        const sleepDuration = getRandomInt(MIN_SLEEP_DURATION, MAX_SLEEP_DURATION);
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
            await delay(5000);
        } finally {
            botState.isProcessingOwo = false;
            await delay(getRandomInt(MIN_OWO_INTERVAL, MAX_OWO_INTERVAL));
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
            if (await sendMessage(channelId, "Wh")) {
                await delay(getRandomInt(MIN_MSG_DELAY, MAX_MSG_DELAY));
                await sendTyping(channelId);
                await sendMessage(channelId, "Wb");
            }
            await randomSleep();
        } catch (error) {
            await delay(5000);
        } finally {
            botState.isProcessingWhWb = false;
            await delay(getRandomInt(MIN_WHWB_INTERVAL, MAX_WHWB_INTERVAL));
        }
    }
}

async function cycleChannels() {
    if (botState.channelIds.length <= 1) return;
    console.log(`Channel cycling enabled (${botState.channelIds.length} channels)`);

    while (true) {
        await delay(getRandomInt(MIN_CHANNEL_CYCLE_DELAY, MAX_CHANNEL_CYCLE_DELAY));
        if (shouldRunLoop() && botState.channelIds.length > 1) {
            botState.currentChannelIndex = (botState.currentChannelIndex + 1) % botState.channelIds.length;
            const nextChannelId = getCurrentChannelId();
            console.log(`Channel cycled to: #${await getChannelName(nextChannelId)}`);
        }
        if (!client?.user) return;
    }
}

const commands = {
    '.capx': {
        description: 'Toggles the OwO/WhWb message loop.',
        execute: () => captchaDetected('captcha detect', 'OwO Farming')
    },
    '.69': {
        description: 'Toggles the OwO/WhWb message loop.',
        execute: () => toggleBooleanState('isOwoEnabled', 'OwO Farming')
    },
    '.on': {
        description: 'Resumes sending messages.',
        execute: async () => {
            await resumeBot();
        }
    },
    '.off': {
        description: 'Pauses sending messages.',
        execute: () => {
            stopBot();
        }
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
            message.channel.send(statusMessage).then(reply => safeDeleteMessage(reply, STATUS_MESSAGE_DELETE_DELAY));
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
    '.git': {
        description: 'Joins a specified voice channel ID.',
        execute: async (message, args) => {
            const channelId = args[0];

            if (!channelId || !/^\d{17,20}$/.test(channelId)) {
                console.log("Invalid voice channel ID");
                return;
            }
            
            const channel = await getChannel(channelId);
            if (!channel || !channel.isVoice() || !channel.guild) {
                console.log(`Channel not found or not a voice channel`);
                return;
            }
            
            const guildId = channel.guild.id;
            let connection = getVoiceConnection(guildId);

            if (connection?.joinConfig.channelId === channel.id) {
                console.log(`Already connected to ${channel.name}`);
                return;
            }
            
            if (connection) {
                connection.destroy();
                await delay(500);
            }
            
            try {
                connection = joinVoiceChannel({
                    channelId: channel.id,
                    guildId: guildId,
                    adapterCreator: channel.guild.voiceAdapterCreator,
                    selfDeaf: false,
                    selfMute: false,
                });
                botState.voiceConnection = connection;
                
                connection.on(VoiceConnectionStatus.Disconnected, async () => {
                    connection.destroy();
                });
                
                await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
                console.log(`Joined voice channel ${channel.name}`);
            } catch (voiceError) {
                if (connection) connection.destroy();
                botState.voiceConnection = null;
                console.log(`Failed to join voice channel`);
            }
        }
    },
    '.çık': {
        description: 'Leaves the current voice channel in the server.',
        execute: async (message) => {
            if (!message.guild) {
                console.log("This command only works in servers");
                return;
            }
            
            const connection = getVoiceConnection(message.guild.id);
            if (connection) {
                connection.destroy();
                console.log(`Left voice channel`);
            } else {
                console.log(`Not connected to a voice channel`);
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
            📌 \`.69\`: Toggle OwO/WhWb loop.
            📌 \`.farmstatus\` / \`.fstatus\`: Show current status.
            📌 \`.next\`: Manually cycle farm channel.
            📌 \`.setch <id1,id2...>\`: Update farm channel list.
            📌 \`.captcha\`: Toggle OwO solved DM listener.
            
            **Voice:**
            📌 \`.git <vc_id>\`: Join a voice channel.
            📌 \`.çık\`: Leave current voice channel.
            
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
            await delay(getRandomInt(COMMAND_DELETE_DELAY_MIN, COMMAND_DELETE_DELAY_MAX));
            await safeDeleteMessage(message);
        }
    } catch (cmdError) {}
}

client.on('ready', async () => {
    console.log(`Logged in as ${client.user.username}`);
    
    try {
        await client.user.setPresence({
            status: DEFAULT_PRESENCE
        });
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

client.on('voiceStateUpdate', (oldState, newState) => {
    if (oldState.member?.id === client.user?.id && oldState.channelId && !newState.channelId) {
        const guildConnection = getVoiceConnection(oldState.guild.id);
        if (guildConnection && botState.voiceConnection === guildConnection) {
            botState.voiceConnection = null;
        }
    }
});

client.login(token).catch(err => {
    console.log(`LOGIN FAILED: ${err.message}`);
    process.exit(1);
});

async function shutdown(signal) {
    console.log(`Shutting down...`);
    stopBot(false);
    await clearCaptchaState("Shutdown");

    if (botState.voiceConnection instanceof VoiceConnection && botState.voiceConnection.state.status !== VoiceConnectionStatus.Destroyed) {
        botState.voiceConnection.destroy();
        await delay(500);
    }

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