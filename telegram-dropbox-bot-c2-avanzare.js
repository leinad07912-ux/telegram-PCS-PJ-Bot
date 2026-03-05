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

// Get credentials from environment
const dropboxClientId = process.env.DROPBOX_CLIENT_ID;
const dropboxClientSecret = process.env.DROPBOX_CLIENT_SECRET;
const dropboxRefreshToken = process.env.DROPBOX_REFRESH_TOKEN;

// Store current access token
let currentAccessToken = null;
let tokenExpiry = null;

// Store user sessions
const userSessions = new Map();
const uploadHistory = new Map();

// Folder structure
let folderStructure = {};
let allBlocks = []; // Level 3 folders (the blocks)

// FIXED levels (don't change)
const FIXED_LEVEL1 = "C2 - Avanzare";
const FIXED_LEVEL2 = "Installation Report";

/**
 * Get fresh access token using refresh token
 */
async function getAccessToken() {
  try {
    // Check if current token is still valid
    if (currentAccessToken && tokenExpiry && Date.now() < tokenExpiry) {
      return currentAccessToken;
    }

    console.log('🔄 Refreshing Dropbox access token...');

    const response = await axios.post('https://www.dropbox.com/oauth2/token', {
      client_id: dropboxClientId,
      client_secret: dropboxClientSecret,
      refresh_token: dropboxRefreshToken,
      grant_type: 'refresh_token'
    });

    currentAccessToken = response.data.access_token;
    tokenExpiry = Date.now() + ((response.data.expires_in - 300) * 1000);
    
    console.log('✓ Access token refreshed successfully');
    return currentAccessToken;
  } catch (error) {
    console.error('❌ Failed to refresh access token:', error.response?.data || error.message);
    throw new Error('Failed to get Dropbox access token');
  }
}

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
    
    // Extract all blocks from the fixed level 1 and level 2
    const level1Data = folderStructure[FIXED_LEVEL1];
    
    if (!level1Data) {
      console.error(`❌ Cannot find "${FIXED_LEVEL1}" in folders.json`);
      return {};
    }

    const level2Data = level1Data[FIXED_LEVEL2];
    
    if (!level2Data) {
      console.error(`❌ Cannot find "${FIXED_LEVEL2}" under "${FIXED_LEVEL1}" in folders.json`);
      return {};
    }

    // level2Data is an object with blocks as keys
    // Example: { "Blk 103 Yishun Ring Road": [...], "Blk 106 Yishun Ring Road": [...], ... }
    for (const [blockName, subfolders] of Object.entries(level2Data)) {
      allBlocks.push({
        name: blockName,
        subfolders: subfolders || []
      });
    }

    console.log(`  - ${FIXED_LEVEL1}`);
    console.log(`    - ${FIXED_LEVEL2}`);
    console.log(`      - ${allBlocks.length} blocks loaded`);
    
    return folderStructure;
  } catch (error) {
    console.error('❌ Error loading folders.json:', error.message);
    return {};
  }
}

/**
 * Create all folders in Dropbox
 */
