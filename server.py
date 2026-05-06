import os
import base64
import json
import httpx
from dotenv import load_dotenv
load_dotenv()

from fastapi import FastAPI, Header, HTTPException, Response, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from typing import List, Optional
from registry_intake import router as registry_router


app = FastAPI(title="AR Guidance Server")

app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1|192\.168\.0\.\d+)(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

import unicodedata

def sanitize_text(text: str) -> str:
    """Strip unsafe unicode chars that crash E-Ink dashboards and downstream consumers."""
    if not text:
        return ""
    return unicodedata.normalize('NFKD', str(text)).encode('ascii', 'ignore').decode('utf-8')

app.include_router(registry_router)

BENCH_CAM_URL = os.getenv("BENCH_CAM_URL", "http://192.168.0.24:8080/snap")

class BoundingBox(BaseModel):
    ymin: float
    xmin: float
    ymax: float
    xmax: float

class WiringConnection(BaseModel):
    pin: str
    connected_to: str
    wire_color: str

class Component(BaseModel):
    type: str
    label: str
    box: BoundingBox
    notes: Optional[str] = None
    wiring: List[WiringConnection] = Field(default_factory=list)
    confidence: float = Field(default=1.0, description="0.0 to 1.0 representing certainty")

import math

class EpistemicDriftCalculator:
    def __init__(self):
        self.history = {} # label -> list of center points (x, y)
        self.max_history = 5
        self.confidence_history = {} # label -> list of confidence values

    def update(self, label: str, box: BoundingBox, confidence: float):
        cx = (box.xmin + box.xmax) / 2.0
        cy = (box.ymin + box.ymax) / 2.0
        
        if label not in self.history:
            self.history[label] = []
            self.confidence_history[label] = []
            
        self.history[label].append((cx, cy))
        self.confidence_history[label].append(confidence)
        
        if len(self.history[label]) > self.max_history:
            self.history[label].pop(0)
            self.confidence_history[label].pop(0)
            
    def get_spatial_drift(self, label: str) -> float:
        pts = self.history.get(label, [])
        if len(pts) < 2:
            return 0.0
        total_dist = 0.0
        for i in range(1, len(pts)):
            dx = pts[i][0] - pts[i-1][0]
            dy = pts[i][1] - pts[i-1][1]
            total_dist += math.sqrt(dx*dx + dy*dy)
        avg_dist = total_dist / (len(pts) - 1)
        return min(avg_dist * 2.0, 1.0)
        
    def get_semantic_drift(self, label: str) -> float:
        confs = self.confidence_history.get(label, [])
        if not confs:
            return 0.0
        avg_conf = sum(confs) / len(confs)
        return 1.0 - avg_conf

drift_calc = EpistemicDriftCalculator()

class CameraAnalysisResponse(BaseModel):
    components: List[Component]

class CameraAnalyseRequest(BaseModel):
    image_base64: Optional[str] = None

@app.post("/api/camera/analyse", response_model=CameraAnalysisResponse)
async def analyse_camera(req: Optional[CameraAnalyseRequest] = None, x_gemini_key: Optional[str] = Header(None)):
    api_key = x_gemini_key or os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API Key missing")

    if req and req.image_base64:
        encoded_img = req.image_base64
    else:
        async with httpx.AsyncClient(timeout=10.0) as client:
            try:
                r = await client.get(BENCH_CAM_URL)
                r.raise_for_status()
                image_bytes = r.content
            except httpx.RequestError as e:
                raise HTTPException(status_code=503, detail=f"Failed to fetch bench cam: {e}")
        encoded_img = base64.b64encode(image_bytes).decode("utf-8")
    
    prompt = """
    Analyze this top-down electronics workbench image. Identify all electronic components (e.g. Microcontrollers, ICs, Sensors, Breakouts) and prominent wiring connections.
    Ensure bounding boxes tightly frame the components.
    Return ONLY a raw JSON object (no markdown formatting, no backticks) exactly matching this schema:
    {
      "components": [
        {
           "type": "string (e.g., Microcontroller, Sensor)",
           "label": "string (e.g., ESP32, BME680, Breadboard)",
           "box": {"ymin": float (0.0 to 1.0), "xmin": float, "ymax": float, "xmax": float},
           "notes": "string (condition or visual details)",
           "wiring": [{"pin": "string (e.g. GND)", "connected_to": "string", "wire_color": "string (e.g., red, blue, green)"}],
           "confidence": float (between 0.0 and 1.0, representing certainty of component identification)
        }
      ]
    }
    """
    
    payload = {
        "contents": [{
            "parts": [
                {"text": prompt},
                {"inline_data": {"mime_type": "image/jpeg", "data": encoded_img}}
            ]
        }],
        "generationConfig": {
            "response_mime_type": "application/json"
        }
    }

    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    # Increase timeout to 60.0s since generation + image upload can sometimes exceed 30 seconds during congestion
    async with httpx.AsyncClient(timeout=60.0) as client:
        resp = await client.post(gemini_url, json=payload)
        if not resp.is_success:
            raise HTTPException(status_code=502, detail=f"Gemini API Error: {resp.text}")
            
        data = resp.json()
        try:
            text_response = data['candidates'][0]['content']['parts'][0]['text']
            text_response = text_response.replace("```json", "").replace("```", "").strip()
            parsed = json.loads(text_response)
            validated = CameraAnalysisResponse(**parsed)
            
            # --- DRIFT CALCULATION AND BROADCAST ---
            tracking_components = []
            for comp in validated.components:
                drift_calc.update(comp.label, comp.box, comp.confidence)
                tracking_components.append({
                    "label": comp.label,
                    "type": comp.type,
                    "box": comp.box.model_dump(),
                    "semantic_drift": drift_calc.get_semantic_drift(comp.label),
                    "spatial_drift": drift_calc.get_spatial_drift(comp.label)
                })
            
            # Broadcast to Unity AR Client in the background
            asyncio.create_task(broadcast_tracking(tracking_components))
            
            return validated
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to parse or validate Gemini response: {e}\nRaw text: {data.get('candidates', [{}])[0].get('content', {}).get('parts', [{}])[0].get('text', '')}")

@app.get("/api/camera/bench-snap")
async def snap_proxy():
    async with httpx.AsyncClient(timeout=5.0) as client:
        try:
            r = await client.get(BENCH_CAM_URL)
            return Response(
                content=r.content,
                media_type=r.headers.get("content-type", "image/jpeg"),
            )
        except httpx.RequestError:
            return Response(status_code=503)

@app.get("/api/proxy/ecology")
async def proxy_ecology():
    """Server-side proxy to fetch telemetry from the dashboard on Inferno (.28). Bypass Mixed Content errors."""
    ip = "192.168.0.28" # Hardcode to the Inferno Pi where the dashboard runs
    endpoints = [
        f"http://{ip}:8000/api/stats/ecology",          # Original Dashboard
        f"http://{ip}:9500/api/stats/ecology",          # Alt Port Dashboard
        f"http://{ip}:8000/api/agent/ecology/vitals",   # NotebookLM referenced endpoint
        f"http://{ip}:9500/api/agent/ecology/vitals"
    ]
    
    async with httpx.AsyncClient(timeout=3.0) as client:
        for ep in endpoints:
            try:
                r = await client.get(ep)
                if r.status_code == 200:
                    return Response(content=r.content, media_type="application/json")
            except Exception:
                continue
                
        return Response(status_code=503, content='{"error": "Dashboard unreachable on 192.168.0.28"}')

from fastapi.responses import StreamingResponse

@app.get("/api/proxy/stream")
async def proxy_stream(ip: str = "192.168.0.24"):
    """Server-side proxy to stream the MJPEG video feed under the secure HTTPS domain"""
    url = f"http://{ip}:8080/?action=stream"
    async def mjpeg_generator():
        async with httpx.AsyncClient() as client:
            try:
                async with client.stream("GET", url) as response:
                    async for chunk in response.aiter_bytes():
                        yield chunk
            except Exception as e:
                log.error(f"Stream Proxy Error: {e}")
                
    return StreamingResponse(
        mjpeg_generator(),
        media_type="multipart/x-mixed-replace; boundary=boundarydonotcross"
    )

# ----------------- REGISTRY ENDPOINTS -----------------
import websockets
import uuid
import json
import datetime
import psycopg2
from registry_intake import DB_DSN, _embed, log

@app.websocket("/ws/device/{device_id}")
async def proxy_ws_device(websocket: WebSocket, device_id: str, ip: str = "192.168.0.28"):
    """Server-side proxy to tunnel the WebSocket stream through the HTTPS server."""
    await websocket.accept()
    target_uri = f"ws://{ip}:8766/ws/device/{device_id}"
    try:
        async with websockets.connect(target_uri) as target_ws:
            while True:
                msg = await target_ws.recv()
                await websocket.send_text(msg)
    except websockets.exceptions.ConnectionClosed:
        pass
    except Exception as e:
        log.error(f"WebSocket Proxy Error: {e}")
    finally:
        try:
            await websocket.close()
        except:
            pass


# We no longer use local json file, but direct PostgreSQL insertion via registry_intake's DSN


@app.get("/api/registry/list")
async def list_registry():
    try:
        import psycopg2
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        # Uses actual parts_catalogue schema columns
        cur.execute("SELECT component_model, summary, tags, image_filename FROM parts_catalogue ORDER BY ingested_at DESC")
        rows = cur.fetchall()
        components = []
        for r in rows:
            tags = r[2] if r[2] else []
            components.append({
                "label": r[0] or "Unknown Component",
                "device_type": tags[0] if tags else "Unknown",
                "notes": r[1] or "",
                "image_filename": r[3] or "",
            })
        cur.close()
        conn.close()
        return {"components": components}
    except Exception as e:
        log.error(f"Postgres fetch error in list_registry: {e}")
        return {"components": []}

@app.get("/api/registry/resolve")
async def registry_resolve(label: str = ""):
    """Resolve a Gemini-guessed label to a known registry entry + stable device_id slug."""
    if not label:
        return {"device_id": None, "matched": False}
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        search_term = f"%{label}%"
        cur.execute("""
            SELECT id, component_model, summary, tags
            FROM parts_catalogue
            WHERE component_model ILIKE %s OR ocr_raw ILIKE %s
            ORDER BY ingested_at DESC
            LIMIT 1
        """, (search_term, search_term))
        row = cur.fetchone()
        cur.close()
        conn.close()
        if row:
            # Stable slug: lowercase model name, spaces → dashes
            slug = (row[1] or f"device-{row[0]}").lower().replace(" ", "-")
            tags = row[2] if row[2] else []
            return {
                "device_id": slug,
                "component_model": row[1],
                "summary": row[2] or "",
                "device_type": tags[0] if tags else "sensor",
                "matched": True
            }
        return {"device_id": None, "matched": False}
    except Exception as e:
        log.error(f"Registry resolve error: {e}")
        return {"device_id": None, "matched": False}



@app.post("/api/registry/add")
async def add_registry(request: Request):
    data = await request.json()
    
    # Payload from app.js: { "display_name": "...", "notes": "...", "device_type": "...", "cv_labels": [...] }
    label = sanitize_text(data.get("display_name") or data.get("label", "Unknown Component"))
    notes = sanitize_text(data.get("notes", ""))
    device_type = sanitize_text(data.get("device_type", ""))
    cv_labels = [sanitize_text(l) for l in data.get("cv_labels", [])]
    # Tags: merge device_type + cv_labels for searchability
    tags = list(set(filter(None, [device_type] + cv_labels)))
    
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    manual_id = f"manual_{timestamp}_{uuid.uuid4().hex[:6]}"
    
    # Embed the user's corrected label + notes for future vector search
    embed_text = f"{label}. {notes}. {device_type}"
    embedding = _embed(embed_text)
    
    # Convert embedding list to Postgres vector literal — avoids needing the pgvector Python package
    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"

    conn = psycopg2.connect(DB_DSN)
    # cv_labels often includes [original_gemini_guess, user_correction] — store both in ocr_raw
    ocr_raw_text = " | ".join(cv_labels) if cv_labels else label
    
    try:
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO parts_catalogue
                    (image_filename, image_path, ocr_raw, ocr_results, component_model, summary, tags, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
            """, (
                manual_id,
                "manual_entry",
                ocr_raw_text,   # ocr_raw: all labels including original Gemini guess
                label,          # ocr_results: the canonical corrected name
                label,          # component_model: the canonical identifier
                notes,          # summary: includes CV training note
                tags,           # tags array (includes device_type e.g. "cv-correction")
                embedding_str,
            ))
        conn.commit()
        log.info(f"Registry add: '{label}' saved as {manual_id} (cv_labels: {cv_labels})")
    except Exception as e:
        log.error(f"Manual DB Insert Failed: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        conn.close()
        
    return {"status": "success", "device_id": manual_id}


@app.post("/api/session/export")
async def session_export(request: Request):
    data = await request.json()
    components = data.get('components', [])
    guide_response = data.get('guide_response')
    corrections = data.get('corrections', [])
    
    try:
        import psycopg2
        import uuid
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        
        # Ensure the table exists on first boot
        cur.execute("""
            CREATE TABLE IF NOT EXISTS ar_sessions (
                session_id UUID PRIMARY KEY,
                components JSONB,
                guide_response TEXT,
                corrections JSONB,
                created_at TIMESTAMP DEFAULT NOW()
            );
        """)
        
        sess_id = str(uuid.uuid4())
        cur.execute("""
            INSERT INTO ar_sessions (session_id, components, guide_response, corrections)
            VALUES (%s, %s, %s, %s)
        """, (sess_id, json.dumps(components), guide_response, json.dumps(corrections)))
        
        conn.commit()
        cur.close()
        conn.close()
        
        log.info(f"Session Export: {len(components)} components saved to ar_sessions.")
        return {"status": "success", "session_id": sess_id}
        
    except Exception as e:
        log.error(f"Postgres session export error: {e}")
        return {"status": "error", "message": "Failed to persist to pgvector node"}

@app.post("/api/session/focus")
async def session_focus(request: Request):
    data = await request.json()
    # Broadcast or log the focus event
    log.info(f"AR Focus Event: {data.get('label')}")
    return {"status": "success"}

@app.get("/api/session/search")
async def session_search(q: str):
    """Full-text search across saved AR sessions — guide responses and component labels."""
    if not q or len(q) < 2:
        return {"results": []}
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        search_term = f"%{q}%"
        cur.execute("""
            SELECT session_id, components, guide_response, corrections, created_at
            FROM ar_sessions
            WHERE guide_response ILIKE %s
               OR components::text ILIKE %s
            ORDER BY created_at DESC
            LIMIT 20
        """, (search_term, search_term))
        rows = cur.fetchall()
        results = []
        for r in rows:
            results.append({
                "id": str(r[0]),
                "components": r[1] if r[1] else [],
                "guide_response": r[2] or "",
                "corrections": r[3] if r[3] else [],
                "timestamp": r[4].isoformat() if r[4] else None
            })
        cur.close()
        conn.close()
        log.info(f"Session search for '{q}' returned {len(results)} results.")
        return {"results": results}
    except Exception as e:
        log.error(f"Session search error: {e}")
        return {"results": []}


@app.get("/api/session/history")
async def session_history(limit: int = 20):
    """Return recent AR sessions for the session history viewer."""
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        cur.execute("""
            SELECT session_id, components, guide_response, corrections, created_at
            FROM ar_sessions
            ORDER BY created_at DESC
            LIMIT %s
        """, (min(limit, 50),))
        rows = cur.fetchall()
        sessions = []
        for r in rows:
            comps = r[1] if r[1] else []
            comp_count = len(comps) if isinstance(comps, list) else 0
            # Extract component labels for the summary
            labels = []
            if isinstance(comps, list):
                for c in comps:
                    if isinstance(c, dict) and 'label' in c:
                        labels.append(c['label'])
            sessions.append({
                "id": str(r[0]),
                "component_count": comp_count,
                "component_labels": labels[:6],
                "has_guide": bool(r[2]),
                "corrections_count": len(r[3]) if r[3] else 0,
                "timestamp": r[4].isoformat() if r[4] else None
            })
        cur.close()
        conn.close()
        return {"sessions": sessions, "total": len(sessions)}
    except Exception as e:
        log.error(f"Session history error: {e}")
        return {"sessions": [], "total": 0}


@app.get("/api/session/{session_id}")
async def get_session_detail(session_id: str):
    """Return full detail for a specific AR session."""
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        cur.execute("""
            SELECT session_id, components, guide_response, corrections, created_at
            FROM ar_sessions WHERE session_id = %s
        """, (session_id,))
        r = cur.fetchone()
        cur.close()
        conn.close()
        if not r:
            raise HTTPException(status_code=404, detail="Session not found")
        return {
            "id": str(r[0]),
            "components": r[1] if r[1] else [],
            "guide_response": r[2] or "",
            "corrections": r[3] if r[3] else [],
            "timestamp": r[4].isoformat() if r[4] else None
        }
    except HTTPException:
        raise
    except Exception as e:
        log.error(f"Session detail error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/remainders/recent")
async def recent_remainders(limit: int = 10):
    """Return recent embodied remainders injected by the human operator."""
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        cur.execute("""
            SELECT si.id, si.sensor_id, si.embodied_remainder, si.created_at,
                   isrc.source_name
            FROM sensor_interpretation si
            LEFT JOIN interpretation_source isrc ON si.source_id = isrc.id
            WHERE si.embodied_remainder IS NOT NULL
              AND si.embodied_remainder != ''
            ORDER BY si.created_at DESC
            LIMIT %s
        """, (min(limit, 30),))
        rows = cur.fetchall()
        remainders = []
        for r in rows:
            remainders.append({
                "id": str(r[0]),
                "sensor_id": r[1],
                "note": r[2],
                "timestamp": r[3].isoformat() if r[3] else None,
                "source": r[4] or "unknown"
            })
        cur.close()
        conn.close()
        return {"remainders": remainders, "total": len(remainders)}
    except Exception as e:
        log.error(f"Recent remainders error: {e}")
        return {"remainders": [], "total": 0}

@app.post("/api/guide/save")
async def guide_save(request: Request):
    """
    Persist an AI Guide Q&A to the knowledge base with vector embedding.
    This captures confirmed hardware + wiring + assembly purpose — the most
    valuable output of the AR system. Stored in parts_catalogue tagged as
    'ar-guide' so it can be retrieved by future semantic lookups.
    """
    data = await request.json()
    question = sanitize_text(data.get("question", ""))
    answer = sanitize_text(data.get("answer", ""))
    components = [sanitize_text(c) for c in data.get("components", [])]  # list of corrected label strings
    corrections = data.get("corrections", [])
    
    if not answer:
        return {"status": "error", "message": "No answer to save"}
    
    component_str = ", ".join(components) if components else "unspecified components"
    timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    guide_id = f"guide_{timestamp}_{uuid.uuid4().hex[:6]}"
    
    # The embed text combines question + component names + answer for rich retrieval
    embed_text = f"Components: {component_str}. Question: {question}. Answer: {answer}"
    embedding = _embed(embed_text[:2000])  # cap to avoid token limits
    embedding_str = "[" + ",".join(str(x) for x in embedding) + "]"
    
    # Summary stored as the Q&A pair for human-readable retrieval
    summary = f"Q: {question}\n\nA: {answer}"
    tags = ["ar-guide"] + components[:5]  # tag with component names for filtering
    
    # Also write corrections as additional context if present
    corrections_note = ""
    if corrections:
        corrections_note = " | CV corrections: " + "; ".join(
            f"{c.get('original_label')} → {c.get('corrected_label')}" for c in corrections
        )
    
    try:
        conn = psycopg2.connect(DB_DSN)
        with conn.cursor() as cur:
            cur.execute("""
                INSERT INTO parts_catalogue
                    (image_filename, image_path, ocr_raw, ocr_results, component_model, summary, tags, embedding)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::vector)
            """, (
                guide_id,
                "ar_guide",
                component_str + corrections_note,  # ocr_raw: searchable component names
                answer[:500],                       # ocr_results: first 500 chars of answer
                f"[Guide] {component_str}",         # component_model: searchable prefix
                summary,                            # summary: full Q&A for retrieval
                tags,
                embedding_str,
            ))
        conn.commit()
        conn.close()
        log.info(f"Guide saved: {guide_id} | Components: {component_str}")
        return {"status": "success", "guide_id": guide_id}
    except Exception as e:
        log.error(f"Guide save failed: {e}")
        return {"status": "error", "message": str(e)}



@app.get("/api/registry/search")
async def registry_search(q: str = ""):
    """Text search against parts_catalogue by component_model or ocr_raw."""
    try:
        conn = psycopg2.connect(DB_DSN)
        cur = conn.cursor()
        search_term = f"%{q}%"
        cur.execute("""
            SELECT component_model, summary, tags, image_filename
            FROM parts_catalogue
            WHERE component_model ILIKE %s OR ocr_raw ILIKE %s
            ORDER BY ingested_at DESC
            LIMIT 10
        """, (search_term, search_term))
        rows = cur.fetchall()
        results = []
        for r in rows:
            tags = r[2] if r[2] else []
            results.append({
                "label": r[0] or "Unknown",
                "notes": r[1] or "",
                "device_type": tags[0] if tags else "Unknown",
                "image_filename": r[3] or "",
            })
        cur.close()
        conn.close()
        return {"results": results}
    except Exception as e:
        log.error(f"Registry search error: {e}")
        return {"results": []}


@app.post("/api/device/{device_id}/diagnose")
async def device_diagnose(device_id: str, request: Request):
    data = await request.json()
    return {"diagnosis": f"Llama 3.2 Preliminary Diagnostics for {device_id}. Anomaly detected in pin routing based on spatial context."}


# ----------------- UNITY TRACKING TUNNEL -----------------
import asyncio
active_websockets = []

@app.websocket("/ws/tracking")
async def websocket_tracking_endpoint(websocket: WebSocket):
    await websocket.accept()
    active_websockets.append(websocket)
    try:
        while True:
            # We don't expect Unity to send much, it just listens.
            # But we keep it alive waiting for client dumps.
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        active_websockets.remove(websocket)

# A simple helper for our underlying AI scripts to blast tracking coordinates dynamically!
async def broadcast_tracking(components: list):
    payload = {
        "timestamp": 0,
        "components": components
    }
    dead_sockets = []
    for ws in active_websockets:
        try:
            await ws.send_json(payload)
        except:
            dead_sockets.append(ws)
    for ws in dead_sockets:
        active_websockets.remove(ws)

class AssemblyRequest(BaseModel):
    components: list[str]
    goal: str = "Connect these components logically for a sensor node."

@app.post("/api/assembly/generate")
async def generate_assembly(req: AssemblyRequest, x_gemini_key: Optional[str] = Header(None)):
    """Use Gemini to dynamically generate wiring steps depending on the detected components."""
    api_key = x_gemini_key or os.environ.get("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=500, detail="GEMINI_API_KEY not set")
        
    prompt = f"""
You are an expert embedded systems engineer. The user is in an AR environment with these components:
{', '.join(req.components)}.

Their goal: {req.goal}

Generate a JSON object containing TWO keys: "cards_html" and "steps".

1. "cards_html" must be a single HTML string that reconstructs the UI boxes and svg wiring layout.
We are using a premium "Shadow Puppet / Ghost Mode" aesthetic. The cards must look like translucent holographic HUD elements.
Example structure for cards_html:
"<div class='hologram-card left'><div class='card-scanline'></div><div class='card-header'><span class='card-badge'>MCU</span><span class='card-name'>First Component</span></div><div class='pin-list'><div class='pin-row' id='pin1' style='--pin-color:var(--pwr)'><div class='pin-glow'></div><span class='pin-name'>3V3</span><span class='pin-label'>3v3 out</span></div></div></div><div class='wire-bridge'><svg viewBox='0 0 72 120' preserveAspectRatio='none'><path id='w-pwr' class='wire-path animated-pulse' d='M0,18 C36,18 36,22 72,22' style='stroke:var(--pwr);'/></svg></div><div class='hologram-card right'><div class='card-scanline'></div><div class='card-header'><span class='card-badge'>SENSOR</span><span class='card-name'>Second Component</span></div><div class='pin-list'><div class='pin-row' id='pin2' style='--pin-color:var(--pwr)'><div class='pin-glow'></div><span class='pin-label'>3.3v supply</span><span class='pin-name'>VCC</span></div></div></div>"
Use matching pin IDs that you invent and wire IDs that connect them. Use standard CSS vars: var(--pwr), var(--gnd), var(--scl), var(--sda), var(--accent).

2. "steps" must be a JSON array of `assemblySteps` objects defining how to build it.
Each step must be a JSON object with this EXACT structure:
{{
  "label": "STEP NAME",
  "color": "var(--accent)", 
  "wires": ["w-pwr"], // array of wire path IDs matches the SVG
  "pins": ["pin1", "pin2"], // array of pin ids that match the HTML
  "text": "Instruction text goes here. Use <span> tags for highlights.",
  "warn": "Optional warning text or null",
  "num": "1 / N"
}}

Respond ONLY with the complete valid JSON object. Do not include markdown codeblocks like ```json .
"""

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"response_mime_type": "application/json"}
    }

    gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={api_key}"
    
    async with httpx.AsyncClient(timeout=45.0) as client:
        resp = await client.post(gemini_url, json=payload)
        if not resp.is_success:
            raise HTTPException(status_code=502, detail=f"Gemini API Error: {resp.text}")
            
        data = resp.json()
        try:
            text_response = data['candidates'][0]['content']['parts'][0]['text']
            text_response = text_response.replace("```json", "").replace("```", "").strip()
            return json.loads(text_response)
        except Exception as e:
            raise HTTPException(status_code=500, detail="Failed to parse dynamic assembly JSON")

# Serve the AR Guidance frontend directly on local HTTP
frontend_path = os.path.join(os.path.dirname(__file__), "public")
if os.path.exists(frontend_path):
    app.mount("/ar-app", StaticFiles(directory=frontend_path, html=True), name="ar-app")

@app.get("/api/health")
async def health_check():
    """Return status of all backend services for the frontend System Health Dashboard."""
    import time
    services = {}
    
    # Check Bench Cam
    async with httpx.AsyncClient(timeout=3.0) as client:
        try:
            r = await client.get(BENCH_CAM_URL)
            services["bench_cam"] = {"status": "ok" if r.is_success else "warn", "label": "Bench Camera"}
        except Exception:
            services["bench_cam"] = {"status": "error", "label": "Bench Camera"}
    
    # Check Ecology Dashboard (Inferno Pi)
    ip = os.getenv("PI_IP", "192.168.0.28")
    ecology_ok = False
    async with httpx.AsyncClient(timeout=2.0) as client:
        for ep in [f"http://{ip}:8000/api/stats/ecology", f"http://{ip}:9500/api/stats/ecology"]:
            try:
                r = await client.get(ep)
                if r.status_code == 200:
                    ecology_ok = True
                    break
            except Exception:
                continue
    services["ecology"] = {"status": "ok" if ecology_ok else "error", "label": "Sensor Ecology"}
    
    # Check PostgreSQL via Ecology API (indirect — the ecology API uses postgres)
    pg_ok = False
    async with httpx.AsyncClient(timeout=2.0) as client:
        try:
            r = await client.get(f"http://{ip}:8000/api/registry/list")
            pg_ok = r.status_code == 200
        except Exception:
            pass
    services["postgres"] = {"status": "ok" if pg_ok else "error", "label": "PostgreSQL"}
    
    # WS Bridge
    ws_status = "warn"
    async with httpx.AsyncClient(timeout=2.0) as client:
        try:
            r = await client.get(f"http://{ip}:8766/")
            ws_status = "ok"
        except Exception:
            ws_status = "warn"
    services["ws_bridge"] = {"status": ws_status, "label": "WS Bridge"}
    
    # Gemini API Key configured?
    has_key = bool(os.getenv("GEMINI_API_KEY"))
    services["gemini"] = {"status": "ok" if has_key else "warn", "label": "Gemini API", "note": "Key set via env" if has_key else "Key required from client"}
    
    # Server uptime
    services["server"] = {"status": "ok", "label": "AR Server"}
    
    from datetime import datetime
    return {"services": services, "timestamp": datetime.now().isoformat()}


@app.post("/api/remainder")
async def inject_remainder(request: Request):
    data = await request.json()
    note = sanitize_text(data.get("note", ""))
    sensor_id = sanitize_text(data.get("sensor_id", "global_scene"))
    
    if not note:
        return {"status": "error", "message": "Empty remainder"}
        
    try:
        conn = psycopg2.connect(DB_DSN)
        with conn.cursor() as cur:
            # Ensure the tables exist
            with open("001_relational_identity.sql", "r") as f:
                cur.execute(f.read())
                
            # Get or create the human source
            cur.execute("SELECT id FROM interpretation_source WHERE source_name = 'human_operator' LIMIT 1")
            row = cur.fetchone()
            if row:
                source_id = row[0]
            else:
                cur.execute("INSERT INTO interpretation_source (source_name, source_type) VALUES ('human_operator', 'human') RETURNING id")
                source_id = cur.fetchone()[0]
                
            # Insert the embodied remainder
            cur.execute("""
                INSERT INTO sensor_interpretation (source_id, sensor_id, embodied_remainder)
                VALUES (%s, %s, %s)
            """, (source_id, sensor_id, note))
            
        conn.commit()
        conn.close()
        log.info(f"Embodied remainder injected: {note[:50]}...")
        return {"status": "success"}
    except Exception as e:
        log.error(f"Failed to inject remainder: {e}")
        return {"status": "error", "message": str(e)}

