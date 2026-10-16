#!/usr/bin/env node
/**
 * P0-9 登入／抓取流程的端到端檢查。
 *
 * 用 mock 的 Firestore 與 mock 的 Gryphline API 跑完整條流程，驗證：
 *   * 權杖從不進 Firestore（稽核每一次寫入的 payload）
 *   * 權杖不出現在 login 頁的 HTML 裡
 *   * 舊的裸字串 __session cookie 會自動升級而非登出
 *   * 互斥檔得住重新整理造成的重複抓取
 *   * uid consistency check 擋得住不屬於該權杖的 roleId
 *   * 重構尋訪（角色與武器兩側）都被抓取並正確標記 poolType
 *
 * 前置：需要 functions/ 的相依套件
 *   npm --prefix Firebase-endfieldgacha/functions install
 * （firebase.json 的 postdeploy hook 會在部署後清掉 node_modules，所以本機要自己裝）
 *
 * 用法（工作區根目錄）：node Firebase-endfieldgacha/scripts/flow-check.js
 */
const Module = require('module'), path = require('path'), http = require('http');
const EF = path.resolve(__dirname, '..');

// ---------- mock Firestore ----------
const STORE = {};                       // docPath -> data
const WRITES = [];                      // 所有寫入的 payload，用來稽核權杖
const FV_DELETE = { __delete: true };
function deepMerge(dst, src) {
    for (const [k, v] of Object.entries(src)) {
        if (v === FV_DELETE) { delete dst[k]; continue; }
        if (v && typeof v === 'object' && !Array.isArray(v)) { dst[k] = deepMerge(dst[k] || {}, v); }
        else dst[k] = v;
    }
    return dst;
}
function docRef(p) {
    return {
        get: async () => ({ exists: !!STORE[p], data: () => STORE[p] }),
        set: async (d, o) => { WRITES.push({ path: p, data: d }); STORE[p] = (o && o.merge) ? deepMerge(STORE[p] || {}, d) : JSON.parse(JSON.stringify(d)); },
        update: async (d) => { WRITES.push({ path: p, data: d }); STORE[p] = deepMerge(STORE[p] || {}, d); },
        collection: (c) => ({ doc: (id) => docRef(`${p}/${c}/${id}`) }),
    };
}
const adminMock = {
    initializeApp: () => {},
    firestore: () => ({ collection: (c) => ({ doc: (id) => docRef(`${c}/${id}`) }) }),
};
adminMock.firestore.FieldValue = { delete: () => FV_DELETE };

// ---------- mock Gryphline ----------
const OAUTH = 'OAUTH_' + 'x'.repeat(234);     // 實測 240 字元
let bindingCalls = 0, recordCalls = 0;
const axiosMock = {
    post: async (url) => {
        if (url.includes('oauth2/v2/grant')) return { data: { status: 0, data: { token: OAUTH } } };
        if (url.includes('u8_token_by_uid')) return { data: { status: 0, data: { token: 'U8_' + 'y'.repeat(177) } } };
        throw new Error('unexpected post ' + url);
    },
    get: async (url, cfg) => {
        if (url.includes('binding_list')) {
            bindingCalls++;
            return { data: { status: 0, data: { list: [{ appCode: 'endfield', bindingList: [
                { uid: '209648341', roles: [{ roleId: '4677200022', serverId: 2, serverName: 'Asia', nickName: 'tester', level: 60 }] }
            ] }] } } };
        }
        if (url.includes('/weapon/pool')) return { data: { code: 0, data: [
            { poolId: 'rerun_wpn_yvonne', poolName: '點繪申領', poolType: 'rerun', online: false },
            { poolId: 'weponbox_1_5_1', poolName: '幽寒申領', poolType: 'normal', online: true } ] } };
        if (url.includes('/api/record/')) {
            recordCalls++;
            const pt = cfg.params.pool_type;
            if (cfg.params.seq_id) return { data: { code: 0, data: { list: [], hasMore: false } } };
            const mk = (o) => Object.assign({ seqId: String(recordCalls * 10), gachaTs: '1760000000000',
                rarity: 3, isFree: false, charId: 'c1', charName: '佩麗卡', weaponId: 'w1', weaponName: 'ww', kind: 'draw' }, o);
            if (pt === 'E_CharacterGachaPoolType_Rerun') return { data: { code: 0, data: { list: [mk({ poolId: 'rerun_chr_yvonne', poolName: '點繪尋訪' })], hasMore: false } } };
            if (pt === 'E_CharacterGachaPoolType_Special') return { data: { code: 0, data: { list: [mk({ poolId: 'special_1_6_1', poolName: '萬物更新' })], hasMore: false } } };
            if (!pt) return { data: { code: 0, data: { list: [mk({ poolId: 'rerun_wpn_yvonne', poolName: '點繪申領' })], hasMore: false } } };
            return { data: { code: 0, data: { list: [], hasMore: false } } };
        }
        throw new Error('unexpected get ' + url);
    },
};

