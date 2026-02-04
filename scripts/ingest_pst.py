#!/usr/bin/env python3
"""
PST File Ingestion Script

Parses Outlook .pst files and sends emails to the ingestion API.

Requirements:
    pip install pypff requests tqdm

Usage:
    python ingest_pst.py /path/to/file.pst --api-url http://localhost:8787
"""

import argparse
import json
import sys
import hashlib
import base64
from datetime import datetime
from pathlib import Path
from typing import Generator, Optional
from dataclasses import dataclass, asdict

try:
    import pypff
except ImportError:
    print("Error: pypff not installed. Run: pip install pypff")
    print("Note: On macOS you may need: brew install libpff && pip install pypff")
    sys.exit(1)

import requests
from tqdm import tqdm


@dataclass
class EmailMessage:
    """Parsed email message"""
    message_id: str
    subject: str
    body_text: str
    body_html: Optional[str]
    sent_at: str
    from_email: str
    from_name: Optional[str]
    to: list
    cc: list
    bcc: list
    in_reply_to: Optional[str]
    references: list
    attachments: list


def parse_pst_file(pst_path: str) -> Generator[EmailMessage, None, None]:
    """
    Parse a PST file and yield email messages.
    """
    pst = pypff.file()
    pst.open(pst_path)

    root = pst.get_root_folder()

    yield from walk_folder(root, pst_path)

    pst.close()


def walk_folder(folder, source_path: str, depth: int = 0) -> Generator[EmailMessage, None, None]:
    """
    Recursively walk PST folders and yield messages.
    """
    # Process messages in this folder
    for i in range(folder.number_of_sub_messages):
        try:
            message = folder.get_sub_message(i)
            parsed = parse_message(message, source_path)
            if parsed:
                yield parsed
        except Exception as e:
            print(f"  Warning: Failed to parse message {i}: {e}")

    # Recurse into subfolders
    for i in range(folder.number_of_sub_folders):
        try:
            subfolder = folder.get_sub_folder(i)
            yield from walk_folder(subfolder, source_path, depth + 1)
        except Exception as e:
            print(f"  Warning: Failed to access subfolder {i}: {e}")


def parse_message(message, source_path: str) -> Optional[EmailMessage]:
    """
    Parse a single PST message into our EmailMessage format.
    """
    try:
        # Get basic fields
        subject = message.subject or "(No Subject)"

        # Get body
        body_text = ""
        body_html = None

        if message.plain_text_body:
            body_text = message.plain_text_body
        if message.html_body:
            body_html = message.html_body
            if not body_text:
                # Extract text from HTML as fallback
                body_text = strip_html(body_html)

        # Get sender
        from_email = extract_email(message.sender_name or "")
        from_name = message.sender_name

        # Try to get proper email from transport headers
        headers = message.transport_headers or ""
        if "From:" in headers:
            from_line = extract_header(headers, "From")
            if from_line:
                from_email = extract_email(from_line)
                from_name = extract_name(from_line)

        if not from_email:
            return None  # Skip messages without sender

        # Get recipients
        to_list = parse_recipients(headers, "To")
        cc_list = parse_recipients(headers, "Cc")
        bcc_list = parse_recipients(headers, "Bcc")

        # Get message ID
        message_id = extract_header(headers, "Message-ID") or extract_header(headers, "Message-Id")
        if not message_id:
            # Generate a unique ID based on content
            content_hash = hashlib.md5(f"{from_email}{subject}{message.delivery_time}".encode()).hexdigest()
            message_id = f"<generated-{content_hash}@pst-import>"

        # Get thread references
        in_reply_to = extract_header(headers, "In-Reply-To")
        references_str = extract_header(headers, "References")
        references = references_str.split() if references_str else []

        # Get sent time
        sent_at = None
        if message.delivery_time:
            sent_at = message.delivery_time.isoformat()
        else:
            # Try to parse from headers
            date_header = extract_header(headers, "Date")
            if date_header:
                try:
                    from email.utils import parsedate_to_datetime
                    sent_at = parsedate_to_datetime(date_header).isoformat()
                except:
                    pass

        if not sent_at:
            sent_at = datetime.now().isoformat()

        # Get attachments
        attachments = []
        for i in range(message.number_of_attachments):
            try:
                attachment = message.get_attachment(i)
                if attachment.name:
                    # Read attachment data
                    data = attachment.read_buffer(attachment.size)
                    attachments.append({
                        "filename": attachment.name,
                        "content_type": guess_content_type(attachment.name),
                        "size": attachment.size,
                        "content_base64": base64.b64encode(data).decode() if data else ""
                    })
            except Exception as e:
                print(f"    Warning: Failed to read attachment {i}: {e}")

        return EmailMessage(
            message_id=message_id.strip("<>"),
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            sent_at=sent_at,
            from_email=from_email,
            from_name=from_name,
            to=to_list,
            cc=cc_list,
            bcc=bcc_list,
            in_reply_to=in_reply_to.strip("<>") if in_reply_to else None,
            references=[r.strip("<>") for r in references],
            attachments=attachments
        )

    except Exception as e:
        print(f"  Error parsing message: {e}")
        return None


