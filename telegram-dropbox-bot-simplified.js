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

// Store upload history (per user)
const uploadHistory = new Map();

// Folder structure will be loaded from JSON file
let folderStructure = {};
let allLevel1Folders = [];
let allLevel2Folders = [];

/**
 * Load folder structure from JSON file
 */
function loadFolderStructure() {
  try {
    const filePath = path.join(__dirname, 'folders.json');
    
    if (!fs.existsSync(filePath)) {
      console.warn('⚠️  folders.json not found.');
      return {};
    }

    const data = fs.readFileSync(filePath, 'utf8');
    folderStructure = JSON.parse(data);
    
    console.log('✓ Loaded folder structure:');
    for (const [key, value] of Object.entries(folderStructure)) {
      const blockCount = Object.keys(value).length;
      console.log(`  - ${key}: ${blockCount} blocks`);
      
      // Store all level1 folders
      allLevel1Folders = Object.keys(folderStructure);
      
      // Store all level2 folders (blocks)
      for (const [block, subfolders] of Object.entries(value)) {
        allLevel2Folders.push({ block, parent: key, subfolders });
      }
    }
    
    console.log(`✓ Total blocks loaded: ${allLevel2Folders.length}`);
    
    return folderStructure;
  } catch (error) {
    console.error('❌ Error loading folders.json:', error.message);
    return {};
  }
}

/**
 * Create all folders in Dropbox based on structure
 */
async function createAllFolders() {
  try {
    if (!dropboxToken) {
      throw new Error('Missing DROPBOX_ACCESS_TOKEN');
    }

    console.log('📁 Creating folder structure in Dropbox...');
    let createdCount = 0;
    let existingCount = 0;

    for (const [level1, level2Object] of Object.entries(folderStructure)) {
      // Create level 1 folder
      const result1 = await createFolder(`/${level1}`);
      if (result1) createdCount++; else existingCount++;

      // Create level 2 folders
      for (const [level2, level3Array] of Object.entries(level2Object)) {
        const level2Path = `/${level1}/${level2}`;
        const result2 = await createFolder(level2Path);
        if (result2) createdCount++; else existingCount++;

        // Create level 3 folders
        if (Array.isArray(level3Array)) {
          for (const level3 of level3Array) {
            const level3Path = `/${level1}/${level2}/${level3}`;
            const result3 = await createFolder(level3Path);
            if (result3) createdCount++; else existingCount++;
          }
        }
      }
    }

    console.log(`✓ Folder sync complete: ${createdCount} created, ${existingCount} already existed`);
  } catch (error) {
    console.error('❌ Error creating folders:', error.message);
  }
}

/**
 * Create a single folder in Dropbox
 */
