"""
registry_intake.py — Parts registry intake for Sensor Ecology

Adds two things to the FastAPI app:
  POST /api/registry/intake   — receives image + optional text from iPhone
  GET  /registry              — serves the upload UI (open in iPhone Safari)

Wire in with:
    from registry_intake import router as registry_router
    app.include_router(registry_router)

The endpoint:
  1. Saves the raw image to registry_intake/
  2. Runs Gemini vision if no analysis text was pasted
  3. Generates a pgvector embedding via sentence-transformers
  4. Inserts into registry_components table
"""

import os
import logging
from datetime import datetime
from pathlib import Path

import psycopg2
import numpy as np
from fastapi import APIRouter, File, Form, UploadFile, HTTPException
from fastapi.responses import HTMLResponse, JSONResponse
try:
    from sentence_transformers import SentenceTransformer
    from google import genai
    from google.genai import types
except ImportError:
    pass

log = logging.getLogger(__name__)

router = APIRouter(tags=["registry"])

# ── Config ────────────────────────────────────────────────────────────────────
INTAKE_DIR   = Path("/home/sean/sensor_ecology/registry_intake")
INTAKE_DIR.mkdir(parents=True, exist_ok=True)

SNAPSHOT_DIR = Path("/home/sean/sensor_ecology/board_snapshots")
SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)

# ⚠️ Routing Magic: Points to Inferno's PostgreSQL Database Node
DB_DSN       = os.environ.get("DATABASE_URL",
               "dbname=sensor_ecology user=sean password=ecology host=192.168.0.28")
GEMINI_MODEL = "gemini-2.5-flash"
EMBED_MODEL  = "BAAI/bge-large-en-v1.5"

# Load embedding model once at module import — stays in memory
log.info("Loading embedding model %s …", EMBED_MODEL)
try:
    _embedder = SentenceTransformer(EMBED_MODEL)
    log.info("Embedding model ready.")
except Exception as e:
    log.error(f"Could not load SentenceTransformers: {e}")
    _embedder = None

try:
    gemini_key = os.environ.get("GEMINI_API_KEY")
    if gemini_key:
        _gemini = genai.Client(api_key=gemini_key)
        log.info("Gemini Cloud client ready.")
    else:
        _gemini = None
        log.warning("GEMINI_API_KEY not found in Pi environment. Backend analysis disabled.")
except Exception as e:
    log.error(f"Could not load Gemini API: {e}")
    _gemini = None

# ── Gemini analysis prompt ────────────────────────────────────────────────────
INTAKE_PROMPT = """
You are an electronics component analyst. Examine this photo of an electronic
component or module and return a JSON object with these fields:

{
  "component_type": "canonical type slug, e.g. esp32_wroom, bme688, uln2003",
  "label": "short human-readable name, e.g. ESP32 Dev Board",
  "description": "2-3 sentence technical description including visible features,
                  likely pinout, and any markings you can read",
  "confidence": "high | medium | low",
  "notes": "anything uncertain or worth flagging, or null"
}

Return ONLY valid JSON, no markdown fences, no preamble.
"""

IDENTIFY_PROMPT = """
Describe the visual features of this electronic component in 2-3 sentences.
Focus on its PCB color, physical shape, number of pins, major chips, and any readable text markings.
Be specific and concise. Do NOT output JSON, just pure text describing what you see.
"""

# ── Helpers ───────────────────────────────────────────────────────────────────
def _analyse_image(image_bytes: bytes) -> dict:
    """Send image to Gemini, return parsed component dict."""
    import json
    if not _gemini:
        raise Exception("Gemini client not loaded properly.")
    response = _gemini.models.generate_content(
        model=GEMINI_MODEL,
        contents=[
            types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
            INTAKE_PROMPT,
        ],
        config=types.GenerateContentConfig(
            temperature=0.1,
            response_mime_type="application/json",
        ),
    )
    return json.loads(response.text.strip())


def _embed(text: str) -> list[float]:
    """Generate embedding vector from text."""
    if not _embedder:
        return [0.0] * 1024 # dummy vector if missing
    vec = _embedder.encode(text, normalize_embeddings=True)
    return vec.tolist()


