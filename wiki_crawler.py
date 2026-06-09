import urllib.request
import re
import json
import gzip
from io import BytesIO
import ssl

op_output_file = './functions/operators.js'
wp_output_file = './functions/weapons.js'

ctx = ssl.create_default_context()
ctx.check_hostname = False
ctx.verify_mode = ssl.CERT_NONE

def fetch_html(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, context=ctx) as response:
        data = response.read()
        if response.info().get('Content-Encoding') == 'gzip' or data[:2] == b'\x1f\x8b':
            data = gzip.GzipFile(fileobj=BytesIO(data)).read()
        return data.decode('utf-8')

def run_crawler():
    print("Fetching Official CN Operator List (Names)...")
    cn_op_html = fetch_html("https://endfield.hypergryph.com/operator")
    
    print("Fetching Official CN Home Page (CSS for small avatars)...")
    home_html = fetch_html("https://endfield.hypergryph.com/")
    css_links = re.findall(r'href=\"([^\"]+\.css[^\"]*)\"', home_html)
    
    key_to_avatar = {}
    for link in css_links:
        if not link.startswith('http'):
            if link.startswith('/'):
                link = 'https://endfield.hypergryph.com' + link
            else:
                link = 'https://endfield.hypergryph.com/' + link
        css_content = fetch_html(link)
        matches = re.findall(r'\[data-key=([a-zA-Z0-9_\-]+)\]\{background-image:url\(([^)]+)\)', css_content)
        for m in matches:
            key = m[0]
            url = m[1].strip('\'"')
            if key not in key_to_avatar:
                key_to_avatar[key] = url.replace('web.hycdn.cn', 'web-static.hg-cdn.com')

    print("Fetching Bilibili Wiki Weapon List...")
    wiki_wp_html = fetch_html("https://wiki.biligame.com/zmd/%E6%AD%A6%E5%99%A8%E5%9B%BE%E9%89%B4")
    
    # 解析 Official CN 幹員並生成 operators.js
    pattern_op = re.compile(r'class=\"OperatorItem_image.*?data-key=\"([^\"]+)\".*?class=\"OperatorItem_nameText.*?>([^<]*)</span>', re.S)
    op_map = {}
    for match in pattern_op.finditer(cn_op_html):
        data_key = match.group(1).strip()
        cn_name = match.group(2).strip()
        
        # 保留男女管理員獨立命名
        if data_key == "endministrator1":
            cn_name = "管理员·女"
        elif data_key == "endministrator2":
            cn_name = "管理员·男"
            
        if cn_name not in op_map and data_key in key_to_avatar:
            op_map[cn_name] = key_to_avatar[data_key]

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