const DEPS = path.join(EF, 'functions/node_modules');
const origLoad = Module._load;
Module._load = function (r, parent, isMain) {
    if (r === 'axios') return axiosMock;
    if (r === 'firebase-admin') return adminMock;
    if (r === 'firebase-functions/v2/https') return { onRequest: (opts, app) => ({ opts, app }) };
    if (['express', 'cookie-parser', 'ejs', 'express-rate-limit', 'multer'].includes(r)) return origLoad.call(this, path.join(DEPS, r), parent, isMain);
    return origLoad.call(this, r, parent, isMain);
};

const mod = require(path.join(EF, 'functions/index.js'));
const app = mod.app.app;
console.log('timeoutSeconds =', mod.app.opts.timeoutSeconds);

// ---------- 迷你 HTTP client ----------
const server = http.createServer(app);
let cookie = '';
function req(method, p, body) {
    return new Promise((resolve) => {
        const data = body ? new URLSearchParams(body).toString() : null;
        const r = http.request({ port: server.address().port, method, path: p, headers: Object.assign(
            cookie ? { Cookie: cookie } : {},
            data ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data) } : {}) },
        (res) => {
            let b = ''; res.on('data', c => b += c);
            res.on('end', () => {
                const sc = res.headers['set-cookie'];
                if (sc) cookie = sc.map(x => x.split(';')[0]).join('; ');
                resolve({ status: res.statusCode, body: b, loc: res.headers.location });
            });
        });
        if (data) r.write(data); r.end();
    });
}

let fails = 0;
const ck = (n, cond, extra='') => { console.log(`  ${cond ? '✅' : '❌'} ${n}${cond ? '' : ' ' + extra}`); if (!cond) fails++; };

