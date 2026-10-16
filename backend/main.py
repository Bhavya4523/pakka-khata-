"""Pakka Khata API: stateless, no database, no sessions, no user-data storage."""
from __future__ import annotations

import asyncio
import logging
import mimetypes
import time
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.cors import CORSMiddleware
from starlette.middleware.gzip import GZipMiddleware

from backend.config import Settings
from backend.multipart_memory import MultipartError, get_upload_parts, parse_multipart, read_bounded_body
from backend.provider import ProviderError, get_provider
from backend.rate_limit import InMemoryRateLimiter, RateLimitExceeded
from backend.sample_data import sample_extraction
from backend.schemas import HealthResponse, ReminderRequest, ReminderResponse, ScanResponse
from backend.service import InvalidModelOutput, draft_reminder, scan_ledger

logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
logger = logging.getLogger("pakka_khata.request_metadata")
_DEVELOPMENT_MODE = Settings.from_env().app_env == "development"
app = FastAPI(
    title="Pakka Khata",
    version="0.1.0",
    docs_url="/docs" if _DEVELOPMENT_MODE else None,
    redoc_url="/redoc" if _DEVELOPMENT_MODE else None,
    openapi_url="/openapi.json" if _DEVELOPMENT_MODE else None,
)
app.add_middleware(GZipMiddleware, minimum_size=1000)
if Settings.from_env().app_env == "development":
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_credentials=False,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Content-Type"],
    )

limiter = InMemoryRateLimiter(limit=Settings.from_env().rate_limit_per_hour)
MAX_MULTIPART_OVERHEAD = 128 * 1024


@app.middleware("http")
async def security_and_metadata_middleware(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    elapsed_ms = (time.perf_counter() - started) * 1000
    # Request metadata only. Never log request bodies, query values, images, or ledger fields.
    logger.info("%s %s %d %.1fms", request.method, request.url.path, response.status_code, elapsed_ms)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Permissions-Policy"] = "camera=(self), microphone=(), geolocation=()"
    # Swagger UI uses inline initialization and jsDelivr only in local development.
    if _DEVELOPMENT_MODE and request.url.path in {"/docs", "/redoc"}:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; "
            "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; "
            "img-src 'self' data:; "
            "font-src 'self' data: https://cdn.jsdelivr.net; "
            "connect-src 'self'; worker-src 'self' blob:; "
            "object-src 'none'; base-uri 'self'; "
            "form-action 'self'; frame-ancestors 'none'"
        )
    else:
        response.headers["Content-Security-Policy"] = (
            "default-src 'self'; script-src 'self'; style-src 'self'; "
            "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
            "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; "
            "form-action 'self'; frame-ancestors 'none'"
        )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


@app.exception_handler(MultipartError)
async def multipart_error_handler(_request: Request, exc: MultipartError):
    return JSONResponse(status_code=exc.status_code, content={"detail": str(exc)})


@app.exception_handler(RateLimitExceeded)
async def rate_limit_error_handler(_request: Request, exc: RateLimitExceeded):
    return JSONResponse(
        status_code=429,
        content={"detail": "You've tried several scans in a short time. Please wait before trying again."},
        headers={"Retry-After": str(exc.retry_after)},
    )


@app.exception_handler(ProviderError)
async def provider_error_handler(_request: Request, exc: ProviderError):
    return JSONResponse(status_code=503, content={"detail": str(exc)})


@app.exception_handler(InvalidModelOutput)
async def invalid_model_handler(_request: Request, exc: InvalidModelOutput):
    return JSONResponse(status_code=502, content={"detail": str(exc)})


@app.exception_handler(RequestValidationError)
async def request_validation_handler(_request: Request, exc: RequestValidationError):
    return JSONResponse(status_code=422, content={"detail": "Please check the information and try again."})


def identify_image(payload: bytes, declared_type: str | None) -> tuple[str, str]:
    """Validate image magic bytes and return its trusted MIME type and extension."""
    if not payload:
        raise MultipartError("The photo is empty. Choose another image.", 400)
    if payload.startswith(b"\xff\xd8\xff"):
        mime, extension = "image/jpeg", ".jpg"
    elif payload.startswith(b"\x89PNG\r\n\x1a\n"):
        mime, extension = "image/png", ".png"
    elif len(payload) >= 12 and payload[:4] == b"RIFF" and payload[8:12] == b"WEBP":
        mime, extension = "image/webp", ".webp"
    else:
        raise MultipartError("This photo type isn't supported. Choose a JPEG, PNG, or WebP image.", 415)
    if declared_type and declared_type not in {mime, "application/octet-stream"}:
        raise MultipartError("The file type does not match the photo contents. Choose the original image.", 415)
    return mime, extension


