require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const os = require('os');

// Initialize Telegram Bot
const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// Dropbox API Configuration
const DROPBOX_API = 'https://content.dropboxapi.com/2';
const DROPBOX_RPC = 'https://api.dropboxapi.com/2';
const dropboxToken = process.env.DROPBOX_ACCESS_TOKEN;

// Store user sessions
const userSessions = new Map();

/**
 * Create or check folder in Dropbox
 */
async function ensureFolder(folderPath) {
  try {
    if (!dropboxToken) {
      throw new Error('Missing DROPBOX_ACCESS_TOKEN');
    }

    // Normalize path - ensure it starts with /
    const normalizedPath = folderPath.startsWith('/') ? folderPath : `/${folderPath}`;

    // Check if folder exists
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
        console.log(`✓ Folder exists: ${normalizedPath}`);
        return normalizedPath;
      }
    } catch (error) {
      if (error.response?.status === 409) {
        // Folder doesn't exist, create it
        console.log(`Creating folder: ${normalizedPath}`);

        // Create all parent folders
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
            console.log(`✓ Created folder: ${currentPath}`);
          } catch (createError) {
            if (createError.response?.status !== 409) {
              throw createError;
            }
            // Folder already exists, continue
          }
        }

        return normalizedPath;
      } else {
        throw error;
      }
    }

    return normalizedPath;
  } catch (error) {
    console.error('❌ Folder operation failed:', error.response?.data || error.message);
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

    // Ensure folder exists/create it
    const normalizedFolderPath = await ensureFolder(folderPath);

    // Read file
    const fileContent = fs.readFileSync(filePath);

    // Construct Dropbox file path
    const dropboxFilePath = `${normalizedFolderPath}/${fileName}`;

    // Upload file
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

    console.log(`✓ File uploaded: ${fileName} to ${folderPath}`);
    return uploadResponse.data;
  } catch (error) {
    console.error('❌ Upload failed:', error.response?.data || error.message);
    throw error;
  }
}

/**
 * Download photo from Telegram
 */
async function downloadTelegramPhoto(fileId) {
  try {
    const file = await bot.getFile(fileId);
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    const response = await axios.get(downloadUrl, {
      responseType: 'arraybuffer'
    });

    // Save to temp directory
    const tempDir = path.join(os.tmpdir(), 'telegram-bot-temp');
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const tempFileName = `${Date.now()}.jpg`;
    const tempFilePath = path.join(tempDir, tempFileName);

    fs.writeFileSync(tempFilePath, response.data);
    console.log(`✓ Photo downloaded: ${tempFilePath}`);

    return tempFilePath;
  } catch (error) {
    console.error('❌ Photo download failed:', error.message);
    throw error;
  }
}

/**
 * Start command - greets user
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    'Welcome! 📸\n\nI can help you organize your photos in Dropbox.\n\n' +
    'Just:\n' +
    '1. Send me a photo\n' +
    '2. Tell me the correct name\n' +
    '3. Tell me the folder path\n\n' +
    'And I\'ll upload it to Dropbox automatically!'
  );
});

/**
 * Help command
 */
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '📸 *How to use:*\n\n' +
    '1. Send a photo\n' +
    '2. Type a filename (with or without extension)\n' +
    '3. Enter folder path\n\n' +
    '*Folder Examples:*\n' +
    '`Photos` - Top level\n' +
    '`Photos/Vacation` - Nested\n' +
    '`Photos/2024/March` - Multiple levels\n\n' +
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
    // Download the photo
    const filePath = await downloadTelegramPhoto(fileId);

    // Store session
    userSessions.set(chatId, { filePath, fileId });

    // Ask for image name
    bot.sendMessage(chatId, 'What should this image be named? (e.g., "family-photo.jpg")');
  } catch (error) {
    bot.sendMessage(chatId, '❌ Failed to download photo. Please try again.');
  }
});

/**
 * Handle text input (corrections and folder paths)
 */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // Skip if command
  if (text.startsWith('/')) return;

  const session = userSessions.get(chatId);

  // If no active session, ignore
  if (!session) return;

  // If waiting for file name
  if (!session.fileName) {
    session.fileName = text;
    bot.sendMessage(
      chatId,
      'Got it! What folder should this go in? (e.g., "Photos/Vacation" or just "Photos")'
    );
    return;
  }

  // If waiting for folder path
  if (!session.folderPath) {
    session.folderPath = text;

    // Validate file name has extension
    if (!session.fileName.includes('.')) {
      session.fileName += '.jpg';
    }

    // Upload to Dropbox
    await processUpload(chatId, session);
    return;
  }
});

/**
 * Process the upload to Dropbox
 */
async function processUpload(chatId, session) {
  try {
    bot.sendMessage(chatId, '⏳ Uploading to Dropbox...');

    await uploadToDropbox(
      session.filePath,
      session.fileName,
      session.folderPath
    );

    bot.sendMessage(
      chatId,
      `✅ Success! File "${session.fileName}" uploaded to "${session.folderPath}"`
    );

    // Clean up
    try {
      fs.unlinkSync(session.filePath);
    } catch (e) {
      // Ignore cleanup errors
    }

    userSessions.delete(chatId);
  } catch (error) {
    bot.sendMessage(
      chatId,
      `❌ Upload failed: ${error.message}\n\nPlease try again.`
    );
  }
}

/**
 * Error handler
 */
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Initialize
(async () => {
  console.log('🤖 Telegram Dropbox Bot starting...');

  if (!dropboxToken) {
    console.error('❌ DROPBOX_ACCESS_TOKEN not found in .env');
    process.exit(1);
  }

  console.log('✓ Bot is running. Send /start to begin.');
})();

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});

module.exports = { bot, uploadToDropbox };
