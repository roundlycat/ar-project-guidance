import os
import json
import datetime
import psycopg2
import google.generativeai as genai

DB_DSN = os.environ.get("DATABASE_URL", "postgres://postgres:postgres@localhost:5432/sensor_ecology")
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY")
NOTE_PATH = "notebooklm_master_project.md"

if GEMINI_API_KEY:
    genai.configure(api_key=GEMINI_API_KEY)

TEMPLATE = """
#### 🌐 Sensor Ecology Master Project Note (LATEST UPDATE: {timestamp})

This note is the canonical source of truth for the active "AR-guidance" project, designed to be used as a primary context note to define priors for AI synthesis.

## 1. Known Units Catalogue
This section lists the hardware components and software nodes that are confirmed operational and fully registered in the **sensor_ecology** database.

{catalogue}

## 2. Dynamic Assembly State
{assembly_context}

***
Automated compose run completed by Antigravity Handoff.
"""

def fetch_catalogue():
    conn = psycopg2.connect(DB_DSN)
    results = []
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT component_model, summary FROM parts_catalogue;")
            for row in cur.fetchall():
                results.append({"model": row[0], "summary": row[1]})
        return results
    except Exception as e:
        print(f"Error reading DB: {e}")
        return []
    finally:
        conn.close()

def generate_catalog_markdown(parts):
    if not GEMINI_API_KEY:
        md = ""
        for i, p in enumerate(parts):
            md += f"### Unit {i+1:03d}: {p['model']}\n* **Role:** Identified hardware component\n* **Summary:** {p['summary']}\n\n"
        return md
        
    prompt = f"Convert this raw database dump of identified parts into a beautifully structured 'Known Units Catalogue' using Markdown, following the styling of the provided template notes (Role, Primary Duty, Priors):\n{json.dumps(parts)}"
    try:
        model = genai.GenerativeModel('gemini-2.5-flash')
        response = model.generate_content(prompt)
        return response.text
    except Exception as e:
        return f"Error composing via Gemini: {e}"

def compose_note():
    parts = fetch_catalogue()
    catalogue_md = generate_catalog_markdown(parts) if parts else "No parts currently registered in the database."
    
    final_note = TEMPLATE.format(
        timestamp=datetime.datetime.now().isoformat(timespec='minutes'),
        catalogue=catalogue_md,
        assembly_context="Awaiting real-time assembly context from AR workstation..."
    )
    
    with open(NOTE_PATH, "w", encoding="utf-8") as f:
        f.write(final_note)
        
    print(f"✅ Generated {NOTE_PATH}")

if __name__ == "__main__":
    compose_note()