@app.get("/api/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    settings = Settings.from_env()
    provider = get_provider(settings)
    reachable = await provider.reachable()
    return HealthResponse(
        status="ok" if reachable or settings.demo_mode else "degraded",
        provider=settings.llm_provider,
        model=settings.model_name,
        model_reachable=reachable,
        demo_mode=settings.demo_mode,
    )


@app.post(
    "/api/scan",
    response_model=ScanResponse,
    openapi_extra={
        "requestBody": {
            "required": True,
            "content": {
                "multipart/form-data": {
                    "schema": {
                        "type": "object",
                        "required": ["image"],
                        "properties": {
                            "image": {
                                "type": "string",
                                "format": "binary",
                                "description": "Khata page photo (JPEG, PNG, or WebP; max 8 MB).",
                            },
                            "language_hint": {
                                "type": "string",
                                "description": "Optional language hint for the handwriting.",
                            },
                        },
                    },
                },
            },
        },
    },
)
async def scan(request: Request) -> ScanResponse:
    settings = Settings.from_env()
    client_ip = request.client.host if request.client else "unknown"
    limiter.limit = settings.rate_limit_per_hour
    limiter.check(client_ip)
    max_file_bytes = settings.max_upload_mb * 1024 * 1024
    body = await read_bounded_body(request, max_file_bytes + MAX_MULTIPART_OVERHEAD)
    parts = parse_multipart(request.headers.get("content-type", ""), body)
    image_part, language_hint = get_upload_parts(parts)
    if len(image_part.payload) > max_file_bytes:
        raise MultipartError(f"Keep each photo under {settings.max_upload_mb} MB.", 413)
    mime_type, _extension = identify_image(image_part.payload, image_part.content_type)
    # Demo mode intentionally ignores image content and clearly labels the sample result.
    # The bytes remain in memory only and are discarded when this request returns.
    if settings.demo_mode:
        return sample_extraction()
    return await scan_ledger(get_provider(settings), image_part.payload, mime_type, language_hint)


@app.post("/api/reminder", response_model=ReminderResponse)
async def reminder(payload: ReminderRequest) -> ReminderResponse:
    settings = Settings.from_env()
    if settings.demo_mode:
        # A safe, clearly generic local draft keeps the demo useful without a reachable model.
        amount = _format_amount(payload.amount_due)
        messages = {
            "english": f"Hello {payload.customer_name}, a gentle reminder from {payload.shop_name} about the pending amount of {amount}. Whenever convenient, please let us know. Thank you!",
            "hindi": f"नमस्ते {payload.customer_name} जी, {payload.shop_name} की ओर से {amount} की बाकी राशि के लिए विनम्र याद दिला रहे हैं। सुविधा होने पर कृपया बता दें। धन्यवाद! 🙏",
            "marathi": f"नमस्कार {payload.customer_name}, {payload.shop_name} कडून {amount} बाकी रकमेची नम्र आठवण. सोयीने कृपया कळवा. धन्यवाद! 🙏",
            "hinglish": f"Namaste {payload.customer_name} ji, {payload.shop_name} ki taraf se {amount} pending amount ki ek gentle reminder. Aapko jab convenient ho tab bata dijiyega. Thank you! 🙏",
        }
        return ReminderResponse(message=messages[payload.language])
    return await draft_reminder(get_provider(settings), payload)


def _format_amount(value: float) -> str:
    from backend.service import indian_rupees
    return indian_rupees(value)


# The phase-1 placeholder UI is built into the image. API routes are registered above
# this catch-all, and every unknown frontend route falls back to index.html for the SPA.
PROJECT_ROOT = Path(__file__).resolve().parents[1]
FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
ASSETS_DIR = FRONTEND_DIST / "assets"
if ASSETS_DIR.is_dir():
    app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/{full_path:path}", include_in_schema=False)
async def frontend_fallback(full_path: str = ""):
    if full_path == "api" or full_path.startswith("api/"):
        return JSONResponse(status_code=404, content={"detail": "API route not found."})
    if not FRONTEND_DIST.is_dir():
        return JSONResponse(
            status_code=200,
            content={"name": "Pakka Khata", "message": "Frontend build not found; API is available at /api/health."},
        )
    candidate = (FRONTEND_DIST / full_path).resolve()
    try:
        candidate.relative_to(FRONTEND_DIST.resolve())
    except ValueError:
        return JSONResponse(status_code=404, content={"detail": "Not found."})
    if full_path and candidate.is_file():
        return FileResponse(candidate, media_type=mimetypes.guess_type(candidate.name)[0])
    return FileResponse(FRONTEND_DIST / "index.html", media_type="text/html")
