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
