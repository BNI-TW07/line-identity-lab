/**
 * 研發室｜題目1 階段③ 選單查詢   v0.3   2026-11-22
 * （包含階段② 身分綁定的全部功能）
 *
 * Script Properties（專案設定 → 指令碼屬性）：
 *   LINE_CHANNEL_ACCESS_TOKEN  Messaging API 長期 token
 *   WEBHOOK_KEY                webhook 網址密鑰
 *   LINE_LOGIN_CHANNEL_ID      LINE Login channel 的 Channel ID
 *   LIFF_ID                    LIFF ID
 *   SHEET_ID                   試算表 ID
 *   ORG_NAME                   寄信署名
 *   OTP_SALT                   setupSheets 自動產生
 *   RICHMENU_IMAGE_URL         圖文選單圖片網址（階段③新增，手動）
 *   RICHMENU_ID                createRichMenu 自動產生
 *
 * 可在編輯器手動執行：setupSheets、checkSetup、createRichMenu、deleteRichMenu、generateWebhookKey
 */

const PROPS = PropertiesService.getScriptProperties();

// ================= 設定區（組織中立：表名、欄位名、狀態值都在這裡改） =================
const CONFIG = {
  sheets: {
    members:  { name: '會員', cols: ['會員ID', '姓名', 'Email', '狀態'] },
    bindings: { name: '綁定', cols: ['userId', '會員ID', '狀態', '綁定時間', '撤銷時間'] },
    logs:     { name: '紀錄', cols: ['時間', '動作', 'userId末4碼', '結果'] },
    results:  { name: '結果', cols: ['會員ID', '期別', '燈號', '總分', '出席', '引薦', '來賓', '一對一'] }
  },
  // 查詢卡片設定：讀哪些欄、怎麼顯示（換成其他結果表時只改這裡）
  resultCard: {
    title: '我的本期數據',
    keyCol: '會員ID',
    periodCol: '期別',
    statusCol: '燈號',
    statusColors: { '綠': '#06C755', '黃': '#F5B400', '紅': '#E53935' },
    showCols: ['總分', '出席', '引薦', '來賓', '一對一']
  },
  // 觸發查詢的方式：圖文選單 postback 的 data，或使用者輸入的關鍵字
  actions: {
    myResult: { postback: 'action=my_result', keywords: ['我的數據', '查詢'] }
  },
  memberActive: '在籍',
  bindingActive: '有效',
  bindingRevoked: '撤銷',
  otp: {
    ttlSec: 600,           // 驗證碼有效 10 分鐘
    maxTries: 5,           // 最多錯 5 次
    cooldownSec: 60,       // 60 秒內不能重寄
    maxSendPerWindow: 5,   // 每個時段最多寄 5 次
    windowSec: 21600       // 時段長度 6 小時（CacheService 上限）
  }
};

// ================= 進入點 =================
function doPost(e) {
  // 網址帶 ?k= 的是 LINE webhook；其他是 LIFF 網頁呼叫的 API
  if (e && e.parameter && e.parameter.k !== undefined) return handleWebhook_(e);
  return handleApi_(e);
}

function doGet() {
  return ContentService.createTextOutput('研發_題目1 運作中');
}

