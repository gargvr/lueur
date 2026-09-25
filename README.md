# Lueur

**Notice small shifts in your own rhythm early, and reach the right person at your own pace.**
Geneva {ai} Hackathon 2026 · AGPsy challenge (Association Genevoise des Psychologues).

Lueur is a mobile web app (PWA) that learns a person's *own* usual pattern of sleep, movement, places and mood. When several of those drift away from the usual for most of two weeks, it says so kindly and offers a graduated, user-controlled path to support: keep an eye on it, share with a trusted person, or talk to a professional. Everything runs on the phone. There is no server.

> Lueur is a general wellbeing tool. It does not diagnose, screen for, monitor or predict any disease, and it is not a medical device. See [COMPLIANCE.md](COMPLIANCE.md).

## Run it

```bash
node serve.js 5178
```

Open http://localhost:5178 on a laptop, or deploy the folder to any static host (Vercel, Netlify, GitHub Pages). It must be served over **HTTPS** on a phone, because location, service workers and WebGPU need a secure context. On the phone, use *Add to Home Screen* to install it.

No build step and no dependencies: plain HTML, CSS and ES modules.

## What's inside

| File | Job |
|---|---|
| `js/engine.js` | Baseline-drift engine. Deterministic, explainable, no ML deciding risk. |
| `js/slm.js` | Optional on-device language model (WebLLM + WebGPU) that only rephrases, behind a validator. |
| `js/importers.js` | Fitbit (Kaggle CSV, Google Takeout JSON), Apple Health `export.xml` (streamed), Lueur CSV. All parsed on the device. |
| `js/sensing.js` | Places: coordinates are rounded, salted and hashed, then discarded; only a daily count is kept. |
| `js/demo.js` | Two synthetic personas ("gradual shift", "steady rhythm") with a fixed seed. |
| `js/store.js` | IndexedDB storage, export, delete-everything, six-month retention. |
| `data/pmdata-p01.csv` | Real data: participant 1 of PMData (see Data). |

## How the engine decides

For each signal (sleep duration, bedtime, sleep regularity, steps, places, mood check-in, energy check-in):

1. **The usual you:** median and median absolute deviation over the 28 days before the last 14. Days the person tagged (travel, illness, holiday, deadline, visitors, new baby, night shift) are excluded.
2. **A day is "off"** if it is more than 1.5 robust SDs from the usual in the unhelpful direction (for example later bedtime or fewer steps; for sleep, either direction).
3. **A signal has shifted** if it was off on at least 60% of the last 14 days *and* the last week's median is at least 1.2 robust SDs off.
4. **Levels:**
   - **Level 1 ("something shifted a little")**: at least one shifted signal, or two mildly shifted ones.
   - **Level 2 ("a good moment to share how you are")**: three shifted signals, or two plus a check-in signal.
   - Nothing is ever sent anywhere automatically.
5. A signal needs at least 21 days of history before anything is judged.

**Why a personal baseline:**
- Early warning signs tend to repeat within the same person (Benasi et al. 2021).
- Population-level models collapse at scale: GPS-based detection fell from AUC 0.82 to 0.57 in 5,262 people (Müller et al. 2021; Pratap et al. 2019).
- The 14-day window follows the ICD-11 two-week convention.

**Signals follow:**
- Wang et al. 2018, *Tracking Depression Dynamics in College Students Using Mobile Phone and Wearable Sensing* (Proc. ACM IMWUT 2(1)). This paper mapped 5 of the 9 DSM-5 symptoms to sleep, stationary time, places, conversation and phone-use features.
- Fang et al. 2021, *npj Digital Medicine*. In 2,115 interns, shorter, later and more variable sleep tracked worsening mood.

**Deliberately left out:**
- Raw late-night phone use. Dissing et al. 2022 (*Sci Rep*, n=815) found it was not strongly associated with later poor mental health.
- Language, keystroke and voice features, which are invasive and have weaker evidence.

**On real data:** across five months of PMData participant 1, the engine never reached level 2. It raised level 1 a handful of times, including over the Christmas holidays, which is exactly what the "tag this day" chips are for.

## The on-device model, and why it's on a leash

