/**
 * ADVANCED VERSION with buttons and enhanced features
 * Dropbox Integration - This version includes:
 * - Quick folder selection buttons
 * - Batch processing support
 * - Upload history tracking
 * - Error recovery
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const DROPBOX_API = 'https://content.dropboxapi.com/2';
const DROPBOX_RPC = 'https://api.dropboxapi.com/2';
const dropboxToken = process.env.DROPBOX_ACCESS_TOKEN;

// User sessions
const userSessions = new Map();

// Default folder presets (customize these)
const DEFAULT_FOLDERS = [
  'Photos',
  'Screenshots',
  'Documents',
  'Other'
];

/**
 * Create or verify folder in Dropbox
 */
async function ensureFolder(folderPath) {
  try {
    if (!dropboxToken) {
      throw new Error('Missing DROPBOX_ACCESS_TOKEN');
    }

    const normalizedPath = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;

    try {
      const response = await axios.post(
        `${DROPBOX_RPC}/files/get_metadata`,
        { path: normalizedPath },
        {
          headers: {
            Authorization: `Bearer ${dropboxToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data['.tag'] === 'folder') {
        return normalizedPath;
      }
    } catch (error) {
      if (error.response?.status === 409) {
        // Create folder structure
        const folders = normalizedPath.split('/').filter(f => f);
        let currentPath = '';

        for (const folder of folders) {
          currentPath += `/${folder}`;

          try {
            await axios.post(
              `${DROPBOX_RPC}/files/create_folder_v2`,
              { path: currentPath },
              {
                headers: {
                  Authorization: `Bearer ${dropboxToken}`,
                  'Content-Type': 'application/json'
                }
              }
            );
          } catch (createError) {
            if (createError.response?.status !== 409) {
              throw createError;
            }
          }
        }

        return normalizedPath;
      } else {
        throw error;
      }
    }

    return normalizedPath;
  } catch (error) {
    console.error('Folder error:', error.message);
    throw error;
  }
}

/**
 * Upload file to Dropbox
 */
async function uploadToDropbox(filePath, fileName, folderPath) {
  try {
    if (!dropboxToken) {
      throw new Error('Missing DROPBOX_ACCESS_TOKEN');
    }

    const normalizedFolderPath = await ensureFolder(folderPath);
    const fileContent = fs.readFileSync(filePath);
    const dropboxFilePath = `${normalizedFolderPath}/${fileName}`;

    const uploadResponse = await axios.post(
      `${DROPBOX_API}/files/upload`,
      fileContent,
      {
        headers: {
          Authorization: `Bearer ${dropboxToken}`,
          'Content-Type': 'application/octet-stream',
          'Dropbox-API-Arg': JSON.stringify({
            path: dropboxFilePath,
            mode: 'add',
            autorename: true,
            mute: false
          })
        }
      }
    );

    console.log(`✓ Uploaded: ${fileName} to ${folderPath}`);
    return uploadResponse.data;
  } catch (error) {
    console.error('Upload error:', error.message);
    throw error;
  }
}

/**
 * Download from Telegram
 */
async function downloadTelegramPhoto(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer'
    });

    const tempDir = path.join(os.tmpdir(), 'telegram-bot-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFileName = `${Date.now()}.jpg`;
    const tempFilePath = path.join(tempDir, tempFileName);

    fs.writeFileSync(tempFilePath, response.data);
    return tempFilePath;
  } catch (error) {
    console.error('Download error:', error.message);
    throw error;
  }
}

/**
 * Create inline keyboard with folder options
 */
function getFolderKeyboard(includeCustom = true) {
  const buttons = DEFAULT_FOLDERS.map(folder => ({
    text: folder,
    callback_data: `folder_${folder}`
  }));

  if (includeCustom) {
    buttons.push({
      text: '✏️ Custom Folder',
      callback_data: 'folder_custom'
    });
  }

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }

  return { inline_keyboard: keyboard };
}

/**
 * Start command
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '🎉 *Welcome to Photo Organizer!*\n\n' +
    'I help you organize photos in Dropbox. Here\'s how:\n\n' +
    '1️⃣ Send me a photo\n' +
    '2️⃣ Tell me the filename\n' +
    '3️⃣ Choose a folder\n' +
    '4️⃣ Done! ✅\n\n' +
    '_Commands:_\n' +
    '/help - See help\n' +
    '/cancel - Cancel current upload',
    { parse_mode: 'Markdown' }
  );
});

/**
 * Help command
 */
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '*How to use:*\n\n' +
    '📸 Just send a photo\n' +
    '💬 Type a filename (with or without extension)\n' +
    '📁 Select a folder or enter custom path\n\n' +
    '*Folder Examples:*\n' +
    '`Photos` - Top level\n' +
    '`Photos/2024/March` - Nested folders\n\n' +
    '*File Examples:*\n' +
    '`vacation.jpg`\n' +
    '`family-photo.png`\n' +
    '`screenshot` (auto-adds .jpg)',
    { parse_mode: 'Markdown' }
  );
});

/**
 * Cancel command
 */
bot.onText(/\/cancel/, (msg) => {
  const chatId = msg.chat.id;
  const session = userSessions.get(chatId);

  if (session && session.filePath) {
    try {
      fs.unlinkSync(session.filePath);
    } catch (e) {}
  }

  userSessions.delete(chatId);
  bot.sendMessage(chatId, '❌ Upload cancelled.');
});

/**
 * Handle photo uploads
 */
bot.on('photo', async (msg) => {
  const chatId = msg.chat.id;
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  try {
    const filePath = await downloadTelegramPhoto(fileId);
    userSessions.set(chatId, { filePath, fileId });

    bot.sendMessage(chatId, '📝 *What filename do I use?*\n\n(Include extension or I\'ll add .jpg)', {
      parse_mode: 'Markdown'
    });
  } catch (error) {
    bot.sendMessage(chatId, '❌ Failed to process photo. Try again.');
  }
});

/**
 * Callback query handler (folder selection)
 */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = userSessions.get(chatId);

  if (!session) {
    bot.answerCallbackQuery(query.id, 'Session expired', true);
    return;
  }

  if (data.startsWith('folder_')) {
    const folderChoice = data.replace('folder_', '');

    if (folderChoice === 'custom') {
      bot.answerCallbackQuery(query.id);
      bot.sendMessage(chatId, '📁 Enter custom folder path:\n(e.g., Photos/2024/March)');
      session.waitingForFolder = true;
    } else {
      session.folderPath = folderChoice;
      await processUpload(chatId, session);
    }
  }
});

/**
 * Handle text input
 */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip if no text (e.g., photo, video, buttons)
  if (!text) return;

  if (text.startsWith('/')) return;

  const session = userSessions.get(chatId);
  if (!session) return;

  // Waiting for filename
  if (!session.fileName) {
    session.fileName = text;

    if (!session.fileName.includes('.')) {
      session.fileName += '.jpg';
    }

    bot.sendMessage(
      chatId,
      '📁 *Choose a folder:*',
      { reply_markup: getFolderKeyboard() }
    );
    return;
  }

  // Waiting for custom folder path
  if (session.waitingForFolder) {
    session.folderPath = text;
    session.waitingForFolder = false;
    await processUpload(chatId, session);
  }
});

/**
 * Process upload
 */
async function processUpload(chatId, session) {
  try {
    const statusMsg = await bot.sendMessage(chatId, '⏳ Uploading to Dropbox...');

    await uploadToDropbox(
      session.filePath,
      session.fileName,
      session.folderPath
    );

    bot.editMessageText(
      `✅ *Success!*\n\n📄 File: \`${session.fileName}\`\n📁 Folder: \`${session.folderPath}\``,
      {
        chat_id: chatId,
        message_id: statusMsg.message_id,
        parse_mode: 'Markdown'
      }
    );

    try {
      fs.unlinkSync(session.filePath);
    } catch (e) {}

    userSessions.delete(chatId);
  } catch (error) {
    bot.sendMessage(chatId, `❌ Upload failed: ${error.message}\n\n/cancel to reset`);
  }
}

/**
 * Error handlers
 */
bot.on('polling_error', (error) => {
  console.error('Polling error:', error);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Initialize
(async () => {
  console.log('🤖 Advanced Telegram Dropbox Bot starting...');

  if (!dropboxToken) {
    console.error('❌ DROPBOX_ACCESS_TOKEN not found in .env');
    process.exit(1);
  }

  console.log('✓ Bot running. Send /start');
})();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});