(async () => {
    await new Promise(r => server.listen(0, r));

    console.log('\n[A] 舊的裸字串 cookie 應自動升級，不被登出');
    STORE['endfieldUsers/4677200022'] = { info: { roleId: '4677200022', nickName: 'old' } };
    const signed = require(path.join(DEPS, 'cookie-signature'));
    cookie = '__session=' + encodeURIComponent('s:' + signed.sign('4677200022', 'firebase-arknights-secret'));
    const r0 = await req('GET', '/');
    ck('舊 cookie 仍可讀取資料（非 302 導向 login）', r0.status === 200, `status=${r0.status} loc=${r0.loc}`);
    ck('cookie 已升級為 j: 物件格式', decodeURIComponent(cookie).includes('j:{"roleId"'), cookie.slice(0, 60));

    console.log('\n[B] accountToken：權杖進 cookie，不進 HTML');
    cookie = '';
    const r1 = await req('POST', '/login', { method: 'accountToken', accountToken: 'ACCT_TOKEN' });
    ck('回應 200', r1.status === 200);
    ck('HTML 不含 oauthToken 字串', !r1.body.includes(OAUTH), '洩漏到 HTML！');
    ck('cookie 內含 pendingAuth', decodeURIComponent(cookie).includes('pendingAuth'));

    console.log('\n[C] selectRole：Firestore 不得有權杖');
    const r2 = await req('POST', '/login', { method: 'selectRole', uid: '209648341', roleId: '4677200022', serverId: '2', serverName: 'Asia', nickName: 'tester' });
    ck('導向 /loading', r2.loc === '/loading', r2.loc);
    ck('Firestore 無 pendingFetch', !STORE['endfieldUsers/4677200022'].pendingFetch);
    // selectRole 刻意不寫 fetchStartedAt —— 否則第一次 /fetch-logs 會被互斥誤判為進行中
    ck('selectRole 不寫 fetchStartedAt（否則首抓會被互斥擋死）', !STORE['endfieldUsers/4677200022'].info.fetchStartedAt);
    ck('cookie 內含 pending', decodeURIComponent(cookie).includes('"pending"'));

    console.log('\n[D] /fetch-logs：從 cookie 取權杖、uid check、寫入紀錄');
    const bc = bindingCalls;
    const r3 = await req('POST', '/fetch-logs');
    ck('回應 200', r3.status === 200, r3.body);
    ck('做了 uid consistency check（多呼叫一次 binding_list）', bindingCalls === bc + 1, `${bc}->${bindingCalls}`);
    const stored = JSON.parse(STORE['endfieldUsers/4677200022/data/logs'].jsonString);
    ck('抓到紀錄', stored.length === 3, `len=${stored.length}`);
    ck('角色 Rerun 已被抓取並標記 poolType', stored.some(x => x.poolType === 'E_CharacterGachaPoolType_Rerun'));
    ck('武器 rerun 已由註冊表標記 poolType=rerun', stored.some(x => x.poolId === 'rerun_wpn_yvonne' && x.poolType === 'rerun'));
    ck('info.lastFetchedAt 已寫入', !!STORE['endfieldUsers/4677200022'].info.lastFetchedAt);
    ck('cookie 已清掉 pending', !decodeURIComponent(cookie).includes('"pending"'), cookie.slice(0,80));

    console.log('\n[E] /check-ready 應回 ready');
    const r4 = await req('GET', '/check-ready');
    ck('ready=true', JSON.parse(r4.body).ready === true, r4.body);

    console.log('\n[F] 互斥：進行中時再打 /fetch-logs 不得重跑');
    STORE['endfieldUsers/4677200022'].info.fetchStartedAt = Date.now();
    STORE['endfieldUsers/4677200022'].info.lastFetchedAt = 0;
    // 重跑完整登入以讓 cookie 重新帶上 pending（模擬使用者重新整理 /loading）
    await req('POST', '/login', { method: 'accountToken', accountToken: 'ACCT_TOKEN' });
    await req('POST', '/login', { method: 'selectRole', uid: '209648341', roleId: '4677200022', serverId: '2', serverName: 'Asia', nickName: 'tester' });
    const before = recordCalls;
    // 手動模擬「另一個請求已經開始抓了」
    STORE['endfieldUsers/4677200022'].info.fetchStartedAt = Date.now();
    STORE['endfieldUsers/4677200022'].info.lastFetchedAt = 0;
    const r5 = await req('POST', '/fetch-logs');
    ck('回應 inProgress', JSON.parse(r5.body).inProgress === true, r5.body);
    ck('沒有發出新的 record 請求', recordCalls === before, `${before}->${recordCalls}`);

    console.log('\n[G] uid consistency check 擋下不屬於該權杖的 roleId');
    STORE['endfieldUsers/9999999999'] = { info: { roleId: '9999999999' } };
    STORE['endfieldUsers/4677200022'].info.fetchStartedAt = 0;
    const victimSess = 'j:' + JSON.stringify({ roleId: '9999999999', pending: { uid: '209648341', serverId: '2', oauthToken: OAUTH } });
    cookie = '__session=' + encodeURIComponent('s:' + signed.sign(victimSess, 'firebase-arknights-secret'));
    const r6 = await req('POST', '/fetch-logs');
    ck('回應 403', r6.status === 403, `${r6.status} ${r6.body}`);
    ck('未寫入受害者的 logs', !STORE['endfieldUsers/9999999999/data/logs']);

    console.log('\n[H] 稽核：所有 Firestore 寫入都不得包含權杖');
    const dump = JSON.stringify(WRITES);
    ck('無 oauthToken 值', !dump.includes(OAUTH));
    ck('無 OAUTH_ 前綴', !dump.includes('OAUTH_'));
    ck('無 U8_ 前綴', !dump.includes('U8_'));
    ck('無 pendingFetch 的實際賦值', !/"pendingFetch":\{(?!"__delete")/.test(dump));
    console.log(`     （共稽核 ${WRITES.length} 次寫入）`);

    console.log(fails === 0 ? '\n✅ P0-9 端到端全部通過\n' : `\n❌ ${fails} 項失敗\n`);
    server.close();
    process.exit(fails ? 1 : 0);
})();