// ================= Webhook（唯讀：只查詢、只用 reply） =================
function handleWebhook_(e) {
  const t0 = Date.now();
  const key = PROPS.getProperty('WEBHOOK_KEY');
  if (!key || e.parameter.k !== key) {
    console.warn('webhook 密鑰不符，已忽略');
    return text_('OK');
  }
  let body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return text_('OK'); }

  (body.events || []).forEach(function (ev) {
    if (!ev.replyToken) return;
    const isText = ev.type === 'message' && ev.message.type === 'text';
    if (!isText && ev.type !== 'postback') return;

    const uid = (ev.source && ev.source.userId) || '';
    const a = CONFIG.actions.myResult;
    const wantResult = isText
      ? a.keywords.indexOf(ev.message.text.trim()) >= 0
      : ev.postback.data === a.postback;

    const identity = getIdentity_(uid);
    let message;
    if (!identity) {
      message = bindPrompt_(null);                 // 未綁定：一律引導綁定
    } else if (wantResult) {
      const row = findLatestResult_(identity.memberId);
      message = row
        ? resultFlex_(identity, row, Date.now() - t0)
        : { type: 'text', text: identity.name + '您好，目前查無您的資料。' };
    } else {
      message = bindPrompt_(identity);
    }

    const status = reply_(ev.replyToken, [message]);
    console.log(JSON.stringify({
      uid4: uid.slice(-4), bound: !!identity, query: wantResult,
      waitedMs: t0 - ev.timestamp, totalMs: Date.now() - t0, replyStatus: status
    }));
  });
  return text_('OK');
}

/** 找出該會員最新一期的結果（期別最大者） */
function findLatestResult_(memberId) {
  const c = CONFIG.resultCard;
  let best = null;
  table_('results').rows.forEach(function (r) {
    if (r[c.keyCol] !== memberId) return;
    r[c.periodCol] = periodText_(r[c.periodCol]);
    if (!best || r[c.periodCol] > best[c.periodCol]) best = r;
  });
  return best;
}

function periodText_(v) {
  return v instanceof Date ? Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM') : String(v);
}

/** 組成個人查詢卡片（Flex Message） */
function resultFlex_(identity, row, elapsedMs) {
  const c = CONFIG.resultCard;
  const status = String(row[c.statusCol]);
  const color = c.statusColors[status] || '#999999';
  const liffUrl = 'https://liff.line.me/' + PROPS.getProperty('LIFF_ID');

  const rows = c.showCols.map(function (col) {
    return {
      type: 'box', layout: 'baseline', contents: [
        { type: 'text', text: col, size: 'sm', color: '#888888', flex: 3 },
        { type: 'text', text: String(row[col] === '' ? '-' : row[col]), size: 'sm', align: 'end', flex: 2 }
      ]
    };
  });

  return {
    type: 'flex',
    altText: c.title + '：' + status + '燈',
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', contents: [
          { type: 'text', text: c.title, weight: 'bold', size: 'lg' },
          { type: 'text', text: identity.name + '｜' + row[c.periodCol], size: 'sm', color: '#888888' }
        ]
      },
      body: {
        type: 'box', layout: 'vertical', spacing: 'md', contents: [
          {
            type: 'box', layout: 'horizontal', alignItems: 'center', contents: [
              { type: 'box', layout: 'vertical', width: '28px', height: '28px', cornerRadius: '14px', backgroundColor: color, contents: [] },
              { type: 'text', text: status + '燈', weight: 'bold', size: 'xl', color: color, margin: 'md' }
            ]
          },
          { type: 'separator' },
          { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows }
        ]
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', contents: [
          { type: 'button', style: 'link', height: 'sm', action: { type: 'uri', label: '查看完整頁面', uri: liffUrl } },
          { type: 'text', text: '查詢耗時 ' + elapsedMs + ' ms（研發測試用）', size: 'xxs', color: '#BBBBBB', align: 'center' }
        ]
      }
    }
  };
}

function bindPrompt_(identity) {
  const liffUrl = 'https://liff.line.me/' + PROPS.getProperty('LIFF_ID');
  const msg = identity
    ? '您好，' + identity.name + '\n已完成身分綁定。'
    : '您尚未綁定會員身分，請點下方按鈕完成綁定。';
  return {
    type: 'template',
    altText: msg,
    template: {
      type: 'buttons',
      text: msg,
      actions: [{ type: 'uri', label: identity ? '管理綁定' : '前往綁定', uri: liffUrl }]
    }
  };
}

