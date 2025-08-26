const { fork } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const chalk = require('chalk');

console.clear();

const CONFIG_PATH = path.join(__dirname, './config/config.json');
const BOT_SCRIPT = path.join(__dirname, 'bot.js');

// Mesajları saklamak için bir dizi
const logMessages = [];

function addToLog(message, color = chalk.white) {
    logMessages.push({ text: message, color });
}

function printLogBox() {
    console.clear(); // Her güncellemede ekranı temizle
    const maxLength = Math.max(...logMessages.map(msg => msg.text.length));
    const topBottom = chalk.gray(`+${'-'.repeat(maxLength + 2)}+`);
    
    console.log(topBottom);
    logMessages.forEach(({ text, color }) => console.log(color(`| ${text.padEnd(maxLength)} |`)));
    console.log(topBottom);
}

async function loadTokens() {
    try {
        if (!await fs.access(CONFIG_PATH).then(() => true).catch(() => false)) {
            throw new Error(`${CONFIG_PATH} dosyası bulunamadı!`);
        }

        const configData = await fs.readFile(CONFIG_PATH, 'utf-8');
        const config = JSON.parse(configData);

        if (!Array.isArray(config.tokens)) {
            throw new Error('"tokens" anahtarı bir dizi olmalı.');
        }

        return config.tokens.filter(token => typeof token === 'string' && token.trim());
    } catch (error) {
        addToLog(`Hata: Config yüklenirken: ${error.message}`, chalk.red);
        printLogBox();
        process.exit(1);
    }
}

function spawnBot(token, index) {
    const tokenSuffix = `...${token.slice(-6)}`;
    addToLog(`Bot ${index + 1} başlatılıyor (Token: ${tokenSuffix})`, chalk.cyan);
    printLogBox();

    const child = fork(BOT_SCRIPT, [token], { stdio: 'inherit' });

    child.on('message', msg => {
        addToLog(`Bot ${index + 1} [${tokenSuffix}] Mesaj: ${msg}`, chalk.green);
        printLogBox();
    });

    child.on('error', err => {
        addToLog(`Bot ${index + 1} [${tokenSuffix}] Hata: ${err.message}`, chalk.red);
        printLogBox();
    });

    child.on('exit', (code, signal) => {
        const status = signal ? `sinyal: ${signal}` : `kod: ${code}`;
        const color = code === 0 ? chalk.green : chalk.yellow;
        addToLog(`Bot ${index + 1} [${tokenSuffix}] Çıkış: ${status}`, color);
        printLogBox();
    });
}

(async () => {
    const tokens = await loadTokens();
    
    if (!tokens.length) {
        addToLog('Başlatılacak token bulunamadı', chalk.yellow);
        printLogBox();
        process.exit(0);
    }

    addToLog(`${tokens.length} token bulundu, başlatılıyor...`, chalk.blue);
    printLogBox();

    tokens.forEach(spawnBot);

    addToLog('Tüm botlar başlatıldı', chalk.green);
    printLogBox();
})();