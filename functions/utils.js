const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const API_BASE = "https://ef-webview.gryphline.com/api/record";

// 角色側的 pool_type enum → 中文分類。
// 實測共探測 66 個候選名稱，只有這 5 個有效（code:0），所以這是完整清單。
// ⚠️ 這個陣列的順序就是前端分類按鈕與統計面板的順序 —— 它是順序的唯一來源，
//    index.ejs 從 stats.starcounts 的 key 推導，不自己排序。
const CHAR_POOL_TYPES = [
    { poolType: "E_CharacterGachaPoolType_Special",  category: "特許尋訪" },
    { poolType: "E_CharacterGachaPoolType_Standard", category: "基礎尋訪" },
    { poolType: "E_CharacterGachaPoolType_Rerun",    category: "重構尋訪" },
    { poolType: "E_CharacterGachaPoolType_Joint",    category: "輝光慶典" },
    { poolType: "E_CharacterGachaPoolType_Beginner", category: "啟程尋訪" },
];

const CHAR_TYPE_TO_CATEGORY = Object.fromEntries(CHAR_POOL_TYPES.map(p => [p.poolType, p.category]));

const WEAPON_CATEGORY = "武庫申領";
const UNKNOWN_CATEGORY = "其他尋訪";

// 顯示順序：角色池在前，未知落袋，武器池最後（不與角色池混在一起）
const ALL_CATEGORIES = [
    ...CHAR_POOL_TYPES.map(p => p.category),
    UNKNOWN_CATEGORY,
    WEAPON_CATEGORY,
];

function formatDateTime(timestamp) {
    const date = new Date(timestamp); // The Endfield gachaTs is in milliseconds
    const yr = date.getFullYear();
    const mo = String(date.getMonth() + 1).padStart(2, '0');
    const da = String(date.getDate()).padStart(2, '0');
    const hr = String(date.getHours()).padStart(2, '0');
    const mi = String(date.getMinutes()).padStart(2, '0');
    const se = String(date.getSeconds()).padStart(2, '0');
    return `${yr}/${mo}/${da} ${hr}:${mi}:${se}`;
}

async function getRoles(accountToken) {
    // 階段二：換取 OAuth Token
    const grantRes = await axios.post("https://as.gryphline.com/user/oauth2/v2/grant", {
        token: accountToken,
        appCode: "3dacefa138426cfe",
        type: 1
    }, { headers: { "Content-Type": "application/json" } });
    
    if (grantRes.data.status !== 0) {
        throw new Error(`Grant failed: ${grantRes.data.msg || grantRes.data.status}`);
    }
    const oauthToken = grantRes.data.data.token;

    // 階段三：獲取帳號綁定資訊 (UID)
    const roles = await fetchBindingRoles(oauthToken);
    
    return { oauthToken, roles };
}

// 以既有的 oauthToken 取得該帳號底下的角色清單。
// getRoles 用它完成登入流程；/fetch-logs 用它做 uid consistency check
// —— 驗證 session 的 roleId 確實屬於這個權杖的持有者。
async function fetchBindingRoles(oauthToken) {
    const bindingRes = await axios.get("https://binding-api-account-prod.gryphline.com/account/binding/v1/binding_list", {
        params: {
            token: oauthToken,
            appCode: "endfield"
        }
    });
    
    if (bindingRes.data.status !== 0) {
        throw new Error(`Binding list failed: ${bindingRes.data.msg || bindingRes.data.status}`);
    }
    
    let roles = [];
    if (bindingRes.data.data && bindingRes.data.data.list) {
        for (let app of bindingRes.data.data.list) {
            if (app.appCode === "endfield" && app.bindingList) {
                for (let binding of app.bindingList) {
                    if (binding.roles) {
                        for (let role of binding.roles) {
                            roles.push({
                                uid: binding.uid,
                                roleId: role.roleId,
                                serverId: role.serverId,
                                serverName: role.serverName,
                                nickName: role.nickName,
                                level: role.level
                            });
                        }
                    }
                }
            }
        }
    }
    
    return roles;
}

async function getU8Token(uid, oauthToken) {
    const u8Res = await axios.post("https://binding-api-account-prod.gryphline.com/account/binding/v1/u8_token_by_uid", {
        uid: String(uid),
        token: oauthToken
    }, { headers: { "Content-Type": "application/json" } });
    
    if (u8Res.data.status !== 0) {
        throw new Error(`u8_token failed: ${u8Res.data.msg || u8Res.data.status}`);
    }
    return u8Res.data.data.token;
}