def extract_header(headers: str, name: str) -> Optional[str]:
    """Extract a header value from transport headers."""
    for line in headers.split("\n"):
        if line.lower().startswith(name.lower() + ":"):
            return line.split(":", 1)[1].strip()
    return None


def extract_email(text: str) -> str:
    """Extract email address from a string like 'Name <email@example.com>'."""
    import re
    match = re.search(r'<([^>]+@[^>]+)>', text)
    if match:
        return match.group(1).lower()
    # Try bare email
    match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', text)
    if match:
        return match.group(0).lower()
    return text.lower()


def extract_name(text: str) -> Optional[str]:
    """Extract name from a string like 'Name <email@example.com>'."""
    import re
    match = re.match(r'^([^<]+)<', text)
    if match:
        name = match.group(1).strip().strip('"')
        return name if name else None
    return None


def parse_recipients(headers: str, header_name: str) -> list:
    """Parse To/Cc/Bcc header into list of {email, name} dicts."""
    value = extract_header(headers, header_name)
    if not value:
        return []

    recipients = []
    # Split by comma, handling quoted names
    import re
    parts = re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', value)

    for part in parts:
        part = part.strip()
        if not part:
            continue
        email = extract_email(part)
        name = extract_name(part)
        if email:
            recipients.append({"email": email, "name": name})

    return recipients


def strip_html(html: str) -> str:
    """Simple HTML to text conversion."""
    import re
    text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


def guess_content_type(filename: str) -> str:
    """Guess content type from filename."""
    ext = Path(filename).suffix.lower()
    types = {
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.xls': 'application/vnd.ms-excel',
        '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.zip': 'application/zip',
        '.txt': 'text/plain',
    }
    return types.get(ext, 'application/octet-stream')


def send_batch(emails: list, api_url: str, api_key: Optional[str] = None, source_id: Optional[str] = None) -> dict:
    """Send a batch of emails to the ingestion API."""
    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    payload = {"emails": [asdict(e) for e in emails]}
    if source_id:
        payload["source_id"] = source_id

    response = requests.post(
        f"{api_url}/api/ingest",
        json=payload,
        headers=headers,
        timeout=60
    )
    response.raise_for_status()
    return response.json()


def main():
    parser = argparse.ArgumentParser(description="Ingest PST files into Email Intelligence")
    parser.add_argument("pst_file", help="Path to the PST file")
    parser.add_argument("--api-url", default="http://localhost:8787", help="API base URL")
    parser.add_argument("--api-key", help="API key for authentication")
    parser.add_argument("--source-id", help="Source ID for tracking (create via UI first)")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for API calls")
    parser.add_argument("--skip-attachments", action="store_true", help="Skip attachment upload")
    parser.add_argument("--dry-run", action="store_true", help="Parse without sending to API")

    args = parser.parse_args()

    pst_path = Path(args.pst_file)
    if not pst_path.exists():
        print(f"Error: File not found: {pst_path}")
        sys.exit(1)

    print(f"Parsing PST file: {pst_path}")
    print(f"API URL: {args.api_url}")
    print(f"Batch size: {args.batch_size}")
    print()

    # Count messages first (for progress bar)
    print("Counting messages...")
    total_messages = 0
    for _ in parse_pst_file(str(pst_path)):
        total_messages += 1
    print(f"Found {total_messages} messages")
    print()

    # Mark source as processing
    if args.source_id and not args.dry_run:
        try:
            requests.post(
                f"{args.api_url}/api/sources/{args.source_id}/start",
                json={"emails_total": total_messages},
                timeout=10
            )
        except Exception as e:
            print(f"Warning: Failed to update source status: {e}")

    # Process in batches
    batch = []
    processed = 0
    failed = 0

    pbar = tqdm(total=total_messages, desc="Processing")

    for email in parse_pst_file(str(pst_path)):
        if args.skip_attachments:
            email.attachments = []

        batch.append(email)

        if len(batch) >= args.batch_size:
            if not args.dry_run:
                try:
                    result = send_batch(batch, args.api_url, args.api_key, args.source_id)
                    processed += result.get("processed", 0)
                    failed += result.get("failed", 0)
                except Exception as e:
                    print(f"\n  Error sending batch: {e}")
                    failed += len(batch)
            else:
                processed += len(batch)

            pbar.update(len(batch))
            batch = []

    # Send remaining
    if batch:
        if not args.dry_run:
            try:
                result = send_batch(batch, args.api_url, args.api_key, args.source_id)
                processed += result.get("processed", 0)
                failed += result.get("failed", 0)
            except Exception as e:
                print(f"\n  Error sending batch: {e}")
                failed += len(batch)
        else:
            processed += len(batch)

        pbar.update(len(batch))

    pbar.close()

    # Mark source as completed
    if args.source_id and not args.dry_run:
        try:
            requests.post(
                f"{args.api_url}/api/sources/{args.source_id}/complete",
                json={"status": "completed"},
                timeout=10
            )
        except Exception as e:
            print(f"Warning: Failed to update source status: {e}")

    print()
    print(f"Complete!")
    print(f"  Processed: {processed}")
    print(f"  Failed: {failed}")


if __name__ == "__main__":
    main()
