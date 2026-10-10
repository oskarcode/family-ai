# Ingest MCP Test Fixtures

Use these files to test API/MCP upload behavior for different ingestion paths.

## Files

- `01-indexable-basic.txt`: small plain text, should index directly.
- `02-indexable-notes.md`: small markdown, should index directly.
- `03-indexable-table.csv`: small CSV, should index directly.
- `04-convertible-richtext.rtf`: RTF, should convert and index.
- `05-nonindex-image.jpg`: image extension, expected store-only/non-indexable path.
- `06-nonindex-video.mp4`: video extension, expected non-indexable/rejected path.
- `07-size-near-limit-3_8mb.txt`: size test near 4MB index limit.
- `08-size-over-limit-4_6mb.txt`: size test over 4MB index limit (split/convert recommendation).

## Generate size fixtures

Run once to create the two large files:

```bash
python3 test-fixtures/ingest-mcp/generate-large-fixtures.py
```

## Suggested test order

1. Upload `01-indexable-basic.txt` and verify retrieval with token `FIXTURE_INDEXABLE_BASIC_20260629`.
2. Upload `04-convertible-richtext.rtf` and verify converted content is searchable.
3. Upload `06-nonindex-video.mp4` to confirm non-indexable policy behavior.
4. Upload `08-size-over-limit-4_6mb.txt` to test large-file handling path.
