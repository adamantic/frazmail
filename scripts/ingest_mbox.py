#!/usr/bin/env python3
"""
MBOX File Ingestion Script (Gmail Takeout)

Parses .mbox files exported from Gmail via Google Takeout
and sends emails to the ingestion API.

Requirements:
    pip install requests tqdm

Usage:
    python ingest_mbox.py /path/to/All\ mail\ Including\ Spam\ and\ Trash.mbox --api-url http://localhost:8787
"""

import argparse
import mailbox
import email
import email.utils
import json
import sys
import hashlib
import base64
import re
from datetime import datetime
from pathlib import Path
from typing import Generator, Optional
from dataclasses import dataclass, asdict

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


def parse_mbox_file(mbox_path: str) -> Generator[EmailMessage, None, None]:
    """
    Parse an MBOX file and yield email messages.
    """
    mbox = mailbox.mbox(mbox_path)

    for message in mbox:
        try:
            parsed = parse_message(message)
            if parsed:
                yield parsed
        except Exception as e:
            print(f"  Warning: Failed to parse message: {e}")

    mbox.close()


def parse_message(message: email.message.Message) -> Optional[EmailMessage]:
    """
    Parse a single email message into our EmailMessage format.
    """
    try:
        # Get message ID
        message_id = message.get("Message-ID", "")
        if message_id:
            message_id = message_id.strip("<>")
        else:
            # Generate unique ID
            content = f"{message.get('From', '')}{message.get('Subject', '')}{message.get('Date', '')}"
            message_id = f"generated-{hashlib.md5(content.encode()).hexdigest()}@mbox-import"

        # Get subject
        subject = decode_header(message.get("Subject", "(No Subject)"))

        # Get sender
        from_header = message.get("From", "")
        from_email = extract_email(from_header)
        from_name = extract_name(from_header)

        if not from_email:
            return None  # Skip messages without sender

        # Get recipients
        to_list = parse_recipients(message.get("To", ""))
        cc_list = parse_recipients(message.get("Cc", ""))
        bcc_list = parse_recipients(message.get("Bcc", ""))

        # Get body
        body_text = ""
        body_html = None
        attachments = []

        if message.is_multipart():
            for part in message.walk():
                content_type = part.get_content_type()
                content_disposition = str(part.get("Content-Disposition", ""))

                # Check if it's an attachment
                if "attachment" in content_disposition:
                    filename = part.get_filename()
                    if filename:
                        try:
                            payload = part.get_payload(decode=True)
                            if payload:
                                attachments.append({
                                    "filename": decode_header(filename),
                                    "content_type": content_type,
                                    "size": len(payload),
                                    "content_base64": base64.b64encode(payload).decode()
                                })
                        except Exception as e:
                            print(f"    Warning: Failed to read attachment: {e}")
                    continue

                # Get text/html content
                if content_type == "text/plain" and not body_text:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        try:
                            body_text = payload.decode(charset, errors="replace")
                        except:
                            body_text = payload.decode("utf-8", errors="replace")

                elif content_type == "text/html" and not body_html:
                    payload = part.get_payload(decode=True)
                    if payload:
                        charset = part.get_content_charset() or "utf-8"
                        try:
                            body_html = payload.decode(charset, errors="replace")
                        except:
                            body_html = payload.decode("utf-8", errors="replace")

        else:
            # Simple non-multipart message
            content_type = message.get_content_type()
            payload = message.get_payload(decode=True)

            if payload:
                charset = message.get_content_charset() or "utf-8"
                try:
                    decoded = payload.decode(charset, errors="replace")
                except:
                    decoded = payload.decode("utf-8", errors="replace")

                if content_type == "text/html":
                    body_html = decoded
                    body_text = strip_html(decoded)
                else:
                    body_text = decoded

        # If we only have HTML, extract text
        if not body_text and body_html:
            body_text = strip_html(body_html)

        # Get sent time
        date_header = message.get("Date", "")
        sent_at = None
        if date_header:
            try:
                parsed_date = email.utils.parsedate_to_datetime(date_header)
                sent_at = parsed_date.isoformat()
            except Exception:
                pass

        if not sent_at:
            sent_at = datetime.now().isoformat()

        # Get thread references
        in_reply_to = message.get("In-Reply-To", "")
        if in_reply_to:
            in_reply_to = in_reply_to.strip("<>")
        else:
            in_reply_to = None

        references_header = message.get("References", "")
        references = []
        if references_header:
            references = [r.strip("<>") for r in references_header.split()]

        return EmailMessage(
            message_id=message_id,
            subject=subject,
            body_text=body_text,
            body_html=body_html,
            sent_at=sent_at,
            from_email=from_email,
            from_name=from_name,
            to=to_list,
            cc=cc_list,
            bcc=bcc_list,
            in_reply_to=in_reply_to,
            references=references,
            attachments=attachments
        )

    except Exception as e:
        print(f"  Error parsing message: {e}")
        return None


