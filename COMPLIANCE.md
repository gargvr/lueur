# Lueur: compliance by design

Prototype-level assessment for the Geneva {ai} Hackathon 2026. This is not legal advice. Sources were checked on 25 Sep 2026.

## 1. Intended purpose

> Lueur is a general wellbeing and self-awareness tool. It shows a person how their own routine (sleep, movement, places, self-reported mood and energy) has changed compared with their own usual pattern, and signposts support they can choose to contact. It does not diagnose, screen for, monitor, predict or treat any disease or condition.

- **Why this wording matters:** Swissmedic's information sheet *Medical Device Software* (BW630_30_007, v3.0, valid from 21.04.2026) and MedDO Art. 3 / MDR Art. 2(12) define medical device software by its **intended purpose**. That purpose is read from the label, the promotional material and the statements made about the software. Software intended for "diagnosis, prevention, monitoring, prediction, prognosis, treatment or alleviation of disease" is a medical device (MDR Annex VIII Rule 11, typically Class IIa or higher).
- **Rule for the team:** the pitch deck, README, store listing and UI never say "detects depression", "burnout risk", "screening", "symptoms" or "monitoring your condition". Say instead "changes from your usual routine".

## 2. Swiss data protection (revFADP / nDSG, SR 235.1, in force 1 Sep 2023)

| Requirement | Where it lives in Lueur |
|---|---|
| Health data is sensitive (Art. 5(c)(2)); drift detection is profiling (Art. 5(f)) and arguably high-risk profiling (Art. 5(g)) | Treated as sensitive throughout |
| Express consent (Art. 6(7)) | Separate, unticked opt-in per signal plus an explicit consent sentence during onboarding; the date is recorded; consent can be withdrawn per signal on the Privacy tab |
| Privacy by design and by default (Art. 7) | No backend at all; every signal is off by default; places are hashed on-device and only counted; the model sees area names only |
| Data security (Art. 8) | Data stays in the browser's IndexedDB on the device. The Content-Security-Policy allows network access only to the app itself, the font host, the JS CDN and the public model host, so no endpoint exists that could receive personal data |
| Duty to inform (Art. 19) | "Privacy notice" on the Privacy tab: who, why, what, where, how long, shared with, rights |
| Automated decisions (Art. 21) | No decision with legal or similarly significant effect is made; every step to support is the user's own action; rules are published in plain words (Rhythm tab, "How Lueur decides") |
| DPIA (Art. 22) | Section 4 below (DPIA-lite) |
| Access and portability (Art. 25, 28) | "Download my data" exports everything as JSON |
| Deletion (Art. 32) | "Delete everything" removes the database, local storage, all caches and the downloaded model; days older than about 6 months are pruned automatically |

- **On-device processing:** Art. 2(2)(a) excludes processing "by a natural person exclusively for personal use". Because the publisher never receives any data, most controller duties shrink.
- Lueur still applies consent, transparency and a DPIA-lite, because the publisher decides the purpose and design (Art. 7).
- Adding analytics, crash reporting or sync would bring full controller duties back. **Don't add them.**

## 3. AI

- **Switzerland has no AI act yet.**
  - On 12 Feb 2025 the Federal Council chose to ratify the Council of Europe AI Convention and to regulate by sector.
  - A consultation draft is due by the end of 2026.
- **The FDPIC says the FADP applies directly to AI,** including a right to know when you are interacting with a machine. Lueur meets this in three ways:
  - Every AI-written message is labelled "Written by the AI on this phone. It can be wrong."
  - The AI is optional and off until downloaded.
  - The AI only rephrases. Risk levels come from published deterministic rules, and the AI's output is validated and replaced by fixed wording if it fails.
- **EU AI Act, if offered in the EU:**
  - Art. 50 transparency applies from 2 Aug 2026, and is covered by the same labels.
  - Art. 5(1)(f) prohibits emotion recognition in workplaces and education. **Lueur must never be distributed through employers or schools.**
  - A non-medical wellbeing tool is not Annex III high-risk.

## 4. DPIA-lite

- **Data flow:** tracker export file or manual check-in → parsed in the browser → IndexedDB on the device → engine → screen. Optional: area names → on-device model → validator → screen. Sharing happens only by the user copying or sharing text themselves.

| Risk | Mitigation |
|---|---|
| Someone else reads the phone | Data sits behind the phone's own lock. Roadmap: optional app PIN, and blurring when the app is backgrounded |
| False reassurance ("steady" while struggling) | The "Talk to someone now" button is on every screen and independent of the engine. Copy never says "you're fine" |
| False alarm causing worry | Two-week persistence rule, context tags, non-clinical language, a small step suggested first |
| Stigma or employment harm | No employer or insurer channel; the summary contains no labels; the user edits it before sharing |
| Model hallucination | The model gets no numbers; output is validated; fixed-wording fallback |
| Crisis | The model is never used for crisis triage; 143, 144 and HUG are always one tap away |
| Location privacy | Coordinates are never stored: they are rounded, salted and hashed, and only a count is kept |

## 5. Professional secrecy (StGB Art. 321)

- Art. 321 binds doctors, psychologists and their assistants once information is confided to them. The app publisher is not bound by it, and Lueur never sends anything to a professional.
- A person who chooses to share their summary does so themselves, and professional secrecy then applies on the professional's side.
- If a future version sends reports to a GP or psychologist directly, it will need consent at the moment of sending.

## Sources

- Fedlex revFADP (English): https://www.fedlex.admin.ch/eli/cc/2022/491/en
- FDPIC on AI: https://www.edoeb.admin.ch/en/update-current-legislation-directly-applicable-ai
- Federal Council, 12 Feb 2025: https://www.admin.ch/gov/en/start/documentation/media-releases.msg-id-104110.html
- Swissmedic MDSW sheet: https://www.swissmedic.ch/dam/swissmedic/en/dokumente/medizinprodukte/mep_urr/bw630_30_007d_mbmedizinprodukte-software.pdf.download.pdf/BW630_30_007e_MB%20Medical%20Device%20Software.pdf
- EU AI Act Art. 5 and Art. 50: https://artificialintelligenceact.eu/article/5/ and https://artificialintelligenceact.eu/article/50/
