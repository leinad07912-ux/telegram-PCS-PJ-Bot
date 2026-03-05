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
      console.log(`  - ${key}: ${blockCount} subfolders`);
    }
    
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
    return true; // Created
  } catch (error) {
    if (error.response?.status === 409) {
      return false; // Already exists
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
 * Get level 1 keyboard with pagination
 */
function getLevel1Keyboard(page = 0) {
  const allFolders = Object.keys(folderStructure);
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allFolders.length / itemsPerPage);
  const startIdx = page * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageFolders = allFolders.slice(startIdx, endIdx);

  const buttons = pageFolders.map(folder => ({
    text: folder,
    callback_data: `level1_${folder}`
  }));

  // Add pagination buttons
  const paginationRow = [];
  if (page > 0) {
    paginationRow.push({ text: '⬅️ Prev', callback_data: `page1_${page - 1}` });
  }
  if (page < totalPages - 1) {
    paginationRow.push({ text: 'Next ➡️', callback_data: `page1_${page + 1}` });
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
 * Get level 2 keyboard with pagination and search
 */
function getLevel2Keyboard(level1Folder, page = 0) {
  const allSubfolders = Object.keys(folderStructure[level1Folder] || {});
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allSubfolders.length / itemsPerPage);
  const startIdx = page * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageSubfolders = allSubfolders.slice(startIdx, endIdx);

  const buttons = pageSubfolders.map(subfolder => ({
    text: subfolder,
    callback_data: `level2_${level1Folder}_${subfolder}`
  }));

  // Add pagination buttons
  const paginationRow = [];
  if (page > 0) {
    paginationRow.push({ text: '⬅️ Prev', callback_data: `page2_${level1Folder}_${page - 1}` });
  }
  if (page < totalPages - 1) {
    paginationRow.push({ text: 'Next ➡️', callback_data: `page2_${level1Folder}_${page + 1}` });
  }

  // Add back button
  const backButton = [{ text: '⬅️ Back', callback_data: 'back_to_level1' }];

  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 1) {
    keyboard.push([buttons[i]]);
  }

  if (paginationRow.length > 0) {
    keyboard.push(paginationRow);
  }
  keyboard.push(backButton);

  return { inline_keyboard: keyboard };
}

/**
 * Get level 3 keyboard
 */
function getLevel3Keyboard(level1Folder, level2Folder) {
  const level3Array = folderStructure[level1Folder]?.[level2Folder] || [];
  
  if (level3Array.length === 0) {
    return {
      inline_keyboard: [[
        { text: '✓ Use this folder', callback_data: `confirm_${level1Folder}_${level2Folder}_NONE` },
        { text: '⬅️ Back', callback_data: `back_to_level2_${level1Folder}` }
      ]]
    };
  }

  const buttons = level3Array.map(folder => ({
    text: folder,
    callback_data: `level3_${level1Folder}_${level2Folder}_${folder}`
  }));

  const backButton = { text: '⬅️ Back', callback_data: `back_to_level2_${level1Folder}` };

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

  // Keep only last 10 uploads
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
    '🎉 *Welcome to Advanced Photo Organizer!*\n\n' +
    'Features:\n' +
    '✓ Smart folder navigation\n' +
    '✓ Pagination for many folders\n' +
    '✓ Upload history\n' +
    '✓ Breadcrumb navigation\n\n' +
    'How to use:\n' +
    '1️⃣ Send me a photo\n' +
    '2️⃣ Choose folders with buttons\n' +
    '3️⃣ Confirm and upload! ✅\n\n' +
    '_Commands:_\n' +
    '/history - See recent uploads\n' +
    '/help - See all folders\n' +
    '/cancel - Cancel upload',
    { parse_mode: 'Markdown' }
  );
});

/**
 * Help command
 */
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  let folderList = '*Available Main Folders:*\n\n';
  
  for (const [level1, level2Object] of Object.entries(folderStructure)) {
    const blockCount = Object.keys(level2Object).length;
    folderList += `📁 *${level1}* (${blockCount} items)\n`;
  }

  bot.sendMessage(chatId, folderList, { parse_mode: 'Markdown' });
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

    bot.sendMessage(
      chatId,
      '📁 *Choose a main folder:*',
      { reply_markup: getLevel1Keyboard(0) }
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

  // Pagination for level 1
  if (data.startsWith('page1_')) {
    const page = parseInt(data.replace('page1_', ''));
    bot.editMessageText(
      '📁 *Choose a main folder:*',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel1Keyboard(page),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Pagination for level 2
  if (data.startsWith('page2_')) {
    const parts = data.replace('page2_', '').split('_');
    const level1Folder = parts[0];
    const page = parseInt(parts[1]);
    
    bot.editMessageText(
      `📁 *${getBreadcrumb(level1Folder)}*\n\nChoose a subfolder:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel2Keyboard(level1Folder, page),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Back to level 1
  if (data === 'back_to_level1') {
    bot.editMessageText(
      '📁 *Choose a main folder:*',
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel1Keyboard(0),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Back to level 2
  if (data.startsWith('back_to_level2_')) {
    const level1Folder = data.replace('back_to_level2_', '');
    bot.editMessageText(
      `📁 *${getBreadcrumb(level1Folder)}*\n\nChoose a subfolder:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel2Keyboard(level1Folder, 0),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Level 1 selection
  if (data.startsWith('level1_')) {
    const level1Folder = data.replace('level1_', '');
    session.level1 = level1Folder;

    bot.editMessageText(
      `📁 *${getBreadcrumb(level1Folder)}*\n\nChoose a subfolder:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel2Keyboard(level1Folder, 0),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Level 2 selection
  if (data.startsWith('level2_')) {
    const parts = data.replace('level2_', '').split('_');
    const level1Folder = parts[0];
    const level2Folder = parts.slice(1).join('_');
    
    session.level1 = level1Folder;
    session.level2 = level2Folder;

    bot.editMessageText(
      `📁 *${getBreadcrumb(level1Folder, level2Folder)}*\n\nChoose a subfolder:`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getLevel3Keyboard(level1Folder, level2Folder),
        parse_mode: 'Markdown'
      }
    );
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Level 3 selection
  if (data.startsWith('level3_')) {
    const parts = data.replace('level3_', '').split('_');
    const level1Folder = parts[0];
    const level2Folder = parts[1];
    const level3Folder = parts.slice(2).join('_');

    session.level1 = level1Folder;
    session.level2 = level2Folder;
    session.level3 = level3Folder;

    await showConfirmation(chatId, query.message.message_id, session);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Confirm (no level 3)
  if (data.startsWith('confirm_')) {
    const parts = data.replace('confirm_', '').split('_');
    const level1Folder = parts[0];
    const level2Folder = parts[1];
    const level3Folder = parts[2] === 'NONE' ? null : parts[2];

    session.level1 = level1Folder;
    session.level2 = level2Folder;
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

    // Record to history
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
  console.log('🤖 Telegram Dropbox Bot (Advanced Folder List Mode) starting...');

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
  console.log('✓ Advanced features enabled: pagination, breadcrumbs, history');
})();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});

module.exports = { bot, uploadToDropbox };
