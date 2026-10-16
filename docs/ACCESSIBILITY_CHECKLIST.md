# Accessibility checklist — manual release pass

This is a test record template, not an accessibility conformance claim. Mark each item only after testing the running app.

- [ ] Keyboard: every interactive element is reachable and activatable; focus is visible; Escape/Cancel behavior is predictable.
- [ ] Zoom/reflow: test at 200% browser zoom and 320 CSS-pixel viewport; review and save/cancel controls remain usable.
- [ ] Labels: form controls have visible labels associated with the input; placeholders are not the only labels.
- [ ] Error handling: invalid scan/review/form fields show actionable messages via `role="alert"`; async success/progress uses status/live-region semantics.
- [ ] Status semantics: scan progress, cancel, offline state, copy confirmation, backup status and reminder fallback are announced to assistive tech.
- [ ] Contrast: normal text, muted text, input borders, status colors and focus indicators meet the team's required contrast targets in light/dark and all locales.
- [ ] Non-color cues: credit vs payment, sample data, low confidence, paid vs owing, warning and failure are identified by text/icons as well as color.
- [ ] Image alt text: informative images have concise descriptions; decorative icons/images are hidden from the accessibility tree.
- [ ] Language: `document.documentElement.lang` updates with selected UI language; Hindi/Marathi self-hosted fonts render without clipped or missing glyphs.
- [ ] Screen reader: test one supported combination (e.g. NVDA + Firefox/Chrome) across setup, scan, review, customer detail, backup, lock and reminder flow.
- [ ] Motion/timing: no unnecessary animation; long-running scan state provides elapsed time and a clear Cancel action; do not imply a fake percent complete.
- [ ] WhatsApp: reminder copy is editable, tone/language are correctly labelled, and the UI makes it clear that the user reviews and manually sends it.

Record browser/OS, date, tester, failed items, screenshots/issues and retest status in the release notes. Automated build/tests do not replace this pass.