// category can be "char" or "weapon"
async function fetchVisitLogPage(u8_token, server_id, pool_type, seq_id, category = "char", lang = "zh-tw") {
    const url = `${API_BASE}/${category}`;
    const params = {
        token: u8_token,
        lang: lang,
        server_id: server_id
    };
    if (category === "char" && pool_type) {
        params.pool_type = pool_type;
    }
    if (seq_id) {
        params.seq_id = seq_id;
    }
    
    const response = await axios.get(url, { params: params });
    const js = response.data;
    if (js.code !== 0) {
        throw new Error(`API code=${js.code}`);
    }
    return js.data; // contains list and hasMore
}

// 武器卡池註冊表：poolId → poolType（實測值為 "normal" / "rerun"）。
// 武器側的紀錄本身不帶型態，所以要靠這張表才能辨識重構池（例如 rerun_wpn_yvonne 點繪申領）。
async function fetchWeaponPoolTypes(u8_token, server_id) {
    try {
        const response = await axios.get(`${API_BASE}/weapon/pool`, {
            params: { token: u8_token, lang: "zh-tw", server_id: server_id }
        });
        const js = response.data;
        if (js.code !== 0) return {};
        const list = Array.isArray(js.data) ? js.data : (js.data && js.data.list) || [];
        const map = {};
        for (let pool of list) {
            if (pool && pool.poolId && pool.poolType) {
                map[pool.poolId] = pool.poolType;
            }
        }
        return map;
    } catch (e) {
        // 註冊表只用於標記 poolType，取不到時會退回 poolId 前綴判定。
        // 不可讓它讓整次抓取失敗 —— 抓到紀錄本身比分類正確更重要（API 只保留約 3 個月）。
        console.warn('weapon pool registry unavailable:', e.message);
        return {};
    }
}

async function fetchLogsByPool(u8_token, server_id, pool_type, category = "char", weaponPoolTypes = null) {
    let allLogs = [];
    let seq_id = null;
    
    while (true) {
        const data = await fetchVisitLogPage(u8_token, server_id, pool_type, seq_id, category, "zh-tw");
        const data_cn = await fetchVisitLogPage(u8_token, server_id, pool_type, seq_id, category, "zh-cn");
        
        const lst = data.list || [];
        const lst_cn = data_cn.list || [];
        if (lst.length === 0) {
            break;
        }
        
        for (let i = 0; i < lst.length; i++) {
            if (lst_cn[i]) {
                lst[i].cnName = category === "weapon" ? lst_cn[i].weaponName : lst_cn[i].charName;
            } else {
                lst[i].cnName = category === "weapon" ? lst[i].weaponName : lst[i].charName;
            }
        }
        
        allLogs = allLogs.concat(lst);
        
        if (!data.hasMore) {
            break;
        }
        // seqId is a string like "416"
        seq_id = lst[lst.length - 1].seqId;
        await sleep(200);
    }
    
    // Format timestamp and add 'category' field for internal usage (char or weapon)
    for (let item of allLogs) {
        item.time = formatDateTime(Number(item.gachaTs));
        item.itemCategory = category;
        // make sure weaponName -> charName mapping if it's weapon for easier templating
        if (category === "weapon") {
            item.charName = item.weaponName;
            item.charId = item.weaponId;
            item.poolName = item.poolName || WEAPON_CATEGORY;
            // 武器側的型態來自註冊表（normal / rerun）
            if (weaponPoolTypes && weaponPoolTypes[item.poolId]) {
                item.poolType = weaponPoolTypes[item.poolId];
            }
        } else if (pool_type) {
            // 角色側：抓取時就知道自己請求了哪個 enum，直接標記，不必事後猜 poolId 前綴。
            // 這讓新卡池（例如 Rerun）一加進抓取清單就自動分類正確。
            item.poolType = pool_type;
        }
    }
    return allLogs;
}