// ================= API（所有寫入都在這裡，一律先驗證 ID token） =================
function handleApi_(e) {
  let req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'BAD_REQUEST' }); }

  const userId = verifyIdToken_(req.idToken);
  if (!userId) return json_({ ok: false, error: 'AUTH_FAILED' });

  try {
    switch (req.action) {
      case 'status':      return json_(apiStatus_(userId));
      case 'requestCode': return json_(apiRequestCode_(userId, String(req.email || '')));
      case 'verifyCode':  return json_(apiVerifyCode_(userId, String(req.code || '')));
      case 'unbind':      return json_(apiUnbind_(userId));
      default:            return json_({ ok: false, error: 'UNKNOWN_ACTION' });
    }
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, error: 'SERVER_ERROR' });
  }
}

function apiStatus_(userId) {
  const id = getIdentity_(userId);
  return { ok: true, bound: !!id, name: id ? id.name : null };
}

function apiRequestCode_(userId, email) {
  const o = CONFIG.otp;
  const cache = CacheService.getScriptCache();
  email = email.trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, error: 'EMAIL_FORMAT' };
  if (cache.get('cd_' + userId)) return { ok: false, error: 'COOLDOWN' };
  const sent = Number(cache.get('cnt_' + userId) || 0);
  if (sent >= o.maxSendPerWindow) return { ok: false, error: 'TOO_MANY' };

  // 不論是否為會員都計次，避免被拿來探測名單
  cache.put('cd_' + userId, '1', o.cooldownSec);
  cache.put('cnt_' + userId, String(sent + 1), o.windowSec);

  const m = table_('members').rows.find(function (r) {
    return String(r['Email']).trim().toLowerCase() === email && r['狀態'] === CONFIG.memberActive;
  });
  if (!m) {
    log_('寄送驗證碼', userId, '查無在籍會員（未寄信）');
    return { ok: true }; // 回應與成功時相同，不透露是否為會員
  }
  if (MailApp.getRemainingDailyQuota() < 1) {
    log_('寄送驗證碼', userId, '寄信額度已滿');
    return { ok: false, error: 'MAIL_QUOTA' };
  }

  const code = String(parseInt(Utilities.getUuid().replace(/-/g, '').slice(0, 12), 16) % 1000000).padStart(6, '0');
  cache.put('otp_' + userId, JSON.stringify({
    memberId: m['會員ID'],
    hash: sha_(code + userId + PROPS.getProperty('OTP_SALT')),
    tries: 0,
    exp: Date.now() + o.ttlSec * 1000
  }), o.ttlSec);

  const org = PROPS.getProperty('ORG_NAME') || '會員服務';
  MailApp.sendEmail({
    to: email,
    name: org,
    subject: '【' + org + '】身分綁定驗證碼',
    body: '您的驗證碼是：' + code + '\n\n10 分鐘內有效。\n若不是您本人操作，請忽略這封信。'
  });
  log_('寄送驗證碼', userId, '已寄出（' + m['會員ID'] + '）');
  return { ok: true };
}

function apiVerifyCode_(userId, code) {
  const o = CONFIG.otp;
  const cache = CacheService.getScriptCache();
  const key = 'otp_' + userId;
  const raw = cache.get(key);
  if (!raw) return { ok: false, error: 'CODE_EXPIRED' };
  const st = JSON.parse(raw);
  const remainSec = Math.floor((st.exp - Date.now()) / 1000);
  if (remainSec <= 0) { cache.remove(key); return { ok: false, error: 'CODE_EXPIRED' }; }

  if (sha_(code.trim() + userId + PROPS.getProperty('OTP_SALT')) !== st.hash) {
    st.tries++;
    if (st.tries >= o.maxTries) {
      cache.remove(key);
      log_('驗證', userId, '錯誤次數過多，驗證碼作廢');
      return { ok: false, error: 'TOO_MANY_TRIES' };
    }
    cache.put(key, JSON.stringify(st), remainSec);
    log_('驗證', userId, '驗證碼錯誤（第 ' + st.tries + ' 次）');
    return { ok: false, error: 'CODE_WRONG', remaining: o.maxTries - st.tries };
  }
  cache.remove(key);

  // 寫入綁定：同一 userId 或同一會員的舊綁定一律撤銷（一人一帳號）
  let replaced = false;
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const t = table_('bindings');
    const now = new Date();
    t.rows.forEach(function (r) {
      if (r['狀態'] !== CONFIG.bindingActive) return;
      if (r['userId'] === userId || r['會員ID'] === st.memberId) {
        if (r['會員ID'] === st.memberId && r['userId'] !== userId) replaced = true;
        setCell_(t, r, '狀態', CONFIG.bindingRevoked);
        setCell_(t, r, '撤銷時間', now);
      }
    });
    appendRow_(t, { 'userId': userId, '會員ID': st.memberId, '狀態': CONFIG.bindingActive, '綁定時間': now, '撤銷時間': '' });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  if (replaced) notifyRebind_(st.memberId);
  log_('驗證', userId, replaced ? '綁定成功（取代舊 LINE 帳號）' : '綁定成功（' + st.memberId + '）');
  const id = getIdentity_(userId);
  return { ok: true, name: id ? id.name : null };
}