def _insert_registry(filename: str, image_path: str, analysis: dict,
                     raw_text: str, embedding: list[float]):
    """Upsert component into PostgreSQL registry."""
    conn = psycopg2.connect(DB_DSN)
    try:
        from pgvector.psycopg2 import register_vector
        register_vector(conn)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO parts_catalogue
                    (image_filename, image_path, ocr_raw, component_model,
                     summary, embedding)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (image_filename) DO UPDATE SET
                    ocr_raw          = EXCLUDED.ocr_raw,
                    component_model  = EXCLUDED.component_model,
                    summary          = EXCLUDED.summary,
                    embedding        = EXCLUDED.embedding;
            """, (
                filename,
                str(image_path),
                raw_text,
                analysis.get("component_type") or analysis.get("label"),
                analysis.get("description", raw_text),
                embedding,
            ))
        conn.commit()
    finally:
        conn.close()


def _search_registry(embedding: list[float]):
    """Query PostgreSQL using pgvector cosine similarity."""
    conn = psycopg2.connect(DB_DSN)
    try:
        from pgvector.psycopg2 import register_vector
        register_vector(conn)
        with conn.cursor() as cur:
            cur.execute("""
                SELECT component_model, image_filename, summary, (1 - (embedding <=> %s::vector)) as similarity 
                FROM parts_catalogue 
                ORDER BY embedding <=> %s::vector 
                LIMIT 1;
            """, (embedding, embedding))
            row = cur.fetchone()
            if row:
                return {
                    "label": row[0] if row[0] else "Unknown Model",
                    "component_type": row[1] if row[1] else "N/A",
                    "description": row[2] if row[2] else "",
                    "similarity": float(row[3])
                }
            return None
    finally:
        conn.close()


# ── Upload UI ─────────────────────────────────────────────────────────────────
UPLOAD_HTML = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parts Intake — Sensor Ecology</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, sans-serif;
      background: #0a0f0d;
      color: #c8d5c8;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 32px 16px;
    }
    h1 {
      font-size: 1.2rem;
      font-weight: 500;
      color: #2dd4a0;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      margin-bottom: 28px;
    }
    form {
      width: 100%;
      max-width: 420px;
      background: #111a14;
      border: 1px solid #1e3028;
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 20px;
    }
    label {
      font-size: 0.75rem;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: #5a8a6a;
      display: block;
      margin-bottom: 6px;
    }
    input[type=file] {
      width: 100%;
      background: #0d1610;
      border: 1px dashed #2a4a35;
      border-radius: 8px;
      padding: 14px;
      color: #8ab89a;
      font-size: 0.9rem;
    }
    textarea {
      width: 100%;
      background: #0d1610;
      border: 1px solid #1e3028;
      border-radius: 8px;
      padding: 12px;
      color: #c8d5c8;
      font-size: 0.85rem;
      font-family: monospace;
      height: 120px;
      resize: vertical;
    }
    textarea::placeholder { color: #3a5a45; }
    button {
      width: 100%;
      padding: 14px;
      background: #0f6e56;
      color: #e0f5ee;
      border: none;
      border-radius: 8px;
      font-size: 1rem;
      font-weight: 500;
      cursor: pointer;
      transition: background 0.2s;
    }
    button:hover { background: #1a9e7a; }
    .hint {
      font-size: 0.75rem;
      color: #3a5a45;
      text-align: center;
      margin-top: -8px;
    }
    #result {
      margin-top: 20px;
      width: 100%;
      max-width: 420px;
      background: #0d1a10;
      border: 1px solid #1e3028;
      border-radius: 8px;
      padding: 16px;
      font-family: monospace;
      font-size: 0.8rem;
      color: #2dd4a0;
      display: none;
      white-space: pre-wrap;
    }
  </style>
</head>
<body>
  <h1>Registry Parts Intake</h1>
  <form id="intake-form" enctype="multipart/form-data">
    <div>
      <label>Component Photo</label>
      <input type="file" name="file" accept="image/*" required>
    </div>
    <div>
      <label>Analysis text (optional — leave blank to auto-analyse)</label>
      <textarea name="gemini_text"
        placeholder="Paste Gemini analysis here, or leave blank and the system will analyse the image automatically."></textarea>
    </div>
    <button type="submit" id="submit-btn">Upload to Registry</button>
    <p class="hint">Image is sent to Inferno uncompressed</p>
  </form>
  <div id="result"></div>

  <script>
    document.getElementById('intake-form').addEventListener('submit', async e => {
      e.preventDefault();
      const btn = document.getElementById('submit-btn');
      const result = document.getElementById('result');
      btn.textContent = 'Analysing…';
      btn.disabled = true;
      result.style.display = 'none';

      const data = new FormData(e.target);
      try {
        const r = await fetch('/api/registry/intake', {
          method: 'POST', body: data
        });
        const json = await r.json();
        result.style.display = 'block';
        result.textContent = JSON.stringify(json, null, 2);
        if (r.ok) btn.textContent = '✓ Saved to Registry';
        else { btn.textContent = 'Upload to Registry'; btn.disabled = false; }
      } catch (err) {
        result.style.display = 'block';
        result.textContent = 'Error: ' + err.message;
        btn.textContent = 'Upload to Registry';
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>
"""

