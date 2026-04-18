const { onRequest } = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const express = require('express');
const multer = require('multer');
const path = require('path');
const operatorImages = require('./operators');
const weaponImages = require('./weapons');
const { 
    getRoles, 
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

const cookieParser = require('cookie-parser');
app.use(cookieParser('firebase-arknights-secret'));

app.get('/', async (req, res) => {
    const uid = req.signedCookies.__session; // uid per server (Endfield uid)
    if (!uid) {
        return res.redirect('/login');
    }
    
    try {
        const userDoc = await db.collection('endfieldUsers').doc(uid).get();
        if (!userDoc.exists) {
            return res.redirect('/login');
        }
        
        let info = userDoc.data().info || {};
        let nickname = info.nickName || uid;
        let serverName = info.serverName || '';
        
        const logsDoc = await db.collection('endfieldUsers').doc(uid).collection('data').doc('logs').get();
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
            uid: uid,
            operatorImages: operatorImages,
            weaponImages: weaponImages
        });
    } catch (e) {
        console.error(e);
        res.render('login', { flash: '加載錯誤，請重新登入', roles: null, oauthToken: null });
    }
});

app.get('/login', (req, res) => {
    res.render('login', { flash: null, roles: null, oauthToken: null });
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
                return res.render('login', { flash: '該帳號找不到任何遊戲角色，請確認是否玩過該遊戲。', roles: null, oauthToken: null });
            }
            
            // Pass it to the view so the user can select
            return res.render('login', { flash: null, roles: roles, oauthToken: oauthToken });
            
        } else if (method === 'selectRole') {
            const uid = req.body.uid;
            const serverId = req.body.serverId;
            const serverName = req.body.serverName;
            const nickName = req.body.nickName;
            const oauthToken = req.body.oauthToken;
            
            console.log(`Selected UID: ${uid}, serverId: ${serverId}`);
            
            let logs = await fetchAllLogsSlowly(uid, serverId, oauthToken);
            console.log(`Fetched ${logs.length} logs`);
            
            const logsDocRef = db.collection('endfieldUsers').doc(uid).collection('data').doc('logs');
            const logsDoc = await logsDocRef.get();
            if (logsDoc.exists) {
                const data = logsDoc.data();
                let existing = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
                logs = mergeLogs(logs, existing);
            }
            
            await db.collection('endfieldUsers').doc(uid).set({ info: { uid, serverId, serverName, nickName } }, { merge: true });
            await logsDocRef.set({ jsonString: JSON.stringify(logs) });
            
            res.cookie('__session', uid, { signed: true, httpOnly: true });
            return res.redirect('/');
        } else if (method === 'existing') {
            const uid = req.body.uid;
            const userDoc = await db.collection('endfieldUsers').doc(uid).get();
            if (userDoc.exists) {
                res.cookie('__session', uid, { signed: true, httpOnly: true });
                return res.redirect('/');
            } else {
                return res.render('login', { flash: '找不到該 ID 的紀錄', roles: null, oauthToken: null });
            }
        } else if (method === 'upload') {
            // Keep unchanged for local upload
            const uid = req.body.uid;
            const logs = req.body.logs;
            if (!uid || uid.length < 5 || isNaN(uid)) {
                return res.status(400).send('請提供有效的 ID');
            }
            if (logs && Array.isArray(logs)) {
                const logsDocRef = db.collection('endfieldUsers').doc(uid).collection('data').doc('logs');
                await db.collection('endfieldUsers').doc(uid).set({ info: { uid: uid, nickName: uid } }, { merge: true });
                await logsDocRef.set({ jsonString: JSON.stringify(logs) });
                
                res.cookie('__session', uid, { signed: true, httpOnly: true });
                return res.redirect('/');
            } else {
                return res.status(400).send('請提供 ID 與檔案格式錯誤');
            }
        }
    } catch (e) {
        console.error(e);
        return res.render('login', { flash: e.toString(), roles: null, oauthToken: null });
    }
});

app.get('/export', async (req, res) => {
    const uid = req.signedCookies.__session;
    if (!uid) {
        return res.redirect('/login');
    }
    try {
        const logsDoc = await db.collection('endfieldUsers').doc(uid).collection('data').doc('logs').get();
        if (!logsDoc.exists) {
            return res.status(404).send('No logs found.');
        }
        const data = logsDoc.data();
        const logs = data.jsonString ? JSON.parse(data.jsonString) : (data.records || []);
        res.setHeader('Content-disposition', `attachment; filename=ef_visit_logs_${uid}.json`);
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

exports.app = onRequest({ region: "asia-east1", invoker: "public", maxInstances: 3, memory: "256MiB", timeoutSeconds: 120 }, app);