function apiUnbind_(userId) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  let n = 0;
  try {
    const t = table_('bindings');
    t.rows.forEach(function (r) {
      if (r['userId'] === userId && r['狀態'] === CONFIG.bindingActive) {
        setCell_(t, r, '狀態', CONFIG.bindingRevoked);
        setCell_(t, r, '撤銷時間', new Date());
        n++;
      }
    });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  log_('解除綁定', userId, n ? '已解除' : '原本就未綁定');
  return { ok: true };
}

// ================= 身分與驗證 =================
/** 依 userId 找出有效綁定且在籍的會員；任何一項不符都回傳 null */
function getIdentity_(userId) {
  if (!userId) return null;
  const b = table_('bindings').rows.find(function (r) {
    return r['userId'] === userId && r['狀態'] === CONFIG.bindingActive;
  });
  if (!b) return null;
  const m = table_('members').rows.find(function (r) {
    return r['會員ID'] === b['會員ID'] && r['狀態'] === CONFIG.memberActive;
  });
  return m ? { memberId: m['會員ID'], name: m['姓名'] } : null;
}

/** 呼叫 LINE 驗證端點確認 ID token，成功回傳 userId（sub），結果快取到 token 到期前 */
function verifyIdToken_(idToken) {
  if (!idToken || typeof idToken !== 'string') return null;
  const cache = CacheService.getScriptCache();
  const ck = 'idt_' + sha_(idToken);
  const hit = cache.get(ck);
  if (hit) return hit;

  const res = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: { id_token: idToken, client_id: PROPS.getProperty('LINE_LOGIN_CHANNEL_ID') },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    console.warn('ID token 驗證失敗：' + res.getContentText());
    return null;
  }
  const data = JSON.parse(res.getContentText());
  const ttl = Math.min(21600, Math.floor(data.exp - Date.now() / 1000) - 30);
  if (ttl > 0) cache.put(ck, data.sub, ttl);
  return data.sub;
}

function notifyRebind_(memberId) {
  const m = table_('members').rows.find(function (r) { return r['會員ID'] === memberId; });
  if (!m || MailApp.getRemainingDailyQuota() < 1) return;
  const org = PROPS.getProperty('ORG_NAME') || '會員服務';
  MailApp.sendEmail({
    to: m['Email'],
    name: org,
    subject: '【' + org + '】您的會員身分已綁定到新的 LINE 帳號',
    body: '您的會員身分剛剛綁定到新的 LINE 帳號，舊帳號的綁定已失效。\n若不是您本人操作，請立即聯絡管理員。'
  });
}

