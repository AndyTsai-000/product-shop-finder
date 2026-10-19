"""每月更新：重抓資料 → 檢查 → 上傳 GitHub（GitHub Pages 會自動更新網站）。

Windows 工作排程器「產品找店家每月更新」每月 6 日 09:00 執行這支程式。
紀錄寫在 update.log。資料異常時還原成上次的資料，不上傳。
"""
import datetime, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(ROOT, 'update.log')


def log(msg):
    line = datetime.datetime.now().strftime('%Y-%m-%d %H:%M ') + msg
    print(line, flush=True)
    with open(LOG, 'a', encoding='utf-8') as f:
        f.write(line + '\n')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, encoding='utf-8')


def restore():
    git('checkout', '--', 'site/data')
    git('clean', '-fdq', 'site/data')


def main():
    env = dict(os.environ, PYTHONIOENCODING='utf-8')
    r = subprocess.run([sys.executable, '-u', os.path.join(ROOT, 'build.py')], cwd=ROOT, env=env,
                       capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        log('更新失敗，保留舊資料：' + (r.stderr or r.stdout).strip().splitlines()[-1][:300])
        restore()
        return 1
    summary = json.loads(r.stdout.strip().splitlines()[-1])
    if summary['old'] and summary['shops'] < summary['old'] * 0.8:
        log(f"店家總數 {summary['shops']} 比上次 {summary['old']} 少超過兩成，可能資料不完整，已還原，未上傳")
        restore()
        return 1
    git('add', '-A', 'site/data')
    if not git('status', '--porcelain', 'site/data').stdout.strip():
        log(f"資料沒有變動（{summary['shops']} 家）")
        return 0
    month = datetime.date.today().strftime('%Y-%m')
    c = git('commit', '-m', f'每月更新資料 {month}：{summary["shops"]} 家')
    p = git('push')
    if p.returncode != 0:
        log('上傳 GitHub 失敗：' + p.stderr.strip()[-300:])
        return 1
    log(f"已更新並上傳：{summary['shops']} 家（上次 {summary['old']}）")
    return 0


if __name__ == '__main__':
    sys.exit(main())
