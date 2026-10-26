const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require('express');
const multer = require('multer');
const path = require('path');
const operatorImages = require('./operators');
const weaponImages = require('./weapons');
const { 
    getRoles, 
    fetchBindingRoles,
    fetchAllLogsSlowly, 
    mergeLogs, 
    analyzeLogs 
} = require('./utils');

admin.initializeApp();
const db = admin.firestore();

const app = express();
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

app.set('trust proxy', 1);

const rateLimit = require('express-rate-limit');
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, 
  max: 100, 
  message: '存取過於頻繁，請稍後再試。'
});
app.use(limiter);

app.use(express.urlencoded({ limit: '10mb', extended: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '../public')));

// Set canonical URL for SEO indexing
app.use((req, res, next) => {
    let path = req.originalUrl.split('?')[0]; // Ignore query strings for canonical purposes
    res.locals.canonicalUrl = `https://endfield-gacha.web.app${path}`;
    next();
});
const cookieParser = require('cookie-parser');
app.use(cookieParser('firebase-arknights-secret'));

// --- Session helpers（P0-9 / P4-2） ---
//
// __session 的 payload 從裸字串升級為物件 { roleId, pending?: { uid, serverId, oauthToken } }。
//
// 為什麼權杖放這裡而不是 Firestore：endfieldUsers 被 firestore-bigquery-export 監聽，
// 寫進受監聽文件的任何欄位都是永久的（changelog 的 old_data 連被刪掉的欄位都保留），
// 所以憑證絕不可進 Firestore，哪怕只是暫存一瞬間。
// Hosting 只放行 __session 這個 cookie，而實測權杖 240 字元，遠低於 4KB 上限。
//
// 抽成函式而不是四處複製 back-compat（台服 index.js 就複製了三次）—— 一處改完全部生效。
const SESSION_COOKIE_OPTS = { signed: true, httpOnly: true };

function getSession(req, res) {
    let data = req.signedCookies.__session;
    if (!data) return null;
    // 舊 cookie 是裸的 roleId 字串 —— 自動升級成物件，不要讓既有使用者被登出
    if (typeof data === 'string') {
        data = { roleId: data };
        if (res) res.cookie('__session', data, SESSION_COOKIE_OPTS);
    }
    if (!data.roleId) return null;
    return data;
}

function setSession(res, data) {
    res.cookie('__session', data, SESSION_COOKIE_OPTS);
}

// 判定「這次抓取已經死了」的門檻。必須略大於 Function 的 timeoutSeconds(300)，否則會在
// 抓取還在正常進行時就宣告失敗，並提前放開下面的互斥鎖而導致並行抓取。
// 一般錯誤會由 /fetch-logs 的 catch 把 fetchStartedAt 歸零以便立即重試，
// 所以這個等待只會發生在 Function 被硬砍（逾時／OOM）、catch 根本沒執行的情況。
const FETCH_STALE_MS = 320 * 1000;

app.get('/', async (req, res) => {
    const session = getSession(req, res);
    if (!session) {
        return res.redirect('/login');
    }
    const roleId = session.roleId;
    
    try {
        const userDoc = await db.collection('endfieldUsers').doc(roleId).get();
        if (!userDoc.exists) {
            return res.redirect('/login');
        }
        
        let info = userDoc.data().info || {};
        let nickname = info.nickName || roleId;
        let serverName = info.serverName || '';
        
        const logsDoc = await db.collection('endfieldUsers').doc(roleId).collection('data').doc('logs').get();
        let logs = [];
        if (logsDoc.exists) {
            const data = logsDoc.data();
            logs = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
        }
        
        const analyzed = analyzeLogs(logs);
        
        res.render('index', {
            logs: analyzed.logs,
            stats: analyzed,
            nickname: nickname,
            serverName: serverName,
            uid: roleId,
            operatorImages: operatorImages,
            weaponImages: weaponImages
        });
    } catch (e) {
        console.error(e);
        res.render('login', { flash: '加載錯誤，請重新登入', roles: null });
    }
});

app.get('/login', (req, res) => {
    res.render('login', { flash: null, roles: null });
});

app.get('/privacy', (req, res) => {
    res.render('privacy');
});

