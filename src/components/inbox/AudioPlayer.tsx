import { useEffect, useRef, useState } from "react";
import { Play, Pause, Mic } from "lucide-react";
import { cn } from "@/lib/utils";

interface AudioPlayerProps {
  src: string;
  /** Controls the color scheme so it reads on both bubble backgrounds. */
  variant?: "inbound" | "outbound";
  /** Voice notes show a mic glyph instead of a generic waveform dot. */
  isVoiceNote?: boolean;
  className?: string;
}

const SPEEDS = [1, 1.5, 2] as const;

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function AudioPlayer({
  src,
  variant = "inbound",
  isVoiceNote = false,
  className,
}: AudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [speedIndex, setSpeedIndex] = useState(0);

  const outbound = variant === "outbound";

  // Color tokens per bubble background.
  const tone = outbound
    ? {
        button: "bg-white/20 text-white hover:bg-white/30",
        icon: "text-white/90",
        track: "bg-white/25",
        fill: "bg-white",
        knob: "bg-white",
        text: "text-white/80",
        speed: "text-white/90 bg-white/15 hover:bg-white/25",
      }
    : {
        button: "bg-brand-600 text-white hover:bg-brand-700",
        icon: "text-text-secondary",
        track: "bg-border-strong",
        fill: "bg-brand-500",
        knob: "bg-brand-500",
        text: "text-text-muted",
        speed: "text-text-secondary bg-surface-sunken hover:bg-surface-overlay",
      };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.playbackRate = SPEEDS[speedIndex];
  }, [speedIndex]);

  const togglePlay = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      void audio.play();
    }
  };

  const cycleSpeed = () => {
    setSpeedIndex((prev) => (prev + 1) % SPEEDS.length);
  };

  const handleSeek = (e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    audio.currentTime = ratio * duration;
    setCurrentTime(audio.currentTime);
  };

  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div
      className={cn("flex items-center gap-2.5 min-w-[200px] max-w-[280px] py-0.5", className)}
    >
      <audio
        ref={audioRef}
        src={src}
        preload="metadata"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setCurrentTime(0);
        }}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
        onDurationChange={(e) => {
          const d = e.currentTarget.duration;
          if (Number.isFinite(d)) setDuration(d);
        }}
      />

      <button
        type="button"
        onClick={togglePlay}
        className={cn(
          "shrink-0 flex items-center justify-center h-9 w-9 rounded-full transition-colors",
          tone.button
        )}
        aria-label={playing ? "Pausar áudio" : "Reproduzir áudio"}
      >
        {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
      </button>

      <div className="flex-1 min-w-0 flex flex-col gap-1">
        <div className="flex items-center gap-1.5">
          {isVoiceNote && <Mic size={13} className={cn("shrink-0", tone.icon)} />}
          <div
            role="slider"
            aria-label="Progresso do áudio"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(currentTime)}
            onClick={handleSeek}
            className="relative flex-1 h-1.5 rounded-full cursor-pointer"
          >
            <div className={cn("absolute inset-0 rounded-full", tone.track)} />
            <div
              className={cn("absolute inset-y-0 left-0 rounded-full", tone.fill)}
              style={{ width: `${progress}%` }}
            />
            <div
              className={cn(
                "absolute top-1/2 -translate-y-1/2 -translate-x-1/2 h-2.5 w-2.5 rounded-full",
                tone.knob
              )}
              style={{ left: `${progress}%` }}
            />
          </div>
        </div>
        <div className="flex items-center justify-between">
          <span className={cn("text-[10px] tabular-nums", tone.text)}>
            {formatTime(currentTime || 0)} / {formatTime(duration)}
          </span>
          <button
            type="button"
            onClick={cycleSpeed}
            className={cn(
              "shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-semibold tabular-nums transition-colors",
              tone.speed
            )}
            aria-label="Alterar velocidade de reprodução"
          >
            {SPEEDS[speedIndex]}x
          </button>
        </div>
      </div>
    </div>
  );
}
