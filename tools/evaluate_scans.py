#!/usr/bin/env python3
"""Evaluate local Pakka Khata scan accuracy and latency against a labelled manifest.

The report contains aggregate metrics only; it never writes image bytes or extracted
customer/ledger text to the report. Expected rows must be listed in the same order as
the source page. Use real labelled photos and DEMO_MODE=false for meaningful results.
"""
from __future__ import annotations

import argparse
import json
import math
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

DEFAULT_FIELDS = ("date", "items", "amount", "type", "customer_name")


def normalize_text(value: Any) -> str:
    return " ".join(str(value or "").casefold().split())


def amount_matches(expected: Any, actual: Any, tolerance: float) -> bool:
    try:
        expected_number = float(expected)
        actual_number = float(actual)
    except (TypeError, ValueError):
        return False
    return math.isfinite(expected_number) and math.isfinite(actual_number) and abs(expected_number - actual_number) <= tolerance


def field_matches(field: str, expected: Any, actual: Any, amount_tolerance: float) -> bool:
    if field == "amount":
        return amount_matches(expected, actual, amount_tolerance)
    if expected is None:
        return actual is None
    if field == "date":
        return str(expected) == str(actual) if actual is not None else False
    return normalize_text(expected) == normalize_text(actual)


def percentile(values: list[float], p: float) -> float | None:
    """Linear-interpolated percentile, with p expressed from 0 through 100."""
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * (p / 100.0)
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def score_rows(expected_rows: list[dict[str, Any]], actual_rows: list[dict[str, Any]], amount_tolerance: float) -> dict[str, Any]:
    """Compare rows in source order and only score fields provided in ground truth."""
    field_correct = {field: 0 for field in DEFAULT_FIELDS}
    field_total = {field: 0 for field in DEFAULT_FIELDS}
    exact_rows = 0

    for index, expected in enumerate(expected_rows):
        actual = actual_rows[index] if index < len(actual_rows) else {}
        row_correct = True
        for field in DEFAULT_FIELDS:
            if field not in expected:
                continue
            field_total[field] += 1
            matches = field_matches(field, expected[field], actual.get(field), amount_tolerance)
            if matches:
                field_correct[field] += 1
            else:
                row_correct = False
        if row_correct and any(field in expected for field in DEFAULT_FIELDS):
            exact_rows += 1

    metrics: dict[str, Any] = {
        "expected_rows": len(expected_rows),
        "predicted_rows": len(actual_rows),
        "row_count_exact": len(expected_rows) == len(actual_rows),
        "expected_rows_exact_match": exact_rows,
        "row_exact_accuracy": exact_rows / len(expected_rows) if expected_rows else None,
        "extra_rows": max(0, len(actual_rows) - len(expected_rows)),
        "missing_rows": max(0, len(expected_rows) - len(actual_rows)),
        "field_accuracy": {},
        "field_correct": field_correct,
        "field_total": field_total,
    }
    all_correct = sum(field_correct.values())
    all_total = sum(field_total.values())
    for field in DEFAULT_FIELDS:
        metrics["field_accuracy"][field] = (
            field_correct[field] / field_total[field] if field_total[field] else None
        )
    metrics["field_accuracy"]["overall"] = all_correct / all_total if all_total else None
    return metrics


def load_manifest(path: Path) -> list[dict[str, Any]]:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise ValueError(f"Could not read manifest JSON: {exc.__class__.__name__}") from exc
    cases = data.get("cases") if isinstance(data, dict) else None
    if not isinstance(cases, list) or not cases:
        raise ValueError("Manifest must be an object with a non-empty 'cases' array.")
    seen_ids: set[str] = set()
    for idx, case in enumerate(cases):
        if not isinstance(case, dict):
            raise ValueError(f"Case {idx + 1} must be an object.")
        case_id = case.get("id")
        image = case.get("image")
        expected = case.get("expected")
        if not isinstance(case_id, str) or not case_id.strip() or case_id in seen_ids:
            raise ValueError(f"Case {idx + 1} needs a unique non-empty id.")
        if not isinstance(image, str) or not image.strip():
            raise ValueError(f"Case {case_id} needs an image path.")
        if not isinstance(expected, dict) or not isinstance(expected.get("rows"), list):
            raise ValueError(f"Case {case_id} needs expected.rows as an array.")
        if not expected["rows"]:
            raise ValueError(f"Case {case_id} must contain at least one expected transaction row.")
        if any(not isinstance(row, dict) for row in expected["rows"]):
            raise ValueError(f"Case {case_id} has a non-object expected row.")
        if not any(any(field in row for field in DEFAULT_FIELDS) for row in expected["rows"]):
            raise ValueError(f"Case {case_id} has no scored fields.")
        seen_ids.add(case_id)
    return cases


