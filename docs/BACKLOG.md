# Backlog

Requests from the user that are not in a plan yet, newest first.

## Documents as standing context for the coach (requested 2026-10-09)

The learner wants to give the app their CV and other important files once, so that when someone
asks about something related in a meeting, the AI always has that context — for «Respuesta», the
translation where relevant, and the report.

Open questions for the design (decide before planning):
- Which formats: PDF, DOCX, plain text/Markdown; images of documents (OCR) or not.
- Where the text lives: extracted on the device and stored in IndexedDB like the profile — never
  uploaded except as prompt text to the chat provider the learner chose, and the privacy screen
  must say so.
- How much of it goes into each request: the whole text for short CVs, or the relevant passages
  only (chunking and retrieval on the device) when the files are long, to stay within the provider's
  context and the free tiers' token limits.
- How it relates to «Tu perfil» (1500 characters today): replace it, feed it, or sit beside it.
- PDF/DOCX extraction without dependencies (the project has no build step): a vendored, audited
  library under `vendor/`, or the provider's own document input where it exists (Claude and Gemini
  accept PDFs) — the latter sends the file itself to the provider.
