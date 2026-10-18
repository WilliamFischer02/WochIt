// Overlay controls for the stage (docs/UI.md screen 2): scrubber, play/pause, times, reactions,
// CC, quality, volume (mouse only), chat toggle, fullscreen; title + sync pill top-left.
// Auto-hide after 3 s of no pointer while playing; any tap on the stage shows them again.
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import clsx from 'clsx';
import { Captions, Maximize, MessageCircle, Minimize, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useApp } from '../../app/store';
import { isTouchDevice, toggleFullscreen } from '../../lib/device';
import { formatTime } from '../../lib/format';
import ReactionButtons from '../reactions/ReactionButtons';
import { usePlayer } from '../player/playerStore';
import SubtitlesMenu from '../subtitles/SubtitlesMenu';
import QualityMenu from './QualityMenu';
import Scrubber from './Scrubber';
import SyncPill from './SyncPill';
import { control, useRoomPosition } from './intents';

const HIDE_AFTER_MS = 3000;

export interface ControlsProps {
  stageRef: RefObject<HTMLDivElement | null>;
  videoRef: RefObject<HTMLVideoElement | null>;
  playing: boolean;
}

function IconButton({
  label,
  onClick,
  children,
  testId,
  className,
  pressed,
}: {
  label: string;
  onClick(): void;
  children: React.ReactNode;
  testId?: string;
  className?: string;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      data-testid={testId}
      onClick={onClick}
      className={clsx('relative grid h-11 w-10 shrink-0 place-items-center rounded-pill text-white/90 hover:bg-white/10 active:scale-95 motion', className)}
    >
      {children}
    </button>
  );
}

