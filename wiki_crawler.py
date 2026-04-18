import urllib.request
import re
import json

op_output_file = './functions/operators.js'
wp_output_file = './functions/weapons.js'


def fetch_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req) as response:
         return response.read().decode('utf-8')

def run_crawler():
    print("Fetching Bilibili Wiki Operator List...")
    wiki_op_html = fetch_html("https://wiki.biligame.com/zmd/%E5%B9%B2%E5%91%98%E5%9B%BE%E9%89%B4")
    
    print("Fetching Bilibili Wiki Weapon List...")
    wiki_wp_html = fetch_html("https://wiki.biligame.com/zmd/%E6%AD%A6%E5%99%A8%E5%9B%BE%E9%89%B4")
    
    # 解析 Bilibili Wiki 幹員並生成 operators.js
    pattern_op = re.compile(r'<img alt=\"([^\"]+)头像.png\" src=\"([^\"]+)\"')
    op_map = {}
    for match in pattern_op.finditer(wiki_op_html):
        cn_name = match.group(1).strip()
        wiki_url = match.group(2).strip()
        # 處理管理員例外
        if cn_name == "管理员·男" or cn_name == "管理员·女":
            cn_name = "管理员"
            # 由於男/女都叫管理员，這會覆蓋，但我們的 gacha 記錄裡管理員也只能用一種頭像。這裡隨意保留一種。
        if cn_name not in op_map:
            op_map[cn_name] = wiki_url

    # 寫入 operators.js
    with open(op_output_file, 'w', encoding='utf-8') as f:
        f.write('module.exports = ')
        json.dump(op_map, f, ensure_ascii=False, indent=4)
        f.write(';\n')
        
    print(f'成功！總共擷取了 {len(op_map)} 位幹員，已輸出至 {op_output_file}。')

    # 解析 Bilibili Wiki 武器並生成 weapons.js
    pattern_wp = re.compile(r'<img alt=\"([^\"]+)图标.png\" src=\"([^\"]+)\"')
    wp_map = {}
    for match in pattern_wp.finditer(wiki_wp_html):
        cn_name = match.group(1).strip()
        wiki_url = match.group(2).strip()
        # 排除無用圖標
        if 'ICON' in cn_name or 'icon' in cn_name or '物品' in cn_name:
            continue
        wp_map[cn_name] = wiki_url

    # 寫入 weapons.js
    with open(wp_output_file, 'w', encoding='utf-8') as f:
        f.write('module.exports = ')
        json.dump(wp_map, f, ensure_ascii=False, indent=4)
        f.write(';\n')

    print(f'成功！總共擷取了 {len(wp_map)} 把武器，已輸出至 {wp_output_file}。')

if __name__ == "__main__":
    run_crawler()
