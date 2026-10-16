#!/usr/bin/env node
/**
 * 重構尋訪（Rerun）的分類與保底案例。
 *
 * 為什麼是合成資料：沒有任何真實 Rerun 紀錄可用 —— 測試帳號該卡池 0 筆，
 * 備份與 ef_full_char.json 也都沒有。所以這裡用合成紀錄釘住設計意圖：
 *   * 一般尋訪：保底在換 poolId 時歸零（官方規則「尋訪關閉時清零、不繼承」）
 *   * 重構尋訪：保底以「同名」累積，跨 poolId 不歸零
 *   * 顯示一律以 poolId 分組，即使 poolName 相同
 *
 * 用法（工作區根目錄）：node Firebase-endfieldgacha/scripts/pity-cases.js
 */
const path = require('path');
const Module = require('module');
const stub = () => { throw new Error('axios stub'); };
const origLoad = Module._load;
Module._load = function (r, ...a) { return r === 'axios' ? { get: stub, post: stub } : origLoad.call(this, r, ...a); };

const { analyzeLogs } = require(path.resolve(__dirname, '../functions/utils.js'));

let failed = 0;
function check(name, actual, expected) {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { console.log(`  ✅ ${name}`); return; }
    failed++;
    console.log(`  ❌ ${name}\n       期望: ${e}\n       實際: ${a}`);
}

let seq = 0;
const rec = (o) => Object.assign({
    seqId: String(++seq), gachaTs: String(1760000000000 + seq * 1000),
    rarity: 3, isFree: false, charId: 'c', charName: 'x', itemCategory: 'char', kind: 'draw',
}, o);

// analyzeLogs 預期輸入為時間遞減（它內部先 reverse 成遞增），所以建完要反轉
const run = (recs) => analyzeLogs(recs.slice().reverse());

console.log('\n[1] 一般尋訪：換 poolId 時保底歸零（官方規則，不繼承）');
{
    const logs = [
        ...Array.from({ length: 12 }, () => rec({ poolId: 'special_1_4_2', poolName: '晨星於此閃耀', poolType: 'E_CharacterGachaPoolType_Special' })),
        ...Array.from({ length: 5 }, () => rec({ poolId: 'special_1_5_1', poolName: '冬獵', poolType: 'E_CharacterGachaPoolType_Special' })),
        rec({ poolId: 'special_1_5_1', poolName: '冬獵', poolType: 'E_CharacterGachaPoolType_Special', rarity: 6 }),
    ];
    const a = run(logs);
    const gold = a.logs.find(x => x.rarity === 6);
    check('6★ 的 interval 只算新池的 6 抽（不含舊池殘留 12）', gold.interval, 6);
    check('舊池殘留仍留在自己的 key', a.countAcc['special_1_4_2'], 12);
    check('分類正確', gold.poolCategory, '特許尋訪');
}

console.log('\n[2] 重構尋訪：同名、不同 poolId → 保底跨池累積');
{
    const logs = [
        ...Array.from({ length: 30 }, () => rec({ poolId: 'rerun_chr_yvonne', poolName: '點繪尋訪', poolType: 'E_CharacterGachaPoolType_Rerun' })),
        ...Array.from({ length: 24 }, () => rec({ poolId: 'rerun_chr_yvonne_2', poolName: '點繪尋訪', poolType: 'E_CharacterGachaPoolType_Rerun' })),
        rec({ poolId: 'rerun_chr_yvonne_2', poolName: '點繪尋訪', poolType: 'E_CharacterGachaPoolType_Rerun', rarity: 6 }),
    ];
    const a = run(logs);
    const gold = a.logs.find(x => x.rarity === 6);
    check('6★ 的 interval = 30+24+1 = 55（跨 poolId 累積）', gold.interval, 55);
    check('分類為 重構尋訪', gold.poolCategory, '重構尋訪');
    check('兩個 poolId 共用同一個 pityKey', [a.poolPityKey['rerun_chr_yvonne'], a.poolPityKey['rerun_chr_yvonne_2']],
        ['rerun:點繪尋訪', 'rerun:點繪尋訪']);
    check('顯示分組仍以 poolId 區分（poolCounts 兩個獨立 key）',
        [a.poolCounts['rerun_chr_yvonne'].paid, a.poolCounts['rerun_chr_yvonne_2'].paid], [30, 25]);
}

console.log('\n[3] 重構尋訪：不同名 → 不互相累積');
{
    const logs = [
        ...Array.from({ length: 20 }, () => rec({ poolId: 'rerun_chr_a', poolName: 'A 復刻', poolType: 'E_CharacterGachaPoolType_Rerun' })),
        ...Array.from({ length: 3 }, () => rec({ poolId: 'rerun_chr_b', poolName: 'B 復刻', poolType: 'E_CharacterGachaPoolType_Rerun' })),
        rec({ poolId: 'rerun_chr_b', poolName: 'B 復刻', poolType: 'E_CharacterGachaPoolType_Rerun', rarity: 6 }),
    ];
    const a = run(logs);
    check('B 的 6★ interval = 4，不吃 A 的 20', a.logs.find(x => x.rarity === 6).interval, 4);
    check('A 的殘留獨立保留', a.countAcc['rerun:A 復刻'], 20);
}

