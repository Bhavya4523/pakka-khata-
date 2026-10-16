"""Non-user sample content for explicitly labelled demo mode."""
from backend.schemas import ScanResponse


def sample_extraction() -> ScanResponse:
    return ScanResponse(
        page_title="Sample khata page",
        demo=True,
        warnings=["Sample result, not a reading of your photo. Use this only to preview the review flow."],
        rows=[
            {
                "customer_name": "रमेश पाटील",
                "date": "2026-10-12",
                "items": "किराणा सामान",
                "amount": 850,
                "type": "credit",
                "confidence": 0.92,
                "raw_text": "रमेश पाटील 12/10 850",
            },
            {
                "customer_name": "Asha tai",
                "date": "2026-10-13",
                "items": "दूध",
                "amount": 200,
                "type": "payment",
                "confidence": 0.78,
                "raw_text": "Asha tai भरले 200",
            },
        ],
    )
