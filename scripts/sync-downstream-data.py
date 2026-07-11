from __future__ import annotations

import json
import re
import tempfile
import urllib.request
from pathlib import Path

import pdfplumber

PROJECT_ROOT = Path(__file__).resolve().parents[1]
OUTPUT_PATH = PROJECT_ROOT / "public" / "downstream-products.json"

BUSINESS_URL = "https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=f639192110008256222&type=2&cid=51277"
PREVENTIVE_PRODUCTS_URL = "https://www.fda.gov.tw/tc/includes/GetFile.ashx?id=f639192111390612445&type=3&iid=13719"
CASE_SECTION_URL = "https://www.fda.gov.tw/TC/site.aspx?sid=13707&r=768700034"
CASE_LIST_URL = "https://www.fda.gov.tw/TC/siteList.aspx?sid=13708"

STATUS_NOTES = {
    "96": {"status": "market", "note": "官方備註：與序號 98、331 為同一業者。"},
    "98": {"status": "duplicate", "note": "官方備註：與序號 96 為同一業者。", "duplicateOf": "96"},
    "104": {"status": "removed", "note": "官方備註：經地方衛生局回復，未販售該批問題油品給此業者。"},
    "163": {"status": "market", "note": "官方備註：與序號 199 為同一業者，保留序號 163。"},
    "199": {"status": "duplicate", "note": "官方備註：與序號 163 為同一業者，官方已列為扣除。 ", "duplicateOf": "163"},
    "240": {"status": "feed", "note": "官方備註：飼料用途，非流入一般食品市場。"},
    "243": {"status": "removed", "note": "官方備註：經地方衛生局回復，未販售該批問題油品給此業者。"},
    "266": {"status": "feed", "note": "官方備註：飼料用途，非流入一般食品市場。"},
    "267": {"status": "feed", "note": "官方備註：飼料用途，非流入一般食品市場。"},
    "274": {
        "status": "non_food",
        "note": "官方備註：作為環氧大豆油用途，非供食品烹製用途。",
    },
    "298": {"status": "removed", "note": "官方備註：經地方衛生局回復，未販售該批問題油品給此業者。"},
    "301": {"status": "feed", "note": "官方備註：飼料用途，非流入一般食品市場。"},
    "322": {"status": "feed", "note": "官方備註：飼料用途，非流入一般食品市場。"},
    "331": {"status": "duplicate", "note": "官方備註：與序號 96 為同一業者。", "duplicateOf": "96"},
    "345": {"status": "removed", "note": "官方備註：經地方衛生局回復，未販售該批問題油品給此業者。"},
    "360": {
        "status": "market",
        "note": "官方備註：原單據誤植為誠一食品有限公司，實際業者應為和香行。",
    },
}


def clean_text(value: object) -> str:
    if value is None:
        return ""

    return " ".join(str(value).replace("\u3000", " ").replace("\n", " ").split())


def is_sequence(value: str) -> bool:
    return bool(re.fullmatch(r"\d+\*?", value))


def split_multiline_values(value: str) -> list[str]:
    parts = [segment.strip() for segment in re.split(r"[\n,、，]+", value) if segment.strip()]
    return parts or ([value] if value else [])


def download_file(url: str, destination: Path) -> None:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": "food-safe-scan-downstream-sync",
            "Accept": "application/pdf",
        },
    )
    with urllib.request.urlopen(request) as response:  # noqa: S310
        destination.write_bytes(response.read())


def parse_business_entries(pdf_path: Path) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    current_entry: dict[str, object] | None = None

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for row in table:
                    cells = [clean_text(cell) for cell in row]
                    if not any(cells):
                        continue

                    if cells[0].startswith("中聯油脂") or cells[0] == "序號":
                        continue

                    if is_sequence(cells[0]):
                        sequence = cells[0].rstrip("*")
                        annotation = STATUS_NOTES.get(sequence, {})
                        current_entry = {
                            "id": f"business-{sequence}",
                            "businessNo": sequence,
                            "isStarred": cells[0].endswith("*"),
                            "city": cells[1],
                            "business": cells[2],
                            "status": annotation.get("status", "market"),
                            "statusNote": annotation.get("note", ""),
                            "duplicateOf": annotation.get("duplicateOf", ""),
                            "oilItems": [
                                {
                                    "name": cells[3],
                                    "batch": split_multiline_values(cells[4]),
                                    "expiry": split_multiline_values(cells[5]),
                                }
                            ],
                        }
                        entries.append(current_entry)
                        continue

                    if current_entry and any(cells[3:]):
                        oil_items = current_entry["oilItems"]
                        assert isinstance(oil_items, list)
                        oil_items.append(
                            {
                                "name": cells[3],
                                "batch": split_multiline_values(cells[4]),
                                "expiry": split_multiline_values(cells[5]),
                            }
                        )

    return entries


def parse_preventive_products(pdf_path: Path) -> list[dict[str, object]]:
    products: list[dict[str, object]] = []

    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            for table in page.extract_tables() or []:
                for row in table:
                    cells = [clean_text(cell) for cell in row]
                    if not any(cells):
                        continue

                    if cells[0] in {"業者 序號", "業者序號", "產品序號", "預防性下架產品清單"}:
                        continue

                    if cells[0].isdigit() and cells[3].isdigit():
                        products.append(
                            {
                                "id": f"product-{cells[0]}-{cells[3]}",
                                "businessNo": cells[0],
                                "city": cells[1],
                                "business": cells[2],
                                "productNo": cells[3],
                                "productName": cells[4],
                                "expiry": cells[5],
                            }
                        )

    return products


def build_payload() -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="food-safe-scan-") as temp_dir:
        temp_path = Path(temp_dir)
        business_pdf = temp_path / "downstream-businesses.pdf"
        product_pdf = temp_path / "preventive-products.pdf"

        download_file(BUSINESS_URL, business_pdf)
        download_file(PREVENTIVE_PRODUCTS_URL, product_pdf)

        business_entries = parse_business_entries(business_pdf)
        preventive_products = parse_preventive_products(product_pdf)
        market_business_count = sum(1 for entry in business_entries if entry["status"] == "market")

    return {
        "sourceUrls": {
            "businesses": BUSINESS_URL,
            "preventiveProducts": PREVENTIVE_PRODUCTS_URL,
            "caseSection": CASE_SECTION_URL,
            "caseList": CASE_LIST_URL,
        },
        "fetchedAt": __import__("datetime").datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "businessCount": len(business_entries),
        "marketBusinessCount": market_business_count,
        "preventiveProductCount": len(preventive_products),
        "businessEntries": business_entries,
        "preventiveProducts": preventive_products,
    }


def main() -> None:
    payload = build_payload()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        "Synced downstream dataset:",
        payload["businessCount"],
        "businesses,",
        payload["preventiveProductCount"],
        "preventive products",
    )


if __name__ == "__main__":
    main()