console.log('\n[4] 武器側的重構池（註冊表標記 poolType=rerun）');
{
    const w = (o) => rec(Object.assign({ itemCategory: 'weapon', weaponId: 'w', weaponName: 'ww' }, o));
    const logs = [
        ...Array.from({ length: 10 }, () => w({ poolId: 'weponbox_1_5_1', poolName: '幽寒申領', poolType: 'normal' })),
        ...Array.from({ length: 7 }, () => w({ poolId: 'rerun_wpn_yvonne', poolName: '點繪申領', poolType: 'rerun' })),
        w({ poolId: 'rerun_wpn_yvonne_2', poolName: '點繪申領', poolType: 'rerun', rarity: 6 }),
    ];
    const a = run(logs);
    const gold = a.logs.find(x => x.rarity === 6);
    check('武器重構池仍分類為 武庫申領（武器不與角色混）', gold.poolCategory, '武庫申領');
    check('武器重構池保底以同名累積 = 8', gold.interval, 8);
    check('一般武器池的殘留以 poolId 獨立', a.countAcc['weponbox_1_5_1'], 10);
}

console.log('\n[5] 舊紀錄沒有 poolType → 前綴 fallback 仍能認出重構池');
{
    const logs = [
        ...Array.from({ length: 9 }, () => rec({ poolId: 'rerun_chr_old', poolName: '舊復刻' })),       // 無 poolType
        rec({ poolId: 'rerun_chr_old_2', poolName: '舊復刻', rarity: 6 }),                               // 無 poolType
    ];
    const a = run(logs);
    const gold = a.logs.find(x => x.rarity === 6);
    check('fallback 判定為 重構尋訪', gold.poolCategory, '重構尋訪');
    check('fallback 也跨同名累積 = 10', gold.interval, 10);
}

console.log('\n[6] 未知卡池 → 落入 其他尋訪 且計入統計（不再靜默消失）');
{
    const a = run([rec({ poolId: 'brand_new_pool_2027', poolName: '未來卡池', rarity: 6 })]);
    check('分類為 其他尋訪', a.logs[0].poolCategory, '其他尋訪');
    check('其他尋訪 有計數', a.catCounts['其他尋訪'].paid, 1);
    check('其他尋訪 的 starcounts 有計數', a.starcounts['其他尋訪']['6'], 1);
}

console.log('\n[7] poolType 優先於 poolId 前綴（官方 typo 不影響）');
{
    const a = run([
        rec({ poolId: 'weponbox_1_6_1', poolName: '少一個a', itemCategory: 'weapon', weaponId: 'w', weaponName: 'w', poolType: 'normal' }),
        rec({ poolId: 'weaponbox_1_6_1', poolName: '拼法正確', itemCategory: 'weapon', weaponId: 'w', weaponName: 'w', poolType: 'normal' }),
    ]);
    check('兩種拼法都落在 武庫申領', a.logs.map(x => x.poolCategory), ['武庫申領', '武庫申領']);
}

console.log('\n[8] 贈送抽不計保底（既有規則未被破壞）');
{
    const logs = [
        ...Array.from({ length: 4 }, () => rec({ poolId: 'standard', poolName: '基礎尋訪', poolType: 'E_CharacterGachaPoolType_Standard' })),
        rec({ poolId: 'standard', poolName: '基礎尋訪', poolType: 'E_CharacterGachaPoolType_Standard', isFree: true }),
        rec({ poolId: 'standard', poolName: '基礎尋訪', poolType: 'E_CharacterGachaPoolType_Standard', rarity: 6 }),
    ];
    const a = run(logs);
    check('interval = 5，贈抽不計入', a.logs.find(x => x.rarity === 6 && !x.isFree).interval, 5);
}

console.log('\n[9] 尋訪情報書（kind 非 draw）被過濾，且舊紀錄無 kind 仍保留');
{
    const a = run([
        rec({ poolId: 'standard', poolName: '基礎尋訪', kind: 'gift_intel_book' }),
        rec({ poolId: 'standard', poolName: '基礎尋訪', kind: 'draw' }),
        (() => { const r = rec({ poolId: 'standard', poolName: '基礎尋訪' }); delete r.kind; return r; })(),
    ]);
    check('只留下 2 筆（draw + 無 kind 的舊紀錄）', a.totalPulls, 2);
}

console.log(failed === 0 ? '\n✅ 全部案例通過\n' : `\n❌ ${failed} 個案例失敗\n`);
process.exit(failed === 0 ? 0 : 1);
