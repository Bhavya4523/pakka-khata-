"""Minimal multipart/form-data parser that never spools uploaded files to disk.

Unlike UploadFile/Starlette's multipart parser, this reads a bounded ASGI request body
into memory, then extracts the parts using Python's email parser. The total body cap is
slightly larger than the configured file cap to allow multipart headers.
"""
from __future__ import annotations

from dataclasses import dataclass
from email import policy
from email.parser import BytesParser

from fastapi import Request
from fastapi.responses import JSONResponse


MAX_MULTIPART_OVERHEAD = 128 * 1024


class MultipartError(ValueError):
    def __init__(self, message: str, status_code: int = 400) -> None:
        self.status_code = status_code
        super().__init__(message)


@dataclass(frozen=True)
class MemoryPart:
    name: str
    payload: bytes
    content_type: str | None = None
    filename: str | None = None


async def read_bounded_body(request: Request, max_bytes: int) -> bytes:
    length = request.headers.get("content-length")
    if length:
        try:
            declared_length = int(length)
        except ValueError as exc:
            raise MultipartError("Invalid Content-Length header.", 400) from exc
        if declared_length > max_bytes:
            raise MultipartError("The uploaded request is too large. Choose a smaller photo.", 413)
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise MultipartError("The uploaded request is too large. Choose a smaller photo.", 413)
        chunks.append(chunk)
    return b"".join(chunks)


def parse_multipart(content_type: str, body: bytes) -> list[MemoryPart]:
    if "multipart/form-data" not in content_type.lower():
        raise MultipartError("Send the photo as a multipart file upload.", 415)
    try:
        message = BytesParser(policy=policy.default).parsebytes(
            f"MIME-Version: 1.0\r\nContent-Type: {content_type}\r\n\r\n".encode("utf-8") + body
        )
    except Exception as exc:
        raise MultipartError("The upload could not be read. Please choose the photo again.") from exc
    if not message.is_multipart():
        raise MultipartError("The upload form is malformed.")
    parts: list[MemoryPart] = []
    for part in message.iter_parts():
        if part.get_content_disposition() != "form-data":
            continue
        name = part.get_param("name", header="content-disposition")
        if not isinstance(name, str):
            continue
        payload = part.get_payload(decode=True)
        if payload is None:
            payload = b""
        parts.append(
            MemoryPart(
                name=name,
                payload=payload,
                content_type=part.get_content_type(),
                filename=part.get_filename(),
            )
        )
    return parts


def get_upload_parts(parts: list[MemoryPart]) -> tuple[MemoryPart, str | None]:
    images = [part for part in parts if part.name == "image"]
    if len(images) != 1:
        raise MultipartError("Choose one ledger photo to read.")
    language_fields = [part for part in parts if part.name == "language_hint"]
    language_hint = None
    if language_fields:
        try:
            language_hint = language_fields[0].payload.decode("utf-8", errors="replace").strip() or None
        except Exception:
            language_hint = None
    if language_hint and len(language_hint) > 40:
        raise MultipartError("Language hint is too long.")
    return images[0], language_hint