# ── Routes ────────────────────────────────────────────────────────────────────
@router.get("/registry", response_class=HTMLResponse)
async def intake_ui():
    """Serve the upload page — open on iPhone"""
    return UPLOAD_HTML


@router.post("/api/registry/intake")
async def intake_component(
    file: UploadFile = File(...),
    gemini_text: str = Form(default=""),
):
    # 1. Save raw image
    timestamp   = datetime.now().strftime("%Y%m%d_%H%M%S")
    ext         = Path(file.filename).suffix or ".jpg"
    base_name   = f"part_{timestamp}"
    image_path  = INTAKE_DIR / f"{base_name}{ext}"
    image_bytes = await file.read()

    with open(image_path, "wb") as f:
        f.write(image_bytes)
    log.info("Saved intake image: %s", image_path)

    # 2. Analyse — use pasted text if provided, otherwise run Gemini
    if gemini_text.strip():
        raw_text = gemini_text.strip()
        analysis = {
            "component_type": "manual_entry",
            "label":          base_name,
            "description":    raw_text,
            "confidence":     "manual",
        }
    else:
        log.info("No text provided — running Gemini analysis…")
        try:
            analysis = _analyse_image(image_bytes)
            raw_text = str(analysis)
        except Exception as e:
            log.error("Gemini analysis failed: %s", e)
            raise HTTPException(status_code=502, detail=f"Gemini error: {e}")

    # 3. Generate embedding
    embed_text = (
        f"{analysis.get('label', '')} "
        f"{analysis.get('component_type', '')} "
        f"{analysis.get('description', raw_text)}"
    )
    embedding = _embed(embed_text)

    # 4. Insert into registry
    try:
        _insert_registry(base_name, str(image_path), analysis, raw_text, embedding)
    except Exception as e:
        log.error("Registry DB insert failed: %s", e)
        raise HTTPException(status_code=500, detail=f"DB error: {e}")

    return JSONResponse({
        "status":         "success",
        "id":             base_name,
        "label":          analysis.get("label"),
        "component_type": analysis.get("component_type"),
        "confidence":     analysis.get("confidence"),
        "notes":          analysis.get("notes"),
        "image_saved":    str(image_path),
    })

@router.post("/api/registry/identify")
async def identify_component(file: UploadFile = File(...)):
    """The Slow Track AR endpoint. Receives cropped image, searches for best match."""
    image_bytes = await file.read()
    
    # 1. Ask Gemini for a raw visual description
    if not _gemini:
        raise HTTPException(status_code=500, detail="Gemini client not configured")
        
    try:
        response = _gemini.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                types.Part.from_bytes(data=image_bytes, mime_type="image/jpeg"),
                IDENTIFY_PROMPT,
            ],
            config=types.GenerateContentConfig(temperature=0.1),
        )
        visual_description = response.text.strip()
    except Exception as e:
        log.error("Gemini description failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Gemini error: {e}")
        
    # 2. Convert visual description into mathematical coordinates (embedding)
    embedding = _embed(visual_description)
    
    # 3. Vector similarity search against PostgreSQL 
    try:
        best_match = _search_registry(embedding)
    except Exception as e:
        log.error("Registry search error: %s", e)
        raise HTTPException(status_code=500, detail=f"DB error: {e}")
        
    if not best_match:
        return JSONResponse({"status": "not_found", "message": "No components in registry"})
        
    return JSONResponse({
        "status": "success",
        "description_used": visual_description,
        "match": best_match
    })

@router.post("/api/registry/snapshot")
async def save_bench_snapshot(file: UploadFile = File(...)):
    """Save a wide-angle 1080p bench snapshot for spatial logging."""
    timestamp = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    base_name = f"Bench_Snap_{timestamp}"
    ext = Path(file.filename).suffix or ".jpg"
    image_path = SNAPSHOT_DIR / f"{base_name}{ext}"
    
    image_bytes = await file.read()
    with open(image_path, "wb") as f:
        f.write(image_bytes)
        
    conn = psycopg2.connect(DB_DSN)
    try:
        with conn.cursor() as cur:
            # We cautiously try to log this to the DB. If schema differs, disk save survives.
            try:
                cur.execute("""
                    INSERT INTO board_snapshots (timestamp, image_path)
                    VALUES (NOW(), %s);
                """, (str(image_path),))
                conn.commit()
            except Exception as db_err:
                log.warning(f"Could not log snapshot to DB (disk save successful): {db_err}")
                conn.rollback()
    except Exception as e:
        log.warning(f"Connection error while logging snapshot: {e}")
    finally:
        conn.close()

    log.info("Saved Bench Snapshot: %s", image_path)
    return JSONResponse({"status": "success", "file": str(image_path)})
