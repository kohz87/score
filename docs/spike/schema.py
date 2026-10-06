import sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
print("# user_version:", con.execute("pragma user_version").fetchone()[0], "| journal:", con.execute("pragma journal_mode").fetchone()[0])
for name, sql in con.execute("select name, sql from sqlite_master where type in ('table','index','trigger','view') and name not like 'sqlite_%' and sql is not null order by type desc, name"):
    if "_fts_" in name or name.endswith(("_data","_idx","_docsize","_config","_content")): continue
    try: n = con.execute(f'select count(*) from "{name}"').fetchone()[0] if not sql.upper().startswith(("CREATE INDEX","CREATE UNIQUE","CREATE TRIGGER")) else None
    except Exception: n = None
    print(f"-- {name}" + (f"  (rows: {n})" if n is not None else ""))
    print(sql + ";")
