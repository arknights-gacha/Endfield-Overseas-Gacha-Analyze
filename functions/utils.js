const axios = require('axios');

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

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
    
    return { oauthToken, roles };
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
    const url = `https://ef-webview.gryphline.com/api/record/${category}`;
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

async function fetchLogsByPool(u8_token, server_id, pool_type, category = "char") {
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
            item.poolName = item.poolName || "武庫申領";
        }
    }
    return allLogs;
}

async function fetchAllLogsSlowly(uid, server_id, oauthToken) {
    const u8_token = await getU8Token(uid, oauthToken);
    
    const StandardLogs = await fetchLogsByPool(u8_token, server_id, "E_CharacterGachaPoolType_Standard", "char");
    const SpecialLogs = await fetchLogsByPool(u8_token, server_id, "E_CharacterGachaPoolType_Special", "char");
    const BeginnerLogs = await fetchLogsByPool(u8_token, server_id, "E_CharacterGachaPoolType_Beginner", "char");
    const JointLogs = await fetchLogsByPool(u8_token, server_id, "E_CharacterGachaPoolType_Joint", "char");
    const WeaponLogs = await fetchLogsByPool(u8_token, server_id, null, "weapon");

    // We keep them all in one array to save, but they don't inherit pity.
    // They are returned as a flat array. We can just sort them by gachaTs desc.
    let allLogs = [...StandardLogs, ...SpecialLogs, ...BeginnerLogs, ...JointLogs, ...WeaponLogs];
    
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

function analyzeLogs(logs) {
    let logsCopy = logs;
    logsCopy.reverse(); // Time Ascending
    
    // We group them by 5 categories as requested: 基礎尋訪, 特許尋訪, 輝光慶典, 啟程尋訪, 武庫申領
    
    let starcounts = {
        '基礎尋訪': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 },
        '特許尋訪': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 },
        '輝光慶典': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 },
        '啟程尋訪': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 },
        '武庫申領': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 },
        '其他尋訪': { '6': 0, '5': 0, '4': 0, '3': 0, '2': 0 } // For unknown
    };
    
    // Track paid vs free counts per category
    let catCounts = {
        '基礎尋訪': { paid: 0, free: 0 },
        '特許尋訪': { paid: 0, free: 0 },
        '輝光慶典': { paid: 0, free: 0 },
        '啟程尋訪': { paid: 0, free: 0 },
        '武庫申領': { paid: 0, free: 0 },
        '其他尋訪': { paid: 0, free: 0 }
    };
    
    let starcountsPool = {};
    // Track paid vs free counts per pool
    let poolCounts = {};
    let countAcc = {
        '基礎尋訪': 0,
        '特許尋訪': 0,
        '輝光慶典': 0,
        '啟程尋訪': 0,
        '武庫申領': 0,
        '其他尋訪': 0
    };
    
    for (let i = 0; i < logsCopy.length; i++) {
        let item = logsCopy[i];
        let rarity = String(item.rarity);
        let poolId = item.poolId;
        let isFree = !!item.isFree;
        
        let category = '其他尋訪';
        if (item.itemCategory === 'weapon') {
            category = '武庫申領';
            item.poolCategory = category;
        } else {
            if (poolId === 'standard') {
                category = '基礎尋訪';
            } else if (poolId === 'beginner') {
                category = '啟程尋訪';
            } else if (poolId && poolId.startsWith('special')) {
                category = '特許尋訪';
            } else if (poolId && poolId.startsWith('joint')) {
                category = '輝光慶典';
            }
            item.poolCategory = category;
        }
        
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
            if (!countAcc[poolId]) countAcc[poolId] = 0;
            countAcc[poolId]++;
        }
        
        const isGold = (rarity === "6");
        
        if (isGold) {
            if (!isFree) {
                // Only assign interval (pull count) for non-free golds
                logsCopy[i].interval = countAcc[poolId];
                countAcc[poolId] = 0;
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
        countAcc,    // remaining pity per poolId (only paid pulls)
        totalPulls: logsCopy.length
    };
}

module.exports = {
    getRoles,
    fetchAllLogsSlowly,
    mergeLogs,
    analyzeLogs
};
