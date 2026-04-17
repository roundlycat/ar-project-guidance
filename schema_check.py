import psycopg2
conn = psycopg2.connect('dbname=sensor_ecology user=sean password=ecology host=192.168.0.28')
cur = conn.cursor()
cur.execute("""
    SELECT pg_catalog.format_type(a.atttypid, a.atttypmod)
    FROM pg_catalog.pg_attribute a
    JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
    WHERE c.relname = 'parts_catalogue' AND a.attname = 'embedding'
""")
print('embedding column type:', cur.fetchone())