app.post('/login', async (req, res) => {
    const method = req.body.method;
    
    try {
        if (method === 'accountToken') {
            let accountToken = req.body.accountToken.trim().replace(/[\r\n]+/g, '');
            try {
                // If the user pasted the entire JSON string, extract the 'content' part
                const parsed = JSON.parse(accountToken);
                if (parsed && parsed.data && parsed.data.content) {
                    accountToken = parsed.data.content;
                }
            } catch (e) {
                // It's not JSON, assume it's just the token string itself
            }
            
            const { oauthToken, roles } = await getRoles(accountToken);
            
            if (roles.length === 0) {
                return res.render('login', { flash: '該帳號找不到任何遊戲角色，請確認是否玩過該遊戲。', roles: null });
            }
            
            // 權杖只放進已簽章的 httpOnly cookie —— 不經過 HTML、頁面 JS 讀不到。
            // roleId 還不知道（使用者下一步才選），所以先用 pendingAuth 暫存。
            setSession(res, { roleId: null, pendingAuth: { oauthToken } });
            
            // Pass it to the view so the user can select（表單只送 roleId/serverId 等非敏感欄位）
            return res.render('login', { flash: null, roles: roles });
            
        } else if (method === 'selectRole') {
            const uid = req.body.uid;
            const roleId = req.body.roleId;
            const serverId = req.body.serverId;
            const serverName = req.body.serverName;
            const nickName = req.body.nickName;
            
            // 權杖來自上一步寫進 cookie 的 pendingAuth，不是 req.body
            const prev = req.signedCookies.__session;
            const oauthToken = prev && typeof prev === 'object' && prev.pendingAuth
                ? prev.pendingAuth.oauthToken : null;
            if (!oauthToken) {
                return res.render('login', { flash: '登入階段已逾時，請重新貼上 Token。', roles: null });
            }
            
            console.log(`Selected roleId: ${roleId}, uid: ${uid}, serverId: ${serverId}`);
            
            // Firestore 只存不敏感的資訊 —— 絕不含權杖。
            // ⚠️ 刻意不在這裡寫 fetchStartedAt：那會讓緊接著的第一次 /fetch-logs
            //    被下方的互斥檢查誤判為「已在進行中」而完全不抓取。
            //    開始標記只由真正開始抓取的 /fetch-logs 自己寫。
            await db.collection('endfieldUsers').doc(roleId).set({
                info: { uid, roleId, serverId, serverName, nickName },
                // 確保文件內沒有 pendingFetch 欄位：憑證不可進 Firestore（見 agent.md 不可違反原則 7）
                pendingFetch: admin.firestore.FieldValue.delete()
            }, { merge: true });
            
            // 權杖留在 cookie 裡跨請求存活，並 redirect FAST（搶在 Hosting 的 60s 逾時之前）
            setSession(res, { roleId, pending: { uid, serverId, oauthToken } });
            return res.redirect('/loading');
        } else if (method === 'existing') {
            const roleId = req.body.uid;
            const userDoc = await db.collection('endfieldUsers').doc(roleId).get();
            if (userDoc.exists) {
                setSession(res, { roleId });
                return res.redirect('/');
            } else {
                return res.render('login', { flash: '找不到該 ID 的紀錄', roles: null });
            }
        } else if (method === 'upload') {
            // Keep unchanged for local upload
            const roleId = req.body.uid;
            const logs = req.body.logs;
            if (!roleId || roleId.length < 5 || isNaN(roleId)) {
                return res.status(400).send('請提供有效的 ID');
            }
            if (logs && Array.isArray(logs)) {
                const logsDocRef = db.collection('endfieldUsers').doc(roleId).collection('data').doc('logs');
                await db.collection('endfieldUsers').doc(roleId).set({ info: { roleId: roleId, nickName: roleId } }, { merge: true });
                await logsDocRef.set({ jsonString: JSON.stringify(logs) });
                
                setSession(res, { roleId });
                return res.redirect('/');
            } else {
                return res.status(400).send('請提供 ID 與檔案格式錯誤');
            }
        }
    } catch (e) {
        console.error(e);
        return res.render('login', { flash: e.toString(), roles: null });
    }
});

// --- Async loading flow (avoids Firebase Hosting 60s proxy timeout) ---

app.get('/loading', (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.redirect('/login');
    res.render('loading');
});

