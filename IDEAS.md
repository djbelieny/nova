# Ideas

## Voice Recognition Authentication

Replace PIN-based phone call authentication with speaker verification (voiceprint).

**Enrollment:** User sends 3-5 voice messages via Telegram saying a passphrase. System extracts a voiceprint embedding and stores it in `users.voiceprint`.

**Verification:** On each Twilio call, instead of "Enter your PIN", Nova says "Please say the passphrase." Records a few seconds, extracts embedding, compares against stored voiceprint. Authenticates if similarity > 0.75.

**Fallback:** Keep PIN for noisy environments or voice match failure.

**Recommended approach:** Resemblyzer (Python, local, free, ~50MB model). Runs on Mac, no cloud dependency, no per-call cost.

**Also:** Add PIN management to the Mini App profile page so users can set/change their PIN from the app.