async function fetchAllLogsSlowly(uid, server_id, oauthToken) {
    const u8_token = await getU8Token(uid, oauthToken);

    // 先取武器卡池註冊表，才能在抓取時標記武器側的 normal / rerun
    const weaponPoolTypes = await fetchWeaponPoolTypes(u8_token, server_id);

    // 角色側逐一跑過 CHAR_POOL_TYPES —— 新增型態只要加進那個陣列就會自動被抓到
    let allLogs = [];
    for (let { poolType } of CHAR_POOL_TYPES) {
        const logs = await fetchLogsByPool(u8_token, server_id, poolType, "char");
        allLogs = allLogs.concat(logs);
    }
    const weaponLogs = await fetchLogsByPool(u8_token, server_id, null, "weapon", weaponPoolTypes);
    allLogs = allLogs.concat(weaponLogs);

    // We keep them all in one array to save, but they don't inherit pity.
    // Sort descending by gachaTs
    allLogs.sort((a, b) => Number(b.gachaTs) - Number(a.gachaTs));

    return allLogs;
}

function mergeLogs(records, previousRecords) {
    // For Endfield, since we have seqId which is completely unique and strictly monotonic per pool, 
    // it's actually safer to just dedup by (poolId + seqId) or (itemCategory + seqId).
    // Let's do a simple dedup based on seqId + poolId.
    let seen = new Set();
    let merged = [];
    
    const makeKey = (item) => `${item.itemCategory}_${item.poolId}_${item.seqId}`;
    
    for (let item of records) {
        let k = makeKey(item);
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(item);
        }
    }
    
    for (let item of previousRecords) {
        let k = makeKey(item);
        if (!seen.has(k)) {
            seen.add(k);
            merged.push(item);
        }
    }
    
    merged.sort((a, b) => Number(b.gachaTs) - Number(a.gachaTs));
    return merged;
}

// 分類優先序：抓取時標記的 poolType → 舊紀錄的 poolId 前綴 → 其他尋訪
//
// ⚠️ 為什麼一定要保留前綴 fallback：資料庫與 gacha-backup/ 裡的既有紀錄沒有 poolType 欄位，
//    而官方 API 只保留約 3 個月，那些紀錄無法重新抓取。
//    這也是本專案的一條原則 —— 新增的 API 欄位不可單獨作為演算法依據，
//    任何依賴新欄位的判斷都必須明確定義「欄位不存在」時的行為。
function categoryOf(item) {
    if (item.itemCategory === 'weapon') return WEAPON_CATEGORY;

    if (item.poolType && CHAR_TYPE_TO_CATEGORY[item.poolType]) {
        return CHAR_TYPE_TO_CATEGORY[item.poolType];
    }

    // 刻意透過 CHAR_TYPE_TO_CATEGORY 轉換而不直接寫中文字面值 —— 分類名只有一處定義，
    // 日後改名不會讓這裡悄悄留著舊名字而憑空生出第 8 個分類。
    const poolId = typeof item.poolId === 'string' ? item.poolId : '';
    const byType = (t) => CHAR_TYPE_TO_CATEGORY[t] || UNKNOWN_CATEGORY;
    if (poolId === 'standard') return byType('E_CharacterGachaPoolType_Standard');
    if (poolId === 'beginner') return byType('E_CharacterGachaPoolType_Beginner');
    if (poolId.startsWith('special')) return byType('E_CharacterGachaPoolType_Special');
    if (poolId.startsWith('joint')) return byType('E_CharacterGachaPoolType_Joint');
    if (poolId.startsWith('rerun')) return byType('E_CharacterGachaPoolType_Rerun');
    return UNKNOWN_CATEGORY;
}

// 重構尋訪的偵測，三層（同樣遵守「舊紀錄沒有新欄位」的原則）
function isRerun(item) {
    // 角色新紀錄：抓取時標記的 char enum
    if (item.poolType === 'E_CharacterGachaPoolType_Rerun') return true;
    // 武器新紀錄：抓取時由 /api/record/weapon/pool 註冊表標記（normal / rerun）
    if (item.poolType === 'rerun') return true;
    // 舊紀錄無 poolType → 退回 poolId 前綴。實測重構池的 poolId 是命名式（rerun_wpn_yvonne），
    // 不是版本號式，所以只能比前綴。這是唯一允許依賴前綴的地方。
    if (!item.poolType && typeof item.poolId === 'string' && item.poolId.startsWith('rerun')) return true;
    return false;
}

// 保底累積的 key 與顯示分組的 key 刻意解耦：
//   * 一般尋訪 —— 官方規則是「尋訪關閉時清零、不繼承」，所以每個具體 poolId 獨立累積。
//     standard 是常駐池永不關閉，單一 poolId 永續累積也正確。
//   * 重構尋訪 —— 官方規則對它有例外：保底在「同名」的重構尋訪之間累積，
//     而同名的卡池有機會被分配一個新的 poolId。所以用 poolId 當 key 會把保底錯誤歸零。
// 顯示一律用 poolId（不同 poolId 就當成不同卡池顯示，即使 poolName 相同）。
//
// poolName 當 key 是安全的：主紀錄一律來自 zh-tw，zh-cn 的那次抓取只用來填 item.cnName，
// 所以 poolName 不會因語言產生兩個不同的 key。
function pityKeyOf(item) {
    if (isRerun(item)) return `rerun:${item.poolName || item.poolId}`;
    return item.poolId;
}

