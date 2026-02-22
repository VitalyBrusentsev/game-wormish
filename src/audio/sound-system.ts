import { clamp, WeaponType } from "../definitions";
import { track1Url } from "../assets";
import { createNoiseBuffer, normalizeLevel } from "./audio-utils";
import { createProjectileExplodedVoice, createProjectileLaunchVoice, createWormDeathVoice, type VoiceBlueprint } from "./sfx";

export type SoundLevels = {
  master: number;
  sfx: number;
  music: number;
};

export type SoundSnapshot = {
  enabled: boolean;
  levels: SoundLevels;
};

type ListenerState = {
  centerX: number;
  viewportWidth: number;
};

type ActiveVoice = {
  tag: string;
  worldX: number;
  baseGain: number;
  stopAt: number;
  gain: GainNode;
  pan: StereoPannerNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
  cleanup: () => void;
};

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;
  private musicSource: AudioBufferSourceNode | null = null;
  private musicLoadPromise: Promise<void> | null = null;
  private musicLoadAbort: AbortController | null = null;
  private nodes:
    | {
        sfx: GainNode;
        music: GainNode;
        mix: GainNode;
        compressor: DynamicsCompressorNode;
        master: GainNode;
      }
    | null = null;

  private readonly voices = new Set<ActiveVoice>();
  private readonly voicesByTag = new Map<string, ActiveVoice[]>();

  private listener: ListenerState = { centerX: 0, viewportWidth: 1 };

  private enabled = true;
  private levels: SoundLevels = { master: 0.9, sfx: 0.9, music: 0.6 };

  getSnapshot(): SoundSnapshot {
    return {
      enabled: this.enabled,
      levels: { ...this.levels },
    };
  }

  setEnabled(enabled: boolean) {
    this.enabled = !!enabled;
    this.syncLevels();
  }

  setLevels(levels: Partial<SoundLevels>) {
    this.levels = {
      master: levels.master === undefined ? this.levels.master : normalizeLevel(levels.master),
      sfx: levels.sfx === undefined ? this.levels.sfx : normalizeLevel(levels.sfx),
      music: levels.music === undefined ? this.levels.music : normalizeLevel(levels.music),
    };
    this.syncLevels();
  }

  setListener(listener: ListenerState) {
    this.listener = {
      centerX: Number.isFinite(listener.centerX) ? listener.centerX : 0,
      viewportWidth: Math.max(1, Number.isFinite(listener.viewportWidth) ? listener.viewportWidth : 1),
    };
  }

  attachUnlockGestures(target: HTMLElement, options?: { signal?: AbortSignal }) {
    const signal = options?.signal;
    if (signal?.aborted) return;

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      target.removeEventListener("pointerdown", onGesture);
      target.removeEventListener("touchstart", onGesture);
      target.removeEventListener("keydown", onGesture);
    };

    const onGesture = () => {
      cleanup();
      void this.unlock();
    };

    target.addEventListener("pointerdown", onGesture, { passive: true });
    target.addEventListener("touchstart", onGesture, { passive: true });
    target.addEventListener("keydown", onGesture);

    signal?.addEventListener("abort", cleanup, { once: true });
  }

  async unlock(): Promise<void> {
    const ctx = this.ensureContext();
    if (ctx.state !== "running") {
      await ctx.resume();
    }
    await this.ensureMusicLoop();
  }

  update() {
    const ctx = this.ctx;
    if (!ctx) return;

    const now = ctx.currentTime;
    for (const voice of this.voices) {
      if (now > voice.stopAt) {
        voice.cleanup();
        continue;
      }
      this.applySpatialParams(voice);
    }
  }

  dispose() {
    const musicSource = this.musicSource;
    this.musicSource = null;
    if (musicSource) {
      try {
        musicSource.stop();
      } catch {}
      try {
        musicSource.disconnect();
      } catch {}
    }

    this.musicLoadAbort?.abort();
    this.musicLoadAbort = null;
    this.musicLoadPromise = null;

    for (const voice of this.voices) {
      voice.cleanup();
    }
    this.voices.clear();
    this.voicesByTag.clear();
    this.nodes?.master.disconnect();
    this.nodes = null;
    const ctx = this.ctx;
    this.ctx = null;
    this.noise = null;
    ctx?.close().catch(() => {});
  }

  playProjectileLaunch(config: {
    weapon: WeaponType;
    worldX: number;
    velocity: { x: number; y: number };
    turnIndex: number;
    projectileId: number;
  }) {
    const ctx = this.ctx;
    const noise = this.noise;
    if (!ctx || !this.nodes || !noise) return;
    if (!this.enabled || this.levels.master <= 0 || this.levels.sfx <= 0) return;
    const voice = createProjectileLaunchVoice({ ctx, noise, ...config });
    this.startVoice(voice);
  }

  playProjectileExploded(config: {
    weapon: WeaponType;
    cause: WeaponType;
    worldX: number;
    radius: number;
    impact: "terrain" | "worm" | "unknown";
    turnIndex: number;
    projectileId: number;
  }) {
    const ctx = this.ctx;
    const noise = this.noise;
    if (!ctx || !this.nodes || !noise) return;
    if (!this.enabled || this.levels.master <= 0 || this.levels.sfx <= 0) return;
    const voice = createProjectileExplodedVoice({ ctx, noise, ...config });
    this.startVoice(voice);
  }

  playWormDeath(config: {
    worldX: number;
    turnIndex: number;
    wormIndex: number;
    cause: WeaponType;
  }) {
    const ctx = this.ctx;
    const noise = this.noise;
    if (!ctx || !this.nodes || !noise) return;
    if (!this.enabled || this.levels.master <= 0 || this.levels.sfx <= 0) return;
    const voice = createWormDeathVoice({ ctx, noise, ...config });
    this.startVoice(voice);
  }

  private ensureContext(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ latencyHint: "interactive" });
    const sfx = ctx.createGain();
    const music = ctx.createGain();
    const mix = ctx.createGain();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -18;
    compressor.knee.value = 24;
    compressor.ratio.value = 6;
    compressor.attack.value = 0.003;
    compressor.release.value = 0.2;
    const master = ctx.createGain();

    sfx.connect(mix);
    music.connect(mix);
    mix.connect(compressor);
    compressor.connect(master);
    master.connect(ctx.destination);

    this.ctx = ctx;
    this.nodes = { sfx, music, mix, compressor, master };
    this.noise = createNoiseBuffer(ctx, 1);
    this.syncLevels();
    return ctx;
  }

  private ensureMusicLoop() {
    if (this.musicSource) return Promise.resolve();
    if (this.musicLoadPromise) return this.musicLoadPromise;

    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes) return Promise.resolve();

    const abortController = new AbortController();
    this.musicLoadAbort = abortController;

    const loadPromise = fetch(track1Url, { signal: abortController.signal })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`Failed to load background music: ${response.status}`);
        }
        return response.arrayBuffer();
      })
      .then((buffer) => ctx.decodeAudioData(buffer))
      .then((buffer) => {
        if (abortController.signal.aborted) return;
        if (this.ctx !== ctx || !this.nodes || this.musicSource) return;

        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = true;
        source.connect(this.nodes.music);
        source.start();
        this.musicSource = source;
      })
      .catch(() => {})
      .finally(() => {
        if (this.musicLoadPromise === loadPromise) {
          this.musicLoadPromise = null;
        }
        if (this.musicLoadAbort === abortController) {
          this.musicLoadAbort = null;
        }
      });

    this.musicLoadPromise = loadPromise;
    return loadPromise;
  }

  private syncLevels() {
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes) return;
    nodes.master.gain.setValueAtTime(this.enabled ? this.levels.master : 0, ctx.currentTime);
    nodes.sfx.gain.setValueAtTime(this.levels.sfx, ctx.currentTime);
    nodes.music.gain.setValueAtTime(this.levels.music, ctx.currentTime);
  }

  private startVoice(config: VoiceBlueprint) {
    const ctx = this.ctx;
    const nodes = this.nodes;
    if (!ctx || !nodes) return;

    const existing = this.voicesByTag.get(config.tag);
    if (existing && existing.length >= config.polyLimit) {
      const toStop = existing.shift();
      if (toStop) toStop.cleanup();
    }

    const input = ctx.createGain();
    const pan = ctx.createStereoPanner();
    input.connect(pan);
    pan.connect(nodes.sfx);

    const nodeList: AudioNode[] = [input, pan];
    const sourceList: AudioScheduledSourceNode[] = [];

    let cleanedUp = false;
    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      this.voices.delete(voice);
      const list = this.voicesByTag.get(config.tag);
      if (list) {
        const idx = list.indexOf(voice);
        if (idx >= 0) list.splice(idx, 1);
        if (list.length === 0) this.voicesByTag.delete(config.tag);
      }
      for (const src of sourceList) {
        try {
          src.stop();
        } catch {}
        try {
          src.disconnect();
        } catch {}
      }
      for (const n of nodeList) {
        try {
          n.disconnect();
        } catch {}
      }
    };

    const voice: ActiveVoice = {
      tag: config.tag,
      worldX: config.worldX,
      baseGain: config.baseGain,
      stopAt: config.stopAt,
      gain: input,
      pan,
      sources: sourceList,
      nodes: nodeList,
      cleanup,
    };

    this.voices.add(voice);
    if (!existing) this.voicesByTag.set(config.tag, [voice]);
    else existing.push(voice);

    config.build(input, nodeList, sourceList);
    this.applySpatialParams(voice);

    for (const src of sourceList) {
      src.addEventListener("ended", () => {
        if (!this.ctx) return;
        if (this.ctx.currentTime > voice.stopAt - 0.2) {
          cleanup();
        }
      });
    }
  }

  private applySpatialParams(voice: ActiveVoice) {
    const ctx = this.ctx;
    if (!ctx) return;
    const halfWidth = Math.max(1, this.listener.viewportWidth * 0.5);
    const dx = (voice.worldX - this.listener.centerX) / halfWidth;
    const pan = clamp(dx, -1, 1);
    const dist01 = Math.abs(dx);
    const attenuation = 1 / (1 + dist01 * dist01 * 0.9);
    const target = voice.baseGain * attenuation;

    voice.pan.pan.setTargetAtTime(pan, ctx.currentTime, 0.015);
    voice.gain.gain.setTargetAtTime(target, ctx.currentTime, 0.02);
  }
}
