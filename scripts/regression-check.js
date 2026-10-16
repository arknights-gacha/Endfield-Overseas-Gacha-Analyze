#!/usr/bin/env node
/**
 * 回歸檢查：以 gacha-backup/ 的歷史快照驗證 analyzeLogs / mergeLogs 的輸出未改變。
 *
 * 為什麼需要這支：依 endfield-fix-plan.md 發現④，官方 API 只保留約 3 個月的紀錄，
 * 備份裡 2026-01~05 的紀錄已無法重新抓取。這些快照是唯一的安全網。
 *
 * 用法（在工作區根目錄 ~/Documents/Arknights/ 執行）：
 *   node Firebase-endfieldgacha/scripts/regression-check.js            # 比對 golden
 *   node Firebase-endfieldgacha/scripts/regression-check.js --update   # 重新產生 golden
 *
 * 不需要 npm install：utils.js 第一行 require('axios') 但 analyzeLogs / mergeLogs
 * 完全不碰網路，所以這裡用 Module._load 掛一個 stub。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const stub = () => { throw new Error('axios stub: regression-check 不應發出網路請求'); };
const origLoad = Module._load;
Module._load = function (request, ...rest) {
    if (request === 'axios') return { get: stub, post: stub };
    return origLoad.call(this, request, ...rest);
};

const ROOT = path.resolve(__dirname, '../..');
const { analyzeLogs, mergeLogs } = require(path.join(ROOT, 'Firebase-endfieldgacha/functions/utils.js'));

const SNAPSHOTS = [
    'gacha-backup/[2026]ef_visit_logs/bak0421_ef_visit_logs_4677200022.json',
    'gacha-backup/[2026]ef_visit_logs/ef_bak0519_visit_logs.json',
];
const GOLDEN = path.join(__dirname, 'regression-golden.json');

function load(rel) {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    return Array.isArray(raw) ? raw : Object.values(raw)[0];
}

function tally(arr, keyFn) {
    const out = {};
    for (const x of arr) { const k = keyFn(x); out[k] = (out[k] || 0) + 1; }
    return Object.fromEntries(Object.entries(out).sort());
}

/** analyzeLogs 會就地改寫傳入的物件（poolCategory / interval），所以每次都給它乾淨的副本 */
function snapshotOf(logs) {
    const a = analyzeLogs(JSON.parse(JSON.stringify(logs)));
    const intervals = {};
    for (const x of a.logs) {
        if (x.interval !== undefined && x.interval !== null) {
            (intervals[x.poolId] = intervals[x.poolId] || []).push(x.interval);
        }
    }
    // a.logs 是時間遞減，所以 interval 陣列要反轉回時間遞增才穩定
    for (const k of Object.keys(intervals)) intervals[k].reverse();
    return {
        totalPulls: a.totalPulls,
        byItemCategoryAndPoolCategory: tally(a.logs, x => `${x.itemCategory}/${x.poolCategory}`),
        starcounts: a.starcounts,
        catCounts: a.catCounts,
        countAcc: Object.fromEntries(Object.entries(a.countAcc).sort()),
        poolCounts: Object.fromEntries(Object.entries(a.poolCounts).sort()),
        intervalsByPool: Object.fromEntries(Object.entries(intervals).sort()),
        poolPityKey: a.poolPityKey ? Object.fromEntries(Object.entries(a.poolPityKey).sort()) : null,
    };
}

function build() {
    const result = {};
    const loaded = SNAPSHOTS.map(load);

    SNAPSHOTS.forEach((rel, i) => {
        result[path.basename(rel)] = { recordCount: loaded[i].length, ...snapshotOf(loaded[i]) };
    });

    // mergeLogs：兩份快照的聯集。0421 應完全被 0519 涵蓋以外的部分才會增加筆數。
    const merged = mergeLogs(loaded[1], loaded[0]);
    result['__merged'] = {
        recordCount: merged.length,
        dedupKeys: new Set(merged.map(x => `${x.itemCategory}_${x.poolId}_${x.seqId}`)).size,
        ...snapshotOf(merged),
    };
    return result;
}

function diff(a, b, pathStr = '', out = []) {
    const sa = JSON.stringify(a), sb = JSON.stringify(b);
    if (sa === sb) return out;
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
        out.push(`  ${pathStr}\n    golden: ${sa}\n    現在:   ${sb}`);
        return out;
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
        diff(a[k], b[k], pathStr ? `${pathStr}.${k}` : k, out);
    }
    return out;
}

const current = build();

if (process.argv.includes('--update')) {
    fs.writeFileSync(GOLDEN, JSON.stringify(current, null, 2) + '\n');
    console.log(`✅ golden 已寫入 ${path.relative(ROOT, GOLDEN)}`);
    for (const [k, v] of Object.entries(current)) {
        console.log(`   ${k}: ${v.recordCount} 筆  ${JSON.stringify(v.byItemCategoryAndPoolCategory)}`);
    }
    process.exit(0);
}

if (!fs.existsSync(GOLDEN)) {
    console.error(`❌ 找不到 ${path.relative(ROOT, GOLDEN)}，請先以 --update 產生基準線`);
    process.exit(2);
}

const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const diffs = diff(golden, current);
if (diffs.length === 0) {
    console.log('✅ 回歸檢查通過：兩份快照與合併結果皆與 golden 逐一相符');
    for (const [k, v] of Object.entries(current)) {
        console.log(`   ${k}: ${v.recordCount} 筆  ${JSON.stringify(v.byItemCategoryAndPoolCategory)}`);
    }
    process.exit(0);
}
console.error(`❌ 回歸檢查失敗，${diffs.length} 處不一致：\n`);
console.error(diffs.join('\n'));
process.exit(1);
