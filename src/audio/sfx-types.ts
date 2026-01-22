export type VoiceBlueprint = {
  tag: string;
  polyLimit: number;
  worldX: number;
  baseGain: number;
  stopAt: number;
  build: (input: GainNode, nodeList: AudioNode[], sourceList: AudioScheduledSourceNode[]) => void;
};