function analyzeLogs(logs) {
    // 僅供前端顯示與統計：過濾掉非抽卡紀錄 (如尋訪情報書)，保留舊版無 kind 的紀錄
    let logsCopy = logs.filter(item => !item.kind || item.kind === "draw");
    logsCopy.reverse(); // Time Ascending
    
    // 分類一律齊備（即使該使用者沒有該類紀錄也保留 0），順序來自 ALL_CATEGORIES。
    // index.ejs 從 starcounts 的 key 推導按鈕列與面板順序 —— 所以這裡是順序的唯一來源，
    // 未來新增第 8 個分類時前端會自動顯示，不會再靜默消失。
    let starcounts = {};
    let catCounts = {};
    for (let cat of ALL_CATEGORIES) {
        starcounts[cat] = { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 };
        catCounts[cat] = { paid: 0, free: 0 };
    }

    let starcountsPool = {};
    // Track paid vs free counts per pool
    let poolCounts = {};
    // 以 pityKey 為鍵（一般池 = poolId，重構池 = rerun:<poolName>）
    let countAcc = {};
    // poolId → pityKey 的對照表，給 view 查「這個卡池的保底要去哪個 key 拿」
    let poolPityKey = {};
    
    for (let i = 0; i < logsCopy.length; i++) {
        let item = logsCopy[i];
        let rarity = String(item.rarity);
        let poolId = item.poolId;
        let isFree = !!item.isFree;
        
        let category = categoryOf(item);
        item.poolCategory = category;

        const pityKey = pityKeyOf(item);
        poolPityKey[poolId] = pityKey;

        // 分類理論上一定存在於 ALL_CATEGORIES，但萬一 categoryOf 將來回傳新值也不要炸
        if (!starcounts[category]) starcounts[category] = { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 };
        if (!catCounts[category]) catCounts[category] = { paid: 0, free: 0 };

        if (!starcounts[category][rarity]) starcounts[category][rarity] = 0;
        starcounts[category][rarity]++;
        
        // Track paid vs free per category
        if (isFree) {
            catCounts[category].free++;
        } else {
            catCounts[category].paid++;
        }
        
        if (!starcountsPool[poolId]) {
            starcountsPool[poolId] = { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 };
        }
        if (!starcountsPool[poolId][rarity]) starcountsPool[poolId][rarity] = 0;
        starcountsPool[poolId][rarity]++;
        
        // Track paid vs free per pool
        if (!poolCounts[poolId]) {
            poolCounts[poolId] = { paid: 0, free: 0 };
        }
        if (isFree) {
            poolCounts[poolId].free++;
        } else {
            poolCounts[poolId].paid++;
        }
        
        // Pity accumulation — FREE pulls do NOT count toward pity
        if (!isFree) {
            if (!countAcc[pityKey]) countAcc[pityKey] = 0;
            countAcc[pityKey]++;
        }
        
        const isGold = (rarity === "6");
        
        if (isGold) {
            if (!isFree) {
                // Only assign interval (pull count) for non-free golds
                logsCopy[i].interval = countAcc[pityKey];
                countAcc[pityKey] = 0;
            }
            // Free golds: no interval assigned (will show in recent golds without pull count)
        }
    }
    
    logsCopy.reverse(); // back to Time Descending
    
    return {
        logs: logsCopy,
        starcounts,
        starcountsPool,
        catCounts,   // { paid, free } per category
        poolCounts,  // { paid, free } per poolId
        countAcc,    // remaining pity per pityKey (only paid pulls)
        poolPityKey, // poolId -> pityKey（重構池是 rerun:<poolName>，其餘就是 poolId 本身）
        totalPulls: logsCopy.length
    };
}

module.exports = {
    getRoles,
    fetchAllLogsSlowly,
    mergeLogs,
    analyzeLogs,
    // 供 index.js 做 uid consistency check
    fetchBindingRoles,
    // 匯出供測試與前端推導
    ALL_CATEGORIES,
    CHAR_POOL_TYPES
};
