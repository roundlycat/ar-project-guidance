"""
camera_analysis.py — add to your existing Inferno FastAPI app

Grabs a snap from the Pi Zero overhead cam, sends it to Gemini with a
structured prompt, and returns a component list with normalised bounding
boxes. The AR app uses this to render SVG wireframes without ever touching
the raw image.

Drop this file alongside your main app.py and include it with:
    from camera_analysis import router as camera_router
    app.include_router(camera_router)
"""

import base64
import logging
from typing import Optional
import httpx
import google.generativeai as genai
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter(prefix="/api/camera", tags=["camera"])

# ── Config ────────────────────────────────────────────────────────────────────
BENCH_CAM_URL   = "http://192.168.0.24:8080/snap"
GEMINI_MODEL    = "gemini-1.5-flash"          # fast enough for polling
SNAP_TIMEOUT    = 5.0                          # seconds
GEMINI_TIMEOUT  = 20.0

# ── Pydantic response schema ───────────────────────────────────────────────────
class BBox(BaseModel):
    x: float   # 0–1, fraction of image width from left
    y: float   # 0–1, fraction of image height from top
    w: float   # 0–1, fraction of image width
    h: float   # 0–1, fraction of image height

class Connection(BaseModel):
    to_id: str
    label: Optional[str] = None    # e.g. "GPIO 4", "I2C", "USB"
    wire_colour: Optional[str] = None

class Component(BaseModel):
    id: str                        # short stable slug, e.g. "u1", "sensor_bme"
    type: str                      # canonical type, e.g. "raspberry_pi_5"
    label: str                     # human label, e.g. "Inferno"
    bbox: BBox
    connections: list[Connection] = []
    notes: Optional[str] = None    # anything Gemini wants to flag

class SceneAnalysis(BaseModel):
    components: list[Component]
    image_w_px: Optional[int] = None   # actual pixel dims if Gemini can read them
    image_h_px: Optional[int] = None
    confidence: Optional[str] = None   # "high" | "medium" | "low"
    raw_notes: Optional[str] = None    # free-form Gemini commentary

# ── Gemini prompt ─────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """
You are an electronics bench analysis assistant. You will receive an overhead
photograph of an electronics workbench taken by a fixed camera. Your task is to
identify all visible electronic components, modules, and boards, and return a
structured JSON description of the scene.

For EACH component:
- Assign a short stable id (e.g. "rpi5_1", "bme688", "breadboard_a")
- Identify the type as specifically as possible
- Provide a human-readable label
- Provide a bounding box as fractions of the image dimensions (0.0–1.0):
    x, y = top-left corner; w, h = width and height
- List visible wire connections to other identified components, with wire
  colour and connection label (e.g. GPIO pin, I2C, USB) where readable
- Add a notes field for anything unusual, uncertain, or worth flagging

Return ONLY valid JSON matching this schema — no markdown fences, no preamble:

{
  "components": [
    {
      "id": "string",
      "type": "string",
      "label": "string",
      "bbox": { "x": 0.0, "y": 0.0, "w": 0.0, "h": 0.0 },
      "connections": [
        { "to_id": "string", "label": "string", "wire_colour": "string" }
      ],
      "notes": "string or null"
    }
  ],
  "image_w_px": null,
  "image_h_px": null,
  "confidence": "high | medium | low",
  "raw_notes": "string or null"
}
"""

# ── Helpers ───────────────────────────────────────────────────────────────────
async def _grab_snap() -> bytes:
    """Fetch a JPEG frame from the Pi Zero bench cam."""
    async with httpx.AsyncClient(timeout=SNAP_TIMEOUT) as client:
        try:
            r = await client.get(BENCH_CAM_URL)
            r.raise_for_status()
            return r.content
        except httpx.RequestError as e:
            raise HTTPException(status_code=503, detail=f"Bench cam unreachable: {e}")
        except httpx.HTTPStatusError as e:
            raise HTTPException(status_code=502, detail=f"Bench cam error: {e.response.status_code}")


async def _analyse_with_gemini(image_bytes: bytes) -> SceneAnalysis:
    """Send image to Gemini, parse structured JSON response."""
    b64 = base64.b64encode(image_bytes).decode()

    model = genai.GenerativeModel(GEMINI_MODEL)

    try:
        response = model.generate_content(
            contents=[
                SYSTEM_PROMPT,
                {
                    "mime_type": "image/jpeg",
                    "data": b64,
                },
            ],
            generation_config=genai.GenerationConfig(
                temperature=0.1,          # low temp for structured output
                response_mime_type="application/json",
            ),
        )
    except Exception as e:
        log.error("Gemini request failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Gemini error: {e}")

    raw = response.text.strip()

    try:
        return SceneAnalysis.model_validate_json(raw)
    except Exception as e:
        log.error("Failed to parse Gemini response: %s\nRaw: %s", e, raw[:500])
        raise HTTPException(status_code=502, detail="Gemini returned unparseable JSON")


# ── Endpoints ─────────────────────────────────────────────────────────────────
from fastapi import Header

@router.get("/analyse", response_model=SceneAnalysis)
async def analyse_bench(x_gemini_key: Optional[str] = Header(None)):
    """
    Grab a bench cam snap, run Gemini vision analysis, return component list.
    The AR app calls this to build its wireframe overlay.
    """
    if x_gemini_key:
        genai.configure(api_key=x_gemini_key)
        
    image_bytes = await _grab_snap()
    return await _analyse_with_gemini(image_bytes)


@router.get("/snap-proxy")
async def snap_proxy():
    """
    Simple image proxy for debugging — lets you verify the cam is reachable
    from Inferno without CORS issues. Not used by the AR app in production.
    """
    from fastapi.responses import Response
    image_bytes = await _grab_snap()
    return Response(content=image_bytes, media_type="image/jpeg")