// ================= 試算表工具 =================
function table_(key) {
  const def = CONFIG.sheets[key];
  if (!table_.ss) table_.ss = SpreadsheetApp.openById(PROPS.getProperty('SHEET_ID')); // 同一次執行只開一次
  const sh = table_.ss.getSheetByName(def.name);
  if (!sh) throw new Error('找不到分頁：' + def.name);
  const values = sh.getDataRange().getValues();
  const header = values[0];
  const idx = {};
  def.cols.forEach(function (c) {
    idx[c] = header.indexOf(c);
    if (idx[c] < 0) throw new Error('「' + def.name + '」缺少欄位：' + c);
  });
  const rows = values.slice(1).map(function (r, i) {
    const o = { _row: i + 2 };
    def.cols.forEach(function (c) { o[c] = r[idx[c]]; });
    return o;
  });
  return { sh: sh, idx: idx, width: header.length, rows: rows };
}

function setCell_(t, row, col, value) {
  t.sh.getRange(row._row, t.idx[col] + 1).setValue(value);
}

function appendRow_(t, obj) {
  const arr = new Array(t.width).fill('');
  Object.keys(obj).forEach(function (c) { if (t.idx[c] !== undefined) arr[t.idx[c]] = obj[c]; });
  t.sh.appendRow(arr);
}

function log_(action, userId, result) {
  try {
    appendRow_(table_('logs'), { '時間': new Date(), '動作': action, 'userId末4碼': String(userId).slice(-4), '結果': result });
  } catch (err) {
    console.error('寫入紀錄失敗：' + err);
  }
}

// ================= 共用 =================
function reply_(replyToken, messages) {
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code !== 200) console.error('reply 失敗 ' + code + '：' + res.getContentText());
  return code;
}

function sha_(s) {
  return Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8));
}

function text_(s) { return ContentService.createTextOutput(s); }

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// ================= 【手動執行】 =================
/** 建立分頁與欄位，並寫入假會員（Email 用本帳號的 +別名，信都會寄到本帳號信箱） */
function setupSheets() {
  const id = PROPS.getProperty('SHEET_ID');
  if (!id) throw new Error('請先在指令碼屬性設定 SHEET_ID');
  const ss = SpreadsheetApp.openById(id);

  Object.keys(CONFIG.sheets).forEach(function (k) {
    const def = CONFIG.sheets[k];
    const sh = ss.getSheetByName(def.name) || ss.insertSheet(def.name);
    if (sh.getLastRow() === 0) {
      sh.appendRow(def.cols);
      sh.setFrozenRows(1);
    }
  });

  const mem = ss.getSheetByName(CONFIG.sheets.members.name);
  if (mem.getLastRow() === 1) {
    const parts = Session.getEffectiveUser().getEmail().split('@');
    [
      ['M001', '測試會員甲', CONFIG.memberActive],
      ['M002', '測試會員乙', CONFIG.memberActive],
      ['M003', '測試會員丙', '退出'],
      ['M004', '測試會員丁', CONFIG.memberActive]
    ].forEach(function (f) {
      mem.appendRow([f[0], f[1], parts[0] + '+' + f[0].toLowerCase() + '@' + parts[1], f[2]]);
    });
  }

  // 階段③：假的結果資料（M001 兩期測「取最新」、M003 已退出測「不得查詢」、M004 無資料測「查無」）
  const res = ss.getSheetByName(CONFIG.sheets.results.name);
  if (res.getLastRow() === 1) {
    res.getRange('B:B').setNumberFormat('@'); // 期別存成文字，避免被轉成日期
    [
      ['M001', '2026-10', '黃', 62, 3, 1, 0, 2],
      ['M001', '2026-11', '綠', 85, 4, 2, 1, 3],
      ['M002', '2026-11', '紅', 38, 2, 0, 0, 1],
      ['M003', '2026-11', '綠', 90, 4, 3, 2, 4]
    ].forEach(function (r) { res.appendRow(r); });
  }

  if (!PROPS.getProperty('OTP_SALT')) PROPS.setProperty('OTP_SALT', Utilities.getUuid());
  console.log('✅ 試算表已準備完成：會員、綁定、紀錄 三個分頁');
}

