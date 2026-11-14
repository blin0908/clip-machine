# What makes short-form video travel, and how Clip Machine uses it

This file has two layers of research:
- A research brief on organic discovery, checked **Nov 13 2026**. Its organic-discovery findings and evidence labels are the primary source for the presets.
- A second search pass from the same day, mostly vendor blogs. It covers specs and limits.

The brief's sources were not re-verified link by link. Its claims are recorded with the labels it assigned.

**Evidence labels.** *Official*: the platform documents it. *Data*: an observational study measured it. *Test*: a hypothesis to A/B on your own account. *Unverified*: the sources reviewed didn't establish it.

## 1. What the video needs to do → what the app does

| Component | Evidence | In Clip Machine |
|---|---|---|
| **First frame / hook.** Open on the action; cut logo intros. | Official: YouTube uses watch-vs-swipe and Meta uses skip rate. The 1-second target is creator advice. | "Something happens in the first second" check (energy or hook words in second 1). Clips start on the first spoken word. Optional 3 s headline. |
| **Pacing and payoff.** Hook → body → close; a longer cut earns its time with a second payoff. | Official guidance (TikTok Creative Codes, for ads). Test for organic. | **Short + long cuts with the same opening.** The short cut ends on the highest-energy sentence end in its range. "Builds to a payoff" check. Dead air cut. |
| **Sound and captions.** Real sound up close; readable captions; makes sense on mute. | Official: sound helps matching on TikTok and Shorts. *Unverified*: a universal ranking boost from captions or trending audio. | Word-by-word captions are kept as a viewer-facing improvement, not claimed as a ranking boost. Loudness normalised to −14 LUFS with the original audio kept. |
| **Shareability and CTA.** A reason to send it; one relevant action at the end. | Official statement (Mosseri): sends drive reach to non-followers. Which CTA works best is a Test. | Optional **end-card CTA on the long cut only**, so the short cut's payoff stays clean. |
| **Format and replay.** Every version has a full payoff on its first pass. | Data (Paekivi & Karjus 2026, ~10k TikToks): modest gains from creative features, and most single features showed no association. *Unverified*: a fixed bonus for loops, rewatches or jump cuts. | The loop/clean-ending check is labelled **Test**. Scores are relative within one video, not a promise of reach. |

## 2. Platform presets (test lengths)

| Preset | Short cut | Long cut | Basis |
|---|---|---|---|
| TikTok | 12–18 s | 20–30 s | Data: DataAtScale (2.8M posts). Under 15 s led plays per follower for accounts under 10k followers, and 15–30 s led interactions per play. Use 45–90 s only for a real build story. |
| Instagram Reels | 12–18 s | 30–45 s | Data: Socialinsider reach rate was 5.6% at 30–60 s vs 5.2% under 30 s. That's close, so the creative decides. Over 3 min isn't recommended to new audiences (reported). |
| YouTube Shorts | 15–30 s | 30–60 s | Data: quso.ai (108k Shorts) had 11–20 s leading median views; OverseerOS (16.5k) had 16–30 s leading. Up to 3 min counts as a Short (Official). Over 1 min with a Content ID claim is blocked (Official). |
| Facebook Reels | 15–30 s | 30–60 s | Official: all video uploads are now Reels, and original footage gets priority. No length optimum found. |
| Snapchat Spotlight | 10–20 s | none | Official: scores watch time, favourites and shares; prefers native-camera footage (Apr 2026); fully AI video is ineligible (Jul 2026); 5 s minimum. |
| All platforms | 12–18 s | 30–45 s | The brief's core recommendation. Captions use the most conservative safe zone. |
| X | 15–30 s | 30–45 s | Not covered by the brief. Free limit 2:20 / 512 MB. |

*Unverified on every platform*: fixed test-pool sizes (e.g. "200–500 views"), expansion thresholds, and numeric weights for saves, comments or rewatches. The app doesn't model these.

## 3. Export

The app exports 1080×1920 9:16 MP4, H.264 High + AAC 48 kHz, with a 12 Mbps ceiling and no watermark. It **keeps the source frame rate** (23–60 fps; YouTube recommends preserving it, and TikTok's API accepts 23–60). There's no evidence that 4K, 60 fps, a specific bitrate or a particular export app boosts organic reach. Captions and the hook stay clear of the bottom and right UI. Still preview each upload on a phone.

## 4. Publishing, per platform

Each result page shows a "Before you post on…" checklist: TikTok search-style captions and commercial disclosure; Instagram account status, HQ uploads, cover and Trial Reels; YouTube's searchable title, audience setting and the Content ID 1-minute rule; Facebook's Public audience; Snapchat's native camera. Captions are generated per platform. `#fyp` is no longer auto-added, because TikTok says it works like any other hashtag.

## 5. Judging results

The **Results log** records each post at **24 h and 7 d** against the metrics that match the platform's job:

- TikTok: average watch time, full watches %, shares
- Reels: average watch time, sends per reach, skip rate
- Shorts: stayed to watch %, engaged views, average % viewed. Public views include replays since Mar 2025, so don't rank by them.
- Facebook: watch time, shares, comments · Snapchat: watch time, favourites, shares

Compare clips at the same age and change one variable at a time. Export the log to CSV.

**Cadence (Official, YouTube):** there's no minimum cadence, and publish time isn't known to affect long-term performance. Buffer's timing data is associative only. Plan to test 2–3 concepts a week and rotate posting windows.

## Not built in

The brief's AI-model comparison doesn't apply: Clip Machine calls no AI API, and transcription runs locally with Whisper.

## Sources (from the brief and the earlier pass)

YouTube Shorts discovery and three-minute Shorts (support.google.com/youtube/answer/15424877) · YouTube view definitions (Aug 2026) · Meta Edits / skip rate (Dec 2025) · Mosseri ranking explanation (Jan 2025) · Meta small-audience rollout (May 2024) · Trial Reels (2024–25) · TikTok Help, For You ranking · TikTok Creative Codes (May 2023) · DataAtScale (Nov 3 2026) · Socialinsider (Jul/Nov 2026) · quso.ai (Jun 29 2026) · OverseerOS (Oct 29 2026) · Paekivi & Karjus preprint (Jun 14 2026) · Snap ranking/originality/AI eligibility (2026) · Meta Facebook video rollout and originality (2025–26) · Buffer 52M-post study (Mar 2026) · arXiv 2111.02452 (arousal and sharing) · Retensis benchmarks · X limits (postsyncer.com).