def decode_header(value: str) -> str:
    """Decode RFC 2047 encoded header value."""
    if not value:
        return value

    try:
        decoded_parts = email.header.decode_header(value)
        result = []
        for part, charset in decoded_parts:
            if isinstance(part, bytes):
                result.append(part.decode(charset or "utf-8", errors="replace"))
            else:
                result.append(part)
        return "".join(result)
    except:
        return value


def extract_email(text: str) -> str:
    """Extract email address from a string like 'Name <email@example.com>'."""
    text = decode_header(text)
    match = re.search(r'<([^>]+@[^>]+)>', text)
    if match:
        return match.group(1).lower()
    match = re.search(r'[\w\.-]+@[\w\.-]+\.\w+', text)
    if match:
        return match.group(0).lower()
    return text.lower()


def extract_name(text: str) -> Optional[str]:
    """Extract name from a string like 'Name <email@example.com>'."""
    text = decode_header(text)
    match = re.match(r'^([^<]+)<', text)
    if match:
        name = match.group(1).strip().strip('"')
        return name if name else None
    return None


def parse_recipients(header: str) -> list:
    """Parse To/Cc/Bcc header into list of {email, name} dicts."""
    if not header:
        return []

    header = decode_header(header)
    recipients = []

    # Split by comma, handling quoted names
    parts = re.split(r',(?=(?:[^"]*"[^"]*")*[^"]*$)', header)

    for part in parts:
        part = part.strip()
        if not part:
            continue
        addr = extract_email(part)
        name = extract_name(part)
        if addr:
            recipients.append({"email": addr, "name": name})

    return recipients


def strip_html(html: str) -> str:
    """Simple HTML to text conversion."""
    text = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL)
    text = re.sub(r'<style[^>]*>.*?</style>', '', text, flags=re.DOTALL)
    text = re.sub(r'<[^>]+>', ' ', text)
    text = re.sub(r'\s+', ' ', text)
    return text.strip()


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


def count_messages(mbox_path: str) -> int:
    """Count messages in mbox file."""
    mbox = mailbox.mbox(mbox_path)
    count = len(mbox)
    mbox.close()
    return count


def main():
    parser = argparse.ArgumentParser(description="Ingest MBOX files into Email Intelligence")
    parser.add_argument("mbox_file", help="Path to the MBOX file")
    parser.add_argument("--api-url", default="http://localhost:8787", help="API base URL")
    parser.add_argument("--token", "--api-key", dest="token", help="Auth token (get from browser localStorage)")
    parser.add_argument("--source-id", help="Source ID for tracking (create via UI first)")
    parser.add_argument("--batch-size", type=int, default=50, help="Batch size for API calls")
    parser.add_argument("--skip-attachments", action="store_true", help="Skip attachment upload")
    parser.add_argument("--dry-run", action="store_true", help="Parse without sending to API")

    args = parser.parse_args()

    mbox_path = Path(args.mbox_file)
    if not mbox_path.exists():
        print(f"Error: File not found: {mbox_path}")
        sys.exit(1)

    print(f"Parsing MBOX file: {mbox_path}")
    print(f"API URL: {args.api_url}")
    print(f"Batch size: {args.batch_size}")
    print()

    # Count messages first
    print("Counting messages...")
    total_messages = count_messages(str(mbox_path))
    print(f"Found {total_messages} messages")
    print()

    # Build headers
    headers = {"Content-Type": "application/json"}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    # Mark source as processing
    if args.source_id and not args.dry_run:
        try:
            requests.post(
                f"{args.api_url}/api/sources/{args.source_id}/start",
                json={"emails_total": total_messages},
                headers=headers,
                timeout=10
            )
        except Exception as e:
            print(f"Warning: Failed to update source status: {e}")

    # Process in batches
    batch = []
    processed = 0
    failed = 0

    pbar = tqdm(total=total_messages, desc="Processing")

    for email_msg in parse_mbox_file(str(mbox_path)):
        if args.skip_attachments:
            email_msg.attachments = []

        batch.append(email_msg)

        if len(batch) >= args.batch_size:
            if not args.dry_run:
                try:
                    result = send_batch(batch, args.api_url, args.token, args.source_id)
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
                result = send_batch(batch, args.api_url, args.token, args.source_id)
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
                json={"status": "completed" if failed == 0 else "completed"},
                headers=headers,
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