async function createAllFolders() {
  try {
    const accessToken = await getAccessToken();
    
    console.log('📁 Creating folder structure in Dropbox...');
    let createdCount = 0;
    let existingCount = 0;

    for (const [level1, level1Data] of Object.entries(folderStructure)) {
      // Create level 1
      const result1 = await createFolder(`/${level1}`, accessToken);
      if (result1) createdCount++; else existingCount++;

      for (const [level2, level2Data] of Object.entries(level1Data)) {
        // Create level 2
        const level2Path = `/${level1}/${level2}`;
        const result2 = await createFolder(level2Path, accessToken);
        if (result2) createdCount++; else existingCount++;

        // Create level 3 (blocks)
        if (typeof level2Data === 'object') {
          for (const [block, subfolders] of Object.entries(level2Data)) {
            const level3Path = `/${level1}/${level2}/${block}`;
            const result3 = await createFolder(level3Path, accessToken);
            if (result3) createdCount++; else existingCount++;

            // Create level 4 (subfolders like Folder 1, Folder 2)
            if (Array.isArray(subfolders)) {
              for (const subfolder of subfolders) {
                const level4Path = `/${level1}/${level2}/${block}/${subfolder}`;
                const result4 = await createFolder(level4Path, accessToken);
                if (result4) createdCount++; else existingCount++;
              }
            }
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
async function createFolder(folderPath, accessToken) {
  try {
    await axios.post(
      `${DROPBOX_RPC}/files/create_folder_v2`,
      { path: folderPath },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return true;
  } catch (error) {
    if (error.response?.status === 409) {
      return false; // Already exists
    } else {
      throw error;
    }
  }
}

/**
 * Get blocks keyboard with pagination
 */
function getBlocksKeyboard(page = 0) {
  const itemsPerPage = 5;
  const totalPages = Math.ceil(allBlocks.length / itemsPerPage);
  const startIdx = page * itemsPerPage;
  const endIdx = startIdx + itemsPerPage;
  const pageBlocks = allBlocks.slice(startIdx, endIdx);

  const buttons = pageBlocks.map((block, idx) => ({
    text: block.name,
    callback_data: `block_${page}_${idx}`
  }));

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
 * Get subfolders keyboard (Folder 1, Folder 2, etc.)
 */
function getSubfoldersKeyboard(block) {
  const subfolders = block.subfolders || [];
  
  if (subfolders.length === 0) {
    return {
      inline_keyboard: [[
        { text: '✓ Use this folder', callback_data: `confirm_${block.name}_NONE` },
        { text: '⬅️ Back', callback_data: `back_to_blocks_0` }
      ]]
    };
  }

  const buttons = subfolders.map(folder => ({
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
 * Download photo
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
    console.error('❌ Photo download failed:', error.message);
    throw error;
  }
}

/**
 * Upload file to Dropbox
 */
async function uploadToDropbox(filePath, fileName, folderPath) {
  try {
    const accessToken = await getAccessToken();

    const fileContent = fs.readFileSync(filePath);
    const dropboxFilePath = `${folderPath}/${fileName}`;

    const uploadResponse = await axios.post(
      `${DROPBOX_API}/files/upload`,
      fileContent,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
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
 * Record upload
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

// ========== BOT COMMANDS ==========

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(
    chatId,
    '🎉 *Welcome to C2 - Avanzare Photo Organizer!*\n\n' +
    'How to use:\n' +
    '1️⃣ Send me a photo\n' +
    '2️⃣ Type a filename\n' +
    '3️⃣ Choose a block (Blk 103, 106, etc.)\n' +
    '4️⃣ Choose a subfolder (Folder 1 or Folder 2)\n' +
    '5️⃣ Upload! ✅\n\n' +
    '_Commands:_\n' +
    '/help - See all blocks\n' +
    '/history - View recent uploads\n' +
    '/cancel - Cancel upload',
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  
  let helpText = `*Project: ${FIXED_LEVEL1}*\n`;
  helpText += `*Folder: ${FIXED_LEVEL2}*\n\n`;
  helpText += `*Available Blocks:* (${allBlocks.length} total)\n\n`;
  
  for (let i = 0; i < Math.min(10, allBlocks.length); i++) {
    helpText += `• ${allBlocks[i].name}\n`;
  }
  
  if (allBlocks.length > 10) {
    helpText += `\n... and ${allBlocks.length - 10} more blocks\n`;
  }

  bot.sendMessage(chatId, helpText, { parse_mode: 'Markdown' });
});

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
      `🏢 *Project: ${FIXED_LEVEL1}*\n📁 *Folder: ${FIXED_LEVEL2}*\n\n🔍 *Choose a block:*`,
      { reply_markup: getBlocksKeyboard(0), parse_mode: 'Markdown' }
    );
  }
});

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data;
  const session = userSessions.get(chatId);

  if (!session) {
    bot.answerCallbackQuery(query.id, 'Session expired', true);
    return;
  }

  // Pagination
  if (data.startsWith('page_blocks_')) {
    const page = parseInt(data.replace('page_blocks_', ''));
    bot.editMessageText(
      `🏢 *Project: ${FIXED_LEVEL1}*\n📁 *Folder: ${FIXED_LEVEL2}*\n\n🔍 *Choose a block:*`,
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
    const block = allBlocks[startIdx + idx];
    
    if (!block) {
      bot.answerCallbackQuery(query.id, 'Block not found', true);
      return;
    }

    session.block = block;
    session.blockName = block.name;

    bot.editMessageText(
      `🏢 ${FIXED_LEVEL1} / ${FIXED_LEVEL2} / ${block.name}\n\n📂 *Choose a subfolder:*`,
      {
        chat_id: chatId,
        message_id: query.message.message_id,
        reply_markup: getSubfoldersKeyboard(block),
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
      `🏢 *Project: ${FIXED_LEVEL1}*\n📁 *Folder: ${FIXED_LEVEL2}*\n\n🔍 *Choose a block:*`,
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
    const subfolder = data.replace('subfolder_', '');
    session.subfolder = subfolder;

    await showConfirmation(chatId, query.message.message_id, session);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Confirm upload
  if (data === 'confirm_upload') {
    await processUpload(chatId, session);
    bot.answerCallbackQuery(query.id);
    return;
  }

  // Cancel
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

async function showConfirmation(chatId, messageId, session) {
  const folderPath = `/${FIXED_LEVEL1}/${FIXED_LEVEL2}/${session.blockName}/${session.subfolder}`;

  const confirmKeyboard = {
    inline_keyboard: [[
      { text: '✅ Upload', callback_data: 'confirm_upload' },
      { text: '❌ Cancel', callback_data: 'cancel_upload' }
    ]]
  };

  bot.editMessageText(
    `✅ *Ready to Upload*\n\n` +
    `📄 File: \`${session.fileName}\`\n` +
    `📁 Path: \`${folderPath}\`\n\n` +
    'Proceed?',
    {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: confirmKeyboard,
      parse_mode: 'Markdown'
    }
  );

  session.folderPath = folderPath;
}

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
      `📁 Path: \`${session.folderPath}\`\n\n` +
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

bot.on('polling_error', (error) => {
  console.error('Polling error:', error.code, error.message);
});

bot.on('error', (error) => {
  console.error('Bot error:', error);
});

// Initialize
(async () => {
  console.log('🤖 Telegram Dropbox Bot (C2 - Avanzare) starting...');

  if (!dropboxClientId || !dropboxClientSecret || !dropboxRefreshToken) {
    console.error('❌ Missing Dropbox credentials in .env');
    console.error('   Required: DROPBOX_CLIENT_ID, DROPBOX_CLIENT_SECRET, DROPBOX_REFRESH_TOKEN');
    process.exit(1);
  }

  folderStructure = loadFolderStructure();

  if (Object.keys(folderStructure).length === 0 || allBlocks.length === 0) {
    console.error('❌ No folders/blocks loaded. Please check folders.json');
    process.exit(1);
  }

  await createAllFolders();

  console.log('✓ Bot is running. Send /start to begin.');
  console.log(`✓ Fixed: ${FIXED_LEVEL1} > ${FIXED_LEVEL2}`);
  console.log(`✓ User selects from ${allBlocks.length} blocks`);
})();

process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  bot.stopPolling();
  process.exit(0);
});

module.exports = { bot, uploadToDropbox };