app.post('/fetch-logs', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ error: 'unauthorized' });
    const roleId = session.roleId;
    
    // 權杖來自 cookie，不是 Firestore
    const pending = session.pending;
    if (!pending) return res.json({ success: true, message: 'already done' });
    
    try {
        const userDoc = await db.collection('endfieldUsers').doc(roleId).get();
        if (!userDoc.exists) return res.status(404).json({ error: 'user not found' });
        
        const info = userDoc.data().info || {};
        
        // 互斥：抓取一次要 60-90 秒，而 Hosting 會在 60 秒放棄連線 —— 瀏覽器因此會重試。
        // 沒有這道檢查的話，重新整理 /loading 會讓第二次抓取與第一次並行，
        // 違反刻意保留的 sleep(200) 防爬蟲節流，也讓撞上 Function 逾時的機率翻倍。
        // 這是 best-effort 的保護而非分散式鎖（同時抵達的兩個請求仍可能都讀到舊值），
        // 對這個場景足夠 —— 要擋的是使用者重新整理頁面，不是高併發。
        const startedAt = info.fetchStartedAt || 0;
        const fetchedAt = info.lastFetchedAt || 0;
        const inProgress = startedAt > fetchedAt && (Date.now() - startedAt) < FETCH_STALE_MS;
        if (inProgress) {
            return res.json({ success: true, inProgress: true, message: 'already running' });
        }
        
        const { uid, serverId, oauthToken } = pending;
        
        // uid consistency check：驗證這個權杖的持有者真的擁有 session 裡的 roleId。
        // 成本是 1 個請求（相對於一次完整抓取的約 200 個可忽略）。
        const ownedRoles = await fetchBindingRoles(oauthToken);
        if (!ownedRoles.some(r => String(r.roleId) === String(roleId))) {
            console.warn(`uid consistency check failed for roleId ${roleId}`);
            setSession(res, { roleId });
            return res.status(403).json({ error: 'role does not belong to this token' });
        }
        
        // 標記開始，讓 /check-ready 與上面的互斥檢查有依據（只有時間戳，無敏感內容）
        await db.collection('endfieldUsers').doc(roleId).set({
            info: { fetchStartedAt: Date.now() }
        }, { merge: true });
        
        let logs = await fetchAllLogsSlowly(uid, serverId, oauthToken);
        console.log(`Fetched ${logs.length} logs for roleId ${roleId}`);
        
        const logsDocRef = db.collection('endfieldUsers').doc(roleId).collection('data').doc('logs');
        const logsDoc = await logsDocRef.get();
        if (logsDoc.exists) {
            const data = logsDoc.data();
            let existing = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
            logs = mergeLogs(logs, existing);
        }
        
        await logsDocRef.set({ jsonString: JSON.stringify(logs) });
        
        // 完成旗標（非敏感時間戳）。/check-ready 以 lastFetchedAt >= fetchStartedAt 判定完成。
        await db.collection('endfieldUsers').doc(roleId).set({
            info: { lastFetchedAt: Date.now() }
        }, { merge: true });
        
        // 清掉 cookie 裡的權杖。
        // ⚠️ 這個 Set-Cookie 只在 60 秒內跑完的快路徑送得到瀏覽器 —— 慢路徑時
        //    Hosting 早已放棄連線。所以 /check-ready 也會做同一件事，那個請求一定送達得了。
        setSession(res, { roleId });
        
        return res.json({ success: true });
    } catch (e) {
        console.error('fetch-logs error:', e);
        // 失敗時把 started 標記清掉（寫回 0），讓使用者可以立刻重試而不用等 150 秒逾時
        try {
            await db.collection('endfieldUsers').doc(roleId).set({
                info: { fetchStartedAt: 0 }
            }, { merge: true });
        } catch (ignore) {}
        return res.status(500).json({ error: e.message });
    }
});

// /check-ready 是毫秒級請求，它的回應一定送達得了 —— 所以收尾動作放在這裡，
// 而不是放在那個會被 Hosting 在 60 秒砍掉的 /fetch-logs 回應上。
app.get('/check-ready', async (req, res) => {
    const session = getSession(req, res);
    if (!session) return res.status(401).json({ ready: false });
    const roleId = session.roleId;
    
    try {
        const userDoc = await db.collection('endfieldUsers').doc(roleId).get();
        if (!userDoc.exists) return res.json({ ready: false });
        
        const info = userDoc.data().info || {};
        const startedAt = info.fetchStartedAt || 0;
        const fetchedAt = info.lastFetchedAt || 0;
        
        if (fetchedAt >= startedAt && fetchedAt > 0) {
            // 完成 —— 順手把 cookie 裡的權杖清掉（這是真正會生效的那一次清除）
            if (session.pending || session.pendingAuth) {
                setSession(res, { roleId });
            }
            return res.json({ ready: true });
        }
        
        // 逾時未完成：視為失敗，讓前端停止輪詢並顯示重試，而不是無限轉圈
        if (startedAt > 0 && (Date.now() - startedAt) >= FETCH_STALE_MS) {
            return res.json({ ready: false, failed: true });
        }
        
        return res.json({ ready: false });
    } catch (e) {
        return res.json({ ready: false });
    }
});

app.get('/export', async (req, res) => {
    const session = getSession(req, res);
    if (!session) {
        return res.redirect('/login');
    }
    const roleId = session.roleId;
    try {
        const logsDoc = await db.collection('endfieldUsers').doc(roleId).collection('data').doc('logs').get();
        if (!logsDoc.exists) {
            return res.status(404).send('No logs found.');
        }
        const data = logsDoc.data();
        const logs = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
        res.setHeader('Content-disposition', `attachment; filename=ef_visit_logs_${roleId}.json`);
        res.setHeader('Content-type', 'application/json');
        res.send(JSON.stringify(logs, null, 2));
    } catch (e) {
        console.error(e);
        res.status(500).send('Internal Server Error');
    }
});

app.get('/logout', (req, res) => {
    res.clearCookie('__session');
    res.redirect('/login');
});

// timeoutSeconds 從 120 提高到 300：一次完整抓取目前約 60-90 秒（約 110 頁 × 2 個請求
// ＋ 每頁 sleep(200)），而特許尋訪的紀錄會隨每個新卡池單調成長，加上新增的重構尋訪抓取鏈
// 之後餘裕不足。Hosting 仍在 60 秒放棄連線，但 loading.ejs 的輪詢架構本來就處理這條路徑。
exports.app = onRequest({ region: "asia-east1", invoker: "public", maxInstances: 20, concurrency: 40, memory: "256MiB", timeoutSeconds: 300 }, app);
