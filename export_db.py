# -*- coding: utf-8 -*-
"""
迁移用数据库导出器：连不上 mysqldump 时的 Plan B（其实更可控）。
产出与 mysqldump 同风格的 SQL：SET 头 + CREATE TABLE（SHOW CREATE TABLE 原样）
+ 批量 INSERT（VALUES 十六进制安全转义）+ 尾注。
用法：python export_db.py <输出sql路径>
凭据全部从同目录 config.json 读，命令行零明文。
"""
import json, os, sys
import pymysql

OUT = sys.argv[1] if len(sys.argv) > 1 else "kongyu-dump.sql"
cfg = json.load(open(os.path.join(os.path.dirname(__file__), "config.json"), encoding="utf-8"))

conn = pymysql.connect(
    host=cfg["db_host"], port=int(cfg["db_port"]),
    user=cfg["db_user"], password=cfg["db_pass"],
    database=cfg["db_name"], charset="utf8mb4",
)
cur = conn.cursor()

def esc(v):
    """值转义：NULL / 数字 / 字符串（含 \n、\\、单引号、utf8mb4 原样写入）"""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, bytes):
        return "0x" + v.hex()
    s = str(v)
    return "'" + (s.replace("\\", "\\\\")
                   .replace("'", "\\'")
                   .replace("\n", "\\n")
                   .replace("\r", "\\r")) + "'"

with open(OUT, "w", encoding="utf-8", newline="\n") as f:
    w = f.write
    w("-- 空雨不流泪 · kongyu 库迁移导出（export_db.py，非 mysqldump）\n")
    w("-- 来源: %s@%s:%s/%s\n" % (cfg["db_user"], cfg["db_host"], cfg["db_port"], cfg["db_name"]))
    w("SET NAMES utf8mb4;\nSET FOREIGN_KEY_CHECKS = 0;\n\n")
    cur.execute("SHOW TABLES")
    tables = [r[0] for r in cur.fetchall()]
    for t in tables:
        cur.execute("SHOW CREATE TABLE `%s`" % t)
        ddl = cur.fetchone()[1]
        w("DROP TABLE IF EXISTS `%s`;\n%s;\n\n" % (t, ddl))
        cur.execute("SELECT * FROM `%s`" % t)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
        if rows:
            w("INSERT INTO `%s` (%s) VALUES\n" % (t, ", ".join("`%s`" % c for c in cols)))
            vals = [("(" + ", ".join(esc(v) for v in row) + ")") for row in rows]
            w(",\n".join(vals) + ";\n\n")
        print("导出 %s: %d 行" % (t, len(rows)))
    w("SET FOREIGN_KEY_CHECKS = 1;\n-- 导出完成，导入：mysql -u <用户> <库名> < 此文件\n")
conn.close()
print("SQL 已写入:", OUT, os.path.getsize(OUT), "bytes")