def evaluate(args: argparse.Namespace) -> dict[str, Any]:
    manifest_path = args.manifest.resolve()
    cases = load_manifest(manifest_path)
    measurements: list[float] = []
    case_results: list[dict[str, Any]] = []
    total_expected = total_predicted = total_exact_rows = 0
    total_field_correct = total_field_expected = 0
    all_field_correct = {field: 0 for field in DEFAULT_FIELDS}
    all_field_expected = {field: 0 for field in DEFAULT_FIELDS}
    demo_responses = 0
    api_errors = 0

    with httpx.Client(timeout=args.timeout) as client:
        for case in cases:
            image_path = (manifest_path.parent / case["image"]).resolve()
            if not image_path.is_file():
                raise ValueError(f"Image file is missing for case {case['id']}: {image_path}")
            case_latencies: list[float] = []
            last_metrics: dict[str, Any] | None = None
            status_codes: list[int] = []
            for _run in range(args.runs):
                started = time.perf_counter()
                try:
                    with image_path.open("rb") as image_file:
                        response = client.post(
                            f"{args.base_url.rstrip('/')}/api/scan",
                            files={"image": (image_path.name, image_file, _mime_for(image_path))},
                            data={"language_hint": case.get("language_hint", "")},
                            headers={"Cache-Control": "no-store"},
                        )
                except httpx.HTTPError as exc:
                    api_errors += 1
                    status_codes.append(0)
                    continue
                elapsed = (time.perf_counter() - started) * 1000.0
                case_latencies.append(elapsed)
                measurements.append(elapsed)
                status_codes.append(response.status_code)
                if response.status_code != 200:
                    api_errors += 1
                    continue
                try:
                    payload = response.json()
                except ValueError:
                    api_errors += 1
                    continue
                if payload.get("demo") is True:
                    demo_responses += 1
                    continue
                predicted_rows = payload.get("rows")
                if not isinstance(predicted_rows, list):
                    api_errors += 1
                    continue
                last_metrics = score_rows(case["expected"]["rows"], predicted_rows, args.amount_tolerance)

            metrics = last_metrics or {
                "expected_rows": len(case["expected"]["rows"]), "predicted_rows": None,
                "row_count_exact": False, "expected_rows_exact_match": 0,
                "row_exact_accuracy": None, "extra_rows": None, "missing_rows": None,
                "field_accuracy": {}, "field_correct": {}, "field_total": {},
            }
            total_expected += len(case["expected"]["rows"])
            if metrics["predicted_rows"] is not None:
                total_predicted += metrics["predicted_rows"]
                total_exact_rows += metrics["expected_rows_exact_match"]
            for field in DEFAULT_FIELDS:
                all_field_correct[field] += metrics.get("field_correct", {}).get(field, 0)
                all_field_expected[field] += metrics.get("field_total", {}).get(field, 0)
            total_field_correct += sum(metrics.get("field_correct", {}).values())
            total_field_expected += sum(metrics.get("field_total", {}).values())
            case_results.append({
                "id": case["id"],
                "runs_requested": args.runs,
                "runs_completed": len(case_latencies),
                "status_codes": status_codes,
                "latency_ms": {
                    "median": statistics.median(case_latencies) if case_latencies else None,
                    "p90": percentile(case_latencies, 90),
                    "min": min(case_latencies) if case_latencies else None,
                    "max": max(case_latencies) if case_latencies else None,
                },
                "accuracy_from_last_successful_run": metrics,
            })

    field_accuracy = {
        field: all_field_correct[field] / all_field_expected[field] if all_field_expected[field] else None
        for field in DEFAULT_FIELDS
    }
    field_accuracy["overall"] = total_field_correct / total_field_expected if total_field_expected else None
    summary = {
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "endpoint": f"{args.base_url.rstrip('/')}/api/scan",
        "runs_per_case": args.runs,
        "amount_tolerance_rupees": args.amount_tolerance,
        "demo_responses_rejected_from_accuracy": demo_responses,
        "api_errors_or_non_200": api_errors,
        "case_count": len(cases),
        "total_expected_rows": total_expected,
        "total_predicted_rows_last_successful_run_per_case": total_predicted,
        "row_exact_accuracy": total_exact_rows / total_expected if total_expected else None,
        "field_accuracy": field_accuracy,
        "field_correct": all_field_correct,
        "field_total": all_field_expected,
        "latency_ms_all_successful_requests": {
            "count": len(measurements),
            "median": statistics.median(measurements) if measurements else None,
            "p50": percentile(measurements, 50),
            "p90": percentile(measurements, 90),
            "min": min(measurements) if measurements else None,
            "max": max(measurements) if measurements else None,
        },
        "cases": case_results,
        "notes": [
            "Accuracy uses labelled expected rows in source order; compare the row order to the original photo.",
            "Only fields present in the ground-truth manifest are scored.",
            "A demo response is not real inference and is excluded from accuracy calculations.",
            "The report intentionally omits image paths, raw transcription, customer names and extracted values.",
            "Latency includes client request/response time and may include model warm-up on the first run.",
        ],
    }
    return summary


def _mime_for(path: Path) -> str:
    suffix = path.suffix.lower()
    return {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}.get(suffix, "application/octet-stream")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True, help="Ground-truth JSON manifest. Image paths are relative to the manifest.")
    parser.add_argument("--base-url", default="http://localhost:8000", help="Pakka Khata base URL.")
    parser.add_argument("--runs", type=int, default=1, help="Runs per image (default: 1). Repeated runs call the real model repeatedly.")
    parser.add_argument("--timeout", type=float, default=320.0, help="HTTP timeout seconds per scan request.")
    parser.add_argument("--amount-tolerance", type=float, default=1.0, help="Allowed numeric amount error in rupees.")
    parser.add_argument("--output", type=Path, help="Optional path for aggregate JSON report.")
    args = parser.parse_args()
    if args.runs < 1 or args.timeout <= 0 or args.amount_tolerance < 0:
        parser.error("--runs must be >= 1, --timeout must be > 0, and --amount-tolerance must be >= 0")
    try:
        report = evaluate(args)
    except ValueError as exc:
        print(f"Evaluation not run: {exc}", file=sys.stderr)
        return 2
    report_text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(report_text + "\n", encoding="utf-8")
    print(report_text)
    if report["demo_responses_rejected_from_accuracy"]:
        print("WARNING: one or more responses were demo samples; they were not scored as model output.", file=sys.stderr)
    if report["api_errors_or_non_200"]:
        return 1
    if report["demo_responses_rejected_from_accuracy"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
