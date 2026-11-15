#!/bin/zsh
# Builds a stress-test media set in tests/media/ (gitignored): real TTS speech with fillers, pauses and
# hype lines, plus edge cases (portrait, odd sizes, 60 fps, no audio, silence, music only, audio only,
# unicode filename, corrupt file, long video).
set -e
cd "$(dirname "$0")"
FF=${FFMPEG:-$(command -v ffmpeg || echo ~/.local/bin/ffmpeg)}
mkdir -p media && cd media
V=${VOICE:-Samantha}; say -v "$V" "" 2>/dev/null || V=Daniel

lines=(
  "Okay so, um, today I want to tell you about the biggest mistake I ever made."
  "Wait. Are you serious? No way. That is insane!"
  "Here's the thing nobody talks about. Uh, most people never even try."
  "I lost a million dollars in one week. Let's go back to the start."
  "And, um, honestly, it changed my life. Haha. I can't believe it worked."
  "Why does this happen? Because you need to stop guessing and start testing."
  "So, uh, the secret is simple. Film the moment, cut the boring parts, and post it."
  "Oh my god. Plot twist. It turns out the worst idea was the best one."
)
i=0
for l in $lines; do
  i=$((i+1)); say -v "$V" -r 185 -o l$i.aiff "$l"
  # alternate short and long pauses so dead-air cutting has something to do
  $FF -y -v error -i l$i.aiff -af "apad=pad_dur=$(( i % 3 == 0 ? 2 : 0 )).8,volume=$(( i % 2 == 0 ? 2 : 1 ))" -ar 48000 -ac 1 p$i.wav
done
ls p*.wav | sort -V | sed "s/^/file '/; s/$/'/" > list.txt
$FF -y -v error -f concat -safe 0 -i list.txt -c pcm_s16le speech_once.wav
$FF -y -v error -stream_loop 2 -i speech_once.wav -c copy speech.wav          # ~2.5 min of talk
D=$($FF -i speech.wav 2>&1 | sed -n 's/.*Duration: \([0-9:.]*\).*/\1/p')
echo "speech: $D"

mk() { $FF -y -v error "$@"; }
# landscape talk, 30 fps
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -i speech.wav -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac talk_720p.mp4
# portrait source (already 9:16)
mk -f lavfi -i "testsrc2=s=1080x1920:r=30" -i speech.wav -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac portrait.mp4
# 1080p60 (fps should be preserved)
mk -f lavfi -i "testsrc2=s=1920x1080:r=60" -i speech.wav -shortest -c:v libx264 -preset ultrafast -pix_fmt yuv420p -c:a aac hd60.mp4
# odd dimensions, 15 fps, low res (triggers denoise path)
mk -f lavfi -i "testsrc2=s=641x361:r=15" -i speech.wav -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -vf "scale=640:360" -c:a aac odd_lowres.mp4
# very short (6 s)
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -i l2.aiff -t 6 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac tiny.mp4
# no audio track
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -t 40 -c:v libx264 -pix_fmt yuv420p no_audio.mp4
# silent audio track
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -f lavfi -i "anullsrc=r=48000:cl=stereo" -t 45 -c:v libx264 -pix_fmt yuv420p -c:a aac silent.mp4
# music only (no speech): tones + noise bursts
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -f lavfi -i "sine=f=220:d=90,volume='if(lt(mod(t,10),2),1.0,0.3)':eval=frame" -t 90 -c:v libx264 -pix_fmt yuv420p -c:a aac music_only.mp4
# audio only
mk -i speech.wav -c:a aac -b:a 128k audio_only.m4a
# unicode + spaces + shell-hostile filename, MOV container
mk -f lavfi -i "testsrc2=s=1280x720:r=30" -i speech.wav -shortest -c:v libx264 -preset veryfast -pix_fmt yuv420p -c:a aac "my clip (final) #1 ünïcode's.mov"
# corrupt: truncated MP4 without moov
head -c 300000 talk_720p.mp4 > corrupt.mp4
# 80 s cut (Safari/WebKit runs out of WebAssembly memory somewhere above this on an 8 GB Mac)
mk -i talk_720p.mp4 -t 80 -c copy talk_80s.mp4
# long: ~25 min (performance)
mk -stream_loop 9 -i talk_720p.mp4 -c copy long_25min.mp4
rm -f l*.aiff p*.wav list.txt speech_once.wav
ls -la
