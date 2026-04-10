const React = require('react');
const { Composition, registerRoot } = require('remotion');
const { ReelComposition } = require('./ReelComposition');

const FPS = 24;

const RemotionRoot = () => {
  return React.createElement(Composition, {
    id: 'SocialMediaReel',
    component: ReelComposition,
    width: 720,
    height: 1280,
    fps: FPS,
    durationInFrames: 900,
    defaultProps: {
      title: 'Fluent Feathers Reel',
      hook: 'A moment worth sharing',
      voiceoverScript: '',
      caption: '',
      scenePlan: [],
      sourceMediaUrl: '',
      sourceMediaType: 'image',
      durationSeconds: 30,
      studentName: '',
      contentStyle: 'warm educational',
      captionStyle: 'classic',
      subtitleTiming: 'scene',
      brandingTemplate: 'academy',
      backgroundMusicUrl: '',
      logoUrl: ''
    },
    calculateMetadata: ({ props }) => {
      const seconds = Math.max(10, Math.min(90, parseInt(props.durationSeconds, 10) || 30));
      return {
        durationInFrames: seconds * FPS,
        props
      };
    }
  });
};

registerRoot(RemotionRoot);