/** 檢查設定是否齊全 */
function checkSetup() {
  ['LINE_CHANNEL_ACCESS_TOKEN', 'WEBHOOK_KEY', 'LINE_LOGIN_CHANNEL_ID', 'LIFF_ID', 'SHEET_ID', 'ORG_NAME', 'OTP_SALT',
   'RICHMENU_IMAGE_URL', 'RICHMENU_ID']
    .forEach(function (k) {
      console.log((PROPS.getProperty(k) ? '✅ ' : '❌ 缺少 ') + k);
    });
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  console.log(res.getResponseCode() === 200
    ? '✅ Token 有效：' + JSON.parse(res.getContentText()).displayName
    : '❌ Token 無效（' + res.getResponseCode() + '）');
  try {
    ['members', 'bindings', 'logs', 'results'].forEach(function (k) { table_(k); });
    console.log('✅ 試算表分頁與欄位正確');
  } catch (err) {
    console.log('❌ 試算表：' + err.message);
  }
  console.log('今日剩餘寄信額度：' + MailApp.getRemainingDailyQuota());
}

/** 產生 webhook 密鑰（已存在則不覆蓋） */
function generateWebhookKey() {
  if (!PROPS.getProperty('WEBHOOK_KEY')) PROPS.setProperty('WEBHOOK_KEY', Utilities.getUuid().replace(/-/g, ''));
  console.log('?k=' + PROPS.getProperty('WEBHOOK_KEY'));
}

/** 【手動執行】建立圖文選單並設為所有人的預設選單（已存在則先刪除舊的） */
function createRichMenu() {
  const imgUrl = PROPS.getProperty('RICHMENU_IMAGE_URL');
  if (!imgUrl) throw new Error('請先在指令碼屬性設定 RICHMENU_IMAGE_URL');
  if (PROPS.getProperty('RICHMENU_ID')) deleteRichMenu();

  const auth = { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') };
  const liffUrl = 'https://liff.line.me/' + PROPS.getProperty('LIFF_ID');
  const menu = {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'research-menu',
    chatBarText: '選單',
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'postback', data: CONFIG.actions.myResult.postback, displayText: '我的數據' } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', uri: liffUrl } }
    ]
  };

  // 1. 建立選單
  let res = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu', {
    method: 'post', contentType: 'application/json', headers: auth,
    payload: JSON.stringify(menu), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('建立選單失敗：' + res.getContentText());
  const id = JSON.parse(res.getContentText()).richMenuId;

  // 2. 上傳圖片
  const img = UrlFetchApp.fetch(imgUrl, { muteHttpExceptions: true });
  if (img.getResponseCode() !== 200) throw new Error('讀取圖片失敗（' + img.getResponseCode() + '），請確認網址');
  res = UrlFetchApp.fetch('https://api-data.line.me/v2/bot/richmenu/' + id + '/content', {
    method: 'post', contentType: 'image/png', headers: auth,
    payload: img.getBlob().getBytes(), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('上傳圖片失敗：' + res.getContentText());

  // 3. 設為預設選單
  res = UrlFetchApp.fetch('https://api.line.me/v2/bot/user/all/richmenu/' + id, {
    method: 'post', headers: auth, muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) throw new Error('設定預設選單失敗：' + res.getContentText());

  PROPS.setProperty('RICHMENU_ID', id);
  console.log('✅ 圖文選單已建立並設為預設');
}

/** 【手動執行】刪除目前由程式建立的圖文選單 */
function deleteRichMenu() {
  const id = PROPS.getProperty('RICHMENU_ID');
  if (!id) { console.log('沒有記錄中的選單'); return; }
  const res = UrlFetchApp.fetch('https://api.line.me/v2/bot/richmenu/' + id, {
    method: 'delete',
    headers: { Authorization: 'Bearer ' + PROPS.getProperty('LINE_CHANNEL_ACCESS_TOKEN') },
    muteHttpExceptions: true
  });
  PROPS.deleteProperty('RICHMENU_ID');
  console.log('已刪除舊選單（' + res.getResponseCode() + '）');
}