async function createFolder(folderPath) {
  try {
    await axios.post(
      `${DROPBOX_RPC}/files/create_folder_v2`,
      { path: folderPath },
      {
        headers: {
          Authorization: `Bearer ${dropboxToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (error) {
    if (error.response?.status === 409) {
      return false;
    } else {
      throw error;
    }
  }
}

/**
 * Get breadcrumb navigation text
 */
function getBreadcrumb(level1, level2 = null, level3 = null) {
  let breadcrumb = `📍 ${level1}`;
  if (level2) breadcrumb += ` > ${level2}`;
  if (level3) breadcrumb += ` > ${level3}`;
  return breadcrumb;
}

/**
 * Get blocks keyboard with pagination (Skip main folder!)
 */
function getBlocksKeyboard(page = 0) {
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allLevel2Folders.length / itemsPerPage);
  const startIdx = page * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageBlocks = allLevel2Folders.slice(startIdx, endIdx);

  const buttons = pageBlocks.map((item, idx) => ({
    text: item.block,
    callback_data: `block_${page}_${idx}`
  }));

  // Add pagination buttons
  const paginationRow = [];
  if (page > 0) {
    paginationRow.push({ text: '⬅️ Prev', callback_data: `page_blocks_${page - 1}` });
  }
  if (page < totalPages - 1) {
    paginationRow.push({ text: 'Next ➡️', callback_data: `page_blocks_${page + 1}` });
  }

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 1) {
    keyboard.push([buttons[i]]);
  }

  if (paginationRow.length > 0) {
    keyboard.push(paginationRow);
  }

  return { inline_keyboard: keyboard };
}

/**
 * Get subfolders keyboard for a block
 */
function getSubfoldersKeyboard(blockItem) {
  const level3Array = blockItem.subfolders || [];
  
  if (level3Array.length === 0) {
    return {
      inline_keyboard: [[
        { text: '✓ Use this folder', callback_data: `confirm_${blockItem.parent}_${blockItem.block}_NONE` },
        { text: '⬅️ Back', callback_data: `back_to_blocks_0` }
      ]]
    };
  }

  const buttons = level3Array.map(folder => ({
    text: folder,
    callback_data: `subfolder_${folder}`
  }));

  const backButton = { text: '⬅️ Back', callback_data: `back_to_blocks_0` };

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) {
    keyboard.push(buttons.slice(i, i + 2));
  }
  keyboard.push([backButton]);

  return { inline_keyboard: keyboard };
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
 * Upload file to Dropbox
 */
async function uploadToDropbox(filePath, fileName, folderPath) {
  try {
    if (!dropboxToken) {
      throw new Error('Missing DROPBOX_ACCESS_TOKEN');
    }

    const fileContent = fs.readFileSync(filePath);
    const dropboxFilePath = `${folderPath}/${fileName}`;

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
    console.error('❌ Upload failed:', error.message);
    throw error;
  }
}

/**
 * Record upload to history
 */
function recordUpload(chatId, fileName, folderPath) {
  if (!uploadHistory.has(chatId)) {
    uploadHistory.set(chatId, []);
  }

  const history = uploadHistory.get(chatId);
  history.unshift({
    fileName,
    folderPath,
    timestamp: new Date().toLocaleString()
  });

  if (history.length > 10) {
    history.pop();
  }
}

/**
 * Start command
 */
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '🎉 *Welcome to Photo Organizer!*\n\n' +
    'Features:\n' +
    '✓ Easy block selection\n' +
    '✓ Pagination for all blocks\n' +
    '✓ Upload history\n\n' +
    'How to use:\n' +
    '1️⃣ Send me a photo\n' +
    '2️⃣ Choose a block\n' +
    '3️⃣ Choose subfolder\n' +
    '4️⃣ Upload! ✅\n\n' +
    '_Commands:_\n' +
    '/history - See recent uploads\n' +
    '/cancel - Cancel upload',
    { parse_mode: 'Markdown' }
  );
});

/**
 * Help command
 */
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  let helpText = `*Available Blocks:* (${allLevel2Folders.length} total)\n\n`;
  
  // Show first 10 blocks as example
  for (let i = 0; i < Math.min(10, allLevel2Folders.length); i++) {
    helpText += `• ${allLevel2Folders[i].block}\n`;
  }
  
  if (allLevel2Folders.length > 10) {
    helpText += `\n... and ${allLevel2Folders.length - 10} more blocks\n`;
  }

  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

/**
 * History command
 */
bot.onText(/\/history/, (msg) => {
  const chatId = msg.chat.id;
  const history = uploadHistory.get(chatId) || [];

  if (history.length === 0) {
    bot.sendMessage(chatId, '📋 No upload history yet');
    return;
  }

  let historyText = '*📋 Recent Uploads (Last 10):*\n\n';
  
  history.forEach((entry, index) => {
    historyText += `${index + 1}. ${entry.fileName}\n`;
    historyText += `   📁 ${entry.folderPath}\n`;
    historyText += `   🕐 ${entry.timestamp}\n\n`;
  });

  bot.sendMessage(chatId, historyText, { parse_mode: 'Markdown' });
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

    bot.sendMessage(
      chatId,
      '📝 *What filename do I use?*\n\n(Include extension or I\'ll add .jpg)',
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    bot.sendMessage(chatId, '❌ Failed to process photo. Try again.');
  }
});

/**
 * Handle text input (filename)
 */
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/')) return;

  const session = userSessions.get(chatId);

  if (!session) return;

  if (!session.fileName) {
    session.fileName = text;

    if (!session.fileName.includes('.')) {
      session.fileName += '.jpg';
    }

    // Skip main folder, go straight to blocks
    bot.sendMessage(
      chatId,
      '🔍 *Choose a block:*',
      { reply_markup: getBlocksKeyboard(0) }
    );
  }
});

/**
 * Handle callback queries (button clicks)
 */
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = userSessions.get(chatId);

  if (!session) {
    bot.answerCallbackQuery(query.id, 'Session expired', true);
    return;
  }

  // Pagination for blocks
  if (data.startsWith('page_blocks_')) {
    const page = parseInt(data.replace('page_blocks_', ''));
    bot.editMessageText(
      '🔍 *Choose a block:*',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getBlocksKeyboard(page),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Block selection
  if (data.startsWith('block_')) {
    const parts = data.replace('block_', '').split('_');
    const page = parseInt(parts[0]);
    const idx = parseInt(parts[1]);
    
    const itemsPerPage = 5;
    const startIdx = page * itemsPerPage;
    const blockItem = allLevel2Folders[startIdx + idx];
    
    if (!blockItem) {
      bot.answerCallbackQuery(query.id, 'Block not found', true);
      return;
    }

    session.blockItem = blockItem;
    session.level1 = blockItem.parent;
    session.level2 = blockItem.block;

    bot.editMessageText(
      `📁 *${getBreadcrumb(blockItem.parent, blockItem.block)}*\n\nChoose a subfolder:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getSubfoldersKeyboard(blockItem),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Back to blocks
  if (data.startsWith('back_to_blocks_')) {
    const page = parseInt(data.replace('back_to_blocks_', ''));
    bot.editMessageText(
      '🔍 *Choose a block:*',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getBlocksKeyboard(page),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Subfolder selection
  if (data.startsWith('subfolder_')) {
    const level3Folder = data.replace('subfolder_', '');
    const blockItem = session.blockItem;

    session.level3 = level3Folder;

    await showConfirmation(chatId, query.message.message_id, session);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Upload confirmation
  if (data === 'confirm_upload') {
    await processUpload(chatId, session);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Cancel from confirmation
  if (data === 'cancel_upload') {
    bot.answerCallbackQuery(query.id);
    bot.deleteMessage(chatId, query.message.message_id);
    
    if (session.filePath) {
      try {
        fs.unlinkSync(session.filePath);
      } catch (e) {}
    }
    userSessions.delete(chatId);
    
    bot.sendMessage(chatId, '❌ Upload cancelled.');
    return;
  }
});

/**
 * Show confirmation before upload
 */
async function showConfirmation(chatId, messageId, session) {
  const folderPath = session.level3
    ? `/${session.level1}/${session.level2}/${session.level3}`
    : `/${session.level1}/${session.level2}`;

  const confirmKeyboard = {
    inline_keyboard: [[
      { text: '✅ Upload', callback_data: 'confirm_upload' },
      { text: '❌ Cancel', callback_data: 'cancel_upload' }
    ]]
  };

  bot.editMessageText(
    `✅ *Ready to Upload*\n\n` +
    `📄 File: \`${session.fileName}\`\n` +
    `📁 Folder: \`${folderPath}\`\n\n` +
    'Proceed?',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: confirmKeyboard,
      parse_mode: 'Markdown'
    }
  );

  session.folderPath = folderPath;
  session.confirming = true;
}

/**
 * Process the upload
 */
async function processUpload(chatId, session) {
  try {
    const statusMsg = await bot.sendMessage(chatId, '⏳ Uploading to Dropbox...');

    await uploadToDropbox(
      session.filePath,
      session.fileName,
      session.folderPath
    );

    recordUpload(chatId, session.fileName, session.folderPath);

    bot.editMessageText(
      `✅ *Success!*\n\n` +
      `📄 File: \`${session.fileName}\`\n` +
      `📁 Folder: \`${session.folderPath}\`\n\n` +
      'Ready for another? Send /start\n' +
      'View history: /history',
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
    bot.sendMessage(
      chatId,
      `❌ Upload failed: ${error.message}\n\nTry again with /start`
    );
  }
}

/**
 * Error handlers
 */
bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Initialize
(async () => {
  console.log('🤖 Telegram Dropbox Bot (Simplified - No Main Folder) starting...');

  if (!dropboxToken) {
    console.error('❌ DROPBOX_ACCESS_TOKEN not found in .env');
    process.exit(1);
  }

  folderStructure = loadFolderStructure();

  if (Object.keys(folderStructure).length === 0) {
    console.error('❌ No folders loaded. Please check folders.json');
    process.exit(1);
  }

  await createAllFolders();

  console.log('✓ Bot is running. Send /start to begin.');
  console.log(`✓ Simplified flow: Photo → Filename → Block Selection → Subfolder → Upload`);
})();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});

module.exports = { bot, uploadToDropbox };