- `slm.js` can load a small model through [WebLLM](https://github.com/mlc-ai/web-llm) and run it on the phone's GPU (WebGPU, available in iOS Safari 26 and Android Chrome 121+).
- The weights are downloaded once from Hugging Face and cached; after that it works offline.
- **The model never decides anything.** It is told only *which areas* changed (for example "later bedtimes, less movement"). It never sees numbers, names, dates or raw data.
- Its reply is validated before anyone sees it: no digits, no markdown or placeholders, no clinical words, no claims that anything "improved", and it must mention the areas it was given.
- If validation fails three times, Lueur shows its fixed wording instead.
- See [Model results](#model-results) for how the two models fared against the validator.
- **Swiss roadmap:** Apertus (ETH/EPFL/CSCS) has 0.5B and 1.5B instruct models under Apache-2.0. There is no WebLLM/ONNX build yet; converting one is the natural next step.

## Data

- **Synthetic personas** (default demo): generated in `demo.js`. Ranges come from typical consumer-tracker values; the drift pattern follows Wang 2018 and Fang 2021.
- **PMData** (Thambawita et al. 2020, Simula Research Laboratory): https://osf.io/vx4bk/
  - Licence: **CC BY-NC 4.0** (non-commercial).
  - `data/pmdata-p01.csv` is derived from participant p01. It contains Fitbit sleep (duration and start time), daily steps, and the daily wellness `mood` and `fatigue` ratings (fatigue is mapped to energy; higher means more rested).
- **Fitbit Fitness Tracker Data** (Furberg et al., Zenodo 53894, CC BY 4.0; Kaggle mirror arashnic/fitbit, CC0): works with the importer as-is.
- **For validation later:**
  - GLOBEM (PhysioNet, credentialed; weekly PHQ-4 labels).
  - LifeSnaps (Zenodo 7229547, CC BY 4.0) for calibrating within-person variability.
  - No open, login-free dataset has depression labels, so Lueur claims only "change from your own usual", never clinical accuracy.

## Android app (passive)

The same web app, wrapped with Capacitor 8, plus a small Kotlin layer in `android/app/src/main/java/ch/lueur/app/`:

| File | Job |
|---|---|
| `Collector.kt` | Reads **Health Connect** (steps and sleep only, read-only), so any band that syncs there works: Fitbit, Samsung, Oura, Withings, Xiaomi and others. Without a wearable, it estimates sleep from the **screen's night-time off/on pattern** (Usage access; only screen on/off times, never app content) and reads **steps from the phone's own step counter**. A real tracker always wins over the phone's estimate. |
| `DailyWorker.kt` | WorkManager job, about hourly: samples the step counter; once a day collects; once a day after 10:00 checks for a sustained shift and shows **at most one silent notification a week**. It never names a condition and never contacts anyone. |
| `DriftCheck.kt` | The same rules as `engine.js` (sensor signals only). Verified to agree with the JS engine on the same data. |
| `LueurHealthPlugin.kt` | The bridge the web UI calls (`js/native.js`). |
| `DemoSeeder.kt` | **Debug builds only**: writes 6 weeks of sample steps and sleep into Health Connect so the whole path can be demoed without a wearable. Release builds have no write permission. |

Build (needs JDK 21, Android SDK 36, Node 22+):

```bash
npm install
npm run android:sync
cd android && ./gradlew assembleDebug
```

The APK lands in `android/app/build/outputs/apk/debug/app-debug.apk`. Install with `adb install -r` or copy it to the phone.

Tested on the Android 15 emulator:
- Health Connect's own permission screens list exactly **Sleep** and **Steps**, then ask for past data.
- Sample data flows from Health Connect into Lueur, and the engine flags the shift.
- The native check and the JS engine agree (3 shifted signals).
- The notification lands in Android's **Silent** section.

Not yet verified: the screen-pattern sleep estimate needs a real phone left overnight, because a fresh emulator has no night history.

## iPhone app (passive, Apple Health)

Same web app, wrapped with Capacitor 8 (Swift Package Manager, no CocoaPods). The Swift layer lives in `ios/App/App/LueurHealthPlugin.swift`.

**What it reads from Apple Health** (read-only; iOS shows a per-type permission sheet):

| Signal | Needs Apple Watch? | Evidence |
|---|---|---|
| Steps | No, every iPhone counts them | Bizzozero-Peroni 2024 |
| Sleep (asleep stages, merged across sources) | Watch or a sleep app | Fang 2021, Baglioni 2011 |
| Exercise minutes | Yes | Pearce 2022, *JAMA Psychiatry*: 15 cohorts, n=191,130; half the recommended activity went with 18% lower depression risk |
| Resting heart rate | Yes | RADAR-MDD (Condominas 2025) |
| Heart rate variability (SDNN) | Yes | Koch 2019 (a small effect, so one input among many) |
| Time in daylight (iOS 17+) | Yes | Burns 2021/2023, UK Biobank |
| State of Mind moods logged in Health (iOS 18+) | No | Used as a check-in when the person didn't check in here |

**Deliberately not read:**
- **PHQ-9 / GAD-7 scores** (HKScoredAssessment, iOS 18). These are clinical screening instruments. Reading them would make Lueur depression-screening software, which is a medical device.
- **Respiratory rate** and **wrist temperature**. Drift in these mostly signals illness, so a flag would look like a medical alert.
- **Screen Time**. Apple doesn't expose it to apps as numbers.

**Background:**
- `HKObserverQuery` plus `enableBackgroundDelivery(.daily)` on sleep and steps. This needs the `com.apple.developer.healthkit.background-delivery` entitlement.
- When new data arrives, the Swift port of the rules (`LueurDrift`) runs.
- At most once a week it posts a **passive** local notification: no sound, no banner.

**Demo build:** the Privacy tab has "fill Apple Health with 6 weeks of sample data". It writes steps, sleep, resting HR, HRV and State of Mind. HealthKit refuses app writes for exercise minutes and time in daylight, since those are Watch-only.

**Build and run** (simulator):

```bash
npm run build:web && npx cap sync ios
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -sdk iphonesimulator -configuration Debug -derivedDataPath build build
```

- A real iPhone needs an Apple ID set as the signing team in Xcode.
- A free account works for 7 days per install.
- TestFlight needs the paid Apple Developer Program.

Tested on the iPhone 17 Pro simulator (iOS 26):
- Apple's Health sheet lists each type.
- Sample data flows into Lueur and flags 7 shifted signals.
- "Why am I seeing this?" lists each one in plain words.

## Past places from Google Maps Timeline

No app can read Google Timeline: since 2024 it lives only on the phone and has no API. Lueur offers a 30-second hand-over instead: **Privacy → Past places → Add**.
- **Android:** Lueur opens Timeline settings, the person taps *Export Timeline data*, then picks the file.
- **iPhone:** Google Maps › Your Timeline › Export.

`fromTimeline()` in `js/importers.js` reads all three formats:
- the Android on-device export (`semanticSegments`),
- the iPhone export (a bare array with `geo:` URIs),
- older Takeout files (`timelineObjects`, `Records.json`).

Each day is reduced to places, % of the day at home and range (Google's HOME label, or the spot occupied at 03:00), and the coordinates are discarded. The export's final, partial day is dropped.

## Limits a browser imposes

A web page cannot sense in the background and cannot read screen time or sleep directly. Lueur therefore:
- imports sleep and steps from the person's tracker export,
- counts places only while it is open,
- asks for a ten-second daily check-in.

A native wrapper (Capacitor) with HealthKit and Health Connect would make sleep, steps and places fully passive, with the same engine and UI.

## Support resources used in the app (verified 25 Sep 2026)

- **143** La Main Tendue: 24/7, anonymous.
- **147** Pro Juventute: up to age 25.
- **HUG psychiatric emergencies**: 022 372 38 62.
- **144** medical emergency.
- **AGPsy** directory https://www.agpsy.ch/members/search, or 022 735 53 83.
- GP prescription model: psychologist-psychotherapy has been covered by basic insurance since 1 July 2022, 15 sessions per prescription.

## Model results

Tested 26 Sep 2026 in Chrome with WebGPU, on the "gradual shift" demo, 8 generations each:

| Model | Download | Passed validator | Time per attempt | Notes |
|---|---|---|---|---|
| Qwen2.5-0.5B-Instruct | 290 MB | **0 / 8** | ~0.5-1.8 s | Claimed sleep "improved"; added diet and yoga advice. Rejected every time |
| Qwen2.5-1.5B-Instruct | 880 MB | **8 / 8 delivered** (about half pass on the first attempt; up to 3 tries) | ~2.8-5 s per try | Blocked tries said "you feel…" or "better". Every delivered note was accurate. Example: *"Lately, your sleep has been shorter and you're going to bed later. Your mood is a bit lower too, as are your energy levels. These changes can happen for different reasons... It's okay to take things one day at a time."* |

The fixed wording shows instantly and the model's note replaces it only if it passes. **The validator is the safety feature, not the model.**
