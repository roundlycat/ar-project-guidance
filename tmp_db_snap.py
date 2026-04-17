import psycopg2
import json

try:
    conn = psycopg2.connect("dbname=sensor_ecology user=sean password=ecology host=192.168.0.28")
    cur = conn.cursor()
    cur.execute("SELECT column_name, data_type FROM information_schema.columns WHERE table_name='board_snapshots';")
    cols = cur.fetchall()
    with open('tmp_out_snap.txt', 'w') as f:
        json.dump(cols, f)
except Exception as e:
    with open('tmp_out_snap.txt', 'w') as f:
        f.write("ERROR: " + str(e))