export default function Controls({ stageRef, videoRef, playing }: ControlsProps) {
  const media = useApp((s) => s.media);
  const unread = useApp((s) => s.chat.unread);
  const chatOpen = useApp((s) => s.chat.open);
  const setChatOpen = useApp((s) => s.setChatOpen);
  const currentTime = usePlayer((s) => s.currentTime);
  const videoDuration = usePlayer((s) => s.duration);
  const buffered = usePlayer((s) => s.buffered);
  const hasVideo = usePlayer((s) => s.hasVideo);
  const menu = usePlayer((s) => s.menu);
  const setMenu = usePlayer((s) => s.setMenu);
  const toggleMenu = usePlayer((s) => s.toggleMenu);
  const levels = usePlayer((s) => s.levels);
  const currentLevel = usePlayer((s) => s.currentLevel);
  const activeHeight = usePlayer((s) => s.activeHeight);
  const volume = usePlayer((s) => s.volume);
  const muted = usePlayer((s) => s.muted);
  const setVolume = usePlayer((s) => s.setVolume);
  const setMuted = usePlayer((s) => s.setMuted);
  const fullscreen = usePlayer((s) => s.fullscreen);
  const gateOpen = usePlayer((s) => s.gateOpen);
  const roomPos = useRoomPosition();

  const [visible, setVisible] = useState(true);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [optimisticPlaying, setOptimisticPlaying] = useState<boolean | null>(null);
  useEffect(() => setOptimisticPlaying(null), [playing]);
  const isPlaying = optimisticPlaying ?? playing;

  const position = hasVideo && gateOpen ? currentTime : roomPos;
  const duration = videoDuration || media?.durationSec || 0;

  const show = useCallback(() => {
    setVisible(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
    const { menu: openMenu } = usePlayer.getState();
    if (isPlaying && !openMenu) {
      hideTimer.current = setTimeout(() => setVisible(false), HIDE_AFTER_MS);
    }
  }, [isPlaying]);

  useEffect(() => {
    show();
    return () => {
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, [show, menu]);

  // Pointer activity on the stage shows the controls; a tap on the bare picture toggles them
  // (touch) or play/pause (mouse).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const onMove = () => show();
    const onDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement;
      const onPicture = target.tagName === 'VIDEO' || target.dataset.stageBackdrop !== undefined;
      if (!onPicture) {
        show();
        return;
      }
      if (!visible) {
        show();
        return;
      }
      if (isTouchDevice()) {
        if (isPlaying) setVisible(false);
      } else if (usePlayer.getState().gateOpen) {
        onToggle();
      }
    };
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerdown', onDown);
    return () => {
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerdown', onDown);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageRef, show, visible, isPlaying]);

  const onToggle = () => {
    setOptimisticPlaying(!isPlaying);
    control('toggle');
  };

  const levelLabel = currentLevel === -1 ? 'Auto' : `${levels.find((l) => l.index === currentLevel)?.height ?? '?'}p`;
  const interactive = visible || menu !== null;

  return (
    <div
      className={clsx('absolute inset-0 z-10 flex flex-col justify-between motion', interactive ? 'opacity-100' : 'opacity-0')}
      data-testid="controls"
      data-visible={interactive ? 'true' : 'false'}
      aria-hidden={!interactive}
    >
      {/* top: title + sync pill */}
      <div className={clsx('flex items-start gap-2 bg-gradient-to-b from-black/70 to-transparent p-3 safe-t', interactive ? 'pointer-events-auto' : 'pointer-events-none')}>
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold drop-shadow" data-testid="stage-title">
            {media?.title}
          </div>
          <SyncPill className="mt-1" />
        </div>
      </div>

      <div className="flex-1" data-stage-backdrop="" />

      {/* bottom: scrubber + buttons */}
      <div className={clsx('bg-gradient-to-t from-black/85 via-black/45 to-transparent px-3 pb-1 pt-8 safe-b', interactive ? 'pointer-events-auto' : 'pointer-events-none')}>
        <Scrubber
          position={position}
          duration={duration}
          buffered={buffered}
          onSeek={(p) => control('seek', p)}
          onScrub={(p) => control('seek', p)}
          disabled={!media}
        />
        <div className="flex items-center gap-1">
          <button
            type="button"
            aria-label={isPlaying ? 'Pause' : 'Play'}
            data-testid="play-pause"
            onClick={onToggle}
            className="grid size-12 shrink-0 place-items-center rounded-pill bg-white/10 hover:bg-white/20 active:scale-95 motion"
          >
            {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-0.5" />}
          </button>
          <span className="tnum ml-1 shrink-0 text-xs text-white/80" data-testid="time">
            {formatTime(position)}
            <span className="hidden min-[480px]:inline"> / {formatTime(duration)}</span>
          </span>
          <div className="flex-1" />
          <ReactionButtons size="sm" />
          <div className="flex-1" />
          <IconButton label="Subtitles" testId="cc-button" onClick={() => toggleMenu('subs')} pressed={menu === 'subs'}>
            <Captions size={20} />
          </IconButton>
          <button
            type="button"
            aria-label={`Quality: ${levelLabel}`}
            data-testid="quality-chip"
            data-active-height={activeHeight ?? ''}
            aria-pressed={menu === 'quality'}
            onClick={() => toggleMenu('quality')}
            className="tnum h-8 shrink-0 rounded-pill border border-white/15 bg-white/6 px-2 text-[11px] font-semibold tracking-wide text-white/90 hover:bg-white/15 motion"
          >
            {levelLabel}
          </button>
          <div className="hidden items-center gap-1 fine:flex">
            <IconButton label={muted ? 'Unmute' : 'Mute'} testId="mute" onClick={() => setMuted(!muted)}>
              {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
            </IconButton>
            <input
              type="range"
              className="volume w-20"
              min={0}
              max={1}
              step={0.02}
              value={muted ? 0 : volume}
              aria-label="Volume"
              onChange={(e) => {
                setVolume(Number(e.target.value));
                if (muted) setMuted(false);
              }}
            />
          </div>
          <IconButton label={chatOpen ? 'Hide chat' : 'Show chat'} testId="chat-toggle" onClick={() => setChatOpen(!chatOpen)} pressed={chatOpen}>
            <MessageCircle size={20} />
            {unread > 0 && (
              <span className="absolute top-1 right-0.5 grid min-w-4 place-items-center rounded-pill bg-accent px-1 text-[10px] font-bold leading-4 text-white" data-testid="unread-badge">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </IconButton>
          <IconButton
            label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            testId="fullscreen"
            onClick={() => {
              if (stageRef.current) void toggleFullscreen(stageRef.current, videoRef.current);
            }}
          >
            {fullscreen ? <Minimize size={20} /> : <Maximize size={20} />}
          </IconButton>
        </div>
      </div>

      {menu === 'subs' && <SubtitlesMenu onClose={() => setMenu(null)} />}
      {menu === 'quality' && <QualityMenu onClose={() => setMenu(null)} />}
    </div>
  );
}
