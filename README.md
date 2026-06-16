# pi-azure-openai-error-capture

Pi extension package that captures Azure OpenAI provider errors (`HTTP >= 400`) and writes structured JSONL logs for fast troubleshooting.

## What it does

- Listens to `before_provider_request` and `after_provider_response` events.
- Captures provider failures with request metadata (model, token settings, counts).
- Adds transport-layer classification (`transportErrorType`) and retry guidance (`retryable`).
- Detects Azure responses using Azure-style headers (`x-ms-*`, `apim-request-id`, `x-azure-*`).
- Appends each captured error to a JSONL file.
- Adds `/azure-openai-errors` helper command for quick inspection.

## Install

### From GitHub (recommended)

```bash
pi install git:github.com/jezzam/pi-azure-openai-error-capture@v0.1.1
```

### Temporary run (without installing)

```bash
pi -e git:github.com/jezzam/pi-azure-openai-error-capture@v0.1.1
```

### Local project scope

```bash
pi install -l git:github.com/jezzam/pi-azure-openai-error-capture@v0.1.1
```

## Command

```text
/azure-openai-errors [summary|tail <n>|path|clear]
```

- `summary` (default): session-branch summary.
- `tail <n>`: load latest captured records into the editor (`n` max 50).
- `path`: show active log file path.
- `clear`: remove the current log file.

## Environment variables

- `PI_AZURE_OPENAI_ERROR_CAPTURE_FILE`
  - Optional log path override.
  - Default: `~/.pi/logs/azure-openai-errors.jsonl`
  - Relative paths resolve from the current working directory.
- `PI_AZURE_OPENAI_ERROR_CAPTURE_ALL`
  - `true|false` (default `false`)
  - Capture all provider errors, not only Azure-like responses.
- `PI_AZURE_OPENAI_ERROR_CAPTURE_NOTIFY`
  - `true|false` (default `true`)
  - Show in-UI warning notification when an error is captured.

## Example log record

```json
{
  "timestamp": "2026-06-16T08:00:00.000Z",
  "status": 429,
  "requestId": "12345678-aaaa-bbbb-cccc-1234567890ab",
  "retryAfter": "30",
  "transportErrorType": "rate_limited",
  "retryable": true,
  "azure": true,
  "request": {
    "model": "gpt-4.1",
    "stream": true,
    "temperature": 0,
    "max_tokens": 8192,
    "message_count": 7,
    "input_count": null,
    "tool_count": 3
  },
  "responseHeaders": {
    "x-ms-request-id": "12345678-aaaa-bbbb-cccc-1234567890ab",
    "retry-after": "30"
  }
}
```

## Development

```bash
# from this package directory
npm pack --dry-run
```

