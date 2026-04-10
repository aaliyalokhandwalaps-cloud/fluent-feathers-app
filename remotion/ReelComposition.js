const React = require('react');
const {
  AbsoluteFill,
  Audio,
  Img,
  OffthreadVideo,
  Sequence,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig
} = require('remotion');

const paletteByStyle = {
  'warm educational': ['#fff7ed', '#7c2d12', '#b45309'],
  'proud achievement': ['#eff6ff', '#1e3a8a', '#2563eb'],
  'fun playful': ['#fdf2f8', '#9d174d', '#ec4899'],
  'emotional storytelling': ['#faf5ff', '#581c87', '#9333ea']
};

const fitText = (value, fallback = '') => String(value || fallback || '').trim();

const resolveSfxUrl = (label, sfxMap = {}) => {
  const source = fitText(label).toLowerCase();
  if (!source) return '';
  if (source.includes('whoosh') || source.includes('swipe')) return sfxMap.whoosh || '';
  if (source.includes('chime') || source.includes('celebrat')) return sfxMap.chime || '';
  return sfxMap.click || '';
};

const getSubtitleParts = (base) => {
  const clean = fitText(base);
  return {
    words: clean.split(/\s+/).map((part) => fitText(part)).filter(Boolean),
    lines: clean.split(/[,:;.!?]/).map((part) => fitText(part)).filter(Boolean)
  };
};

const buildSubtitleText = ({ scene, subtitleTiming, frame, durationInFrames }) => {
  const base = fitText(scene.on_screen_text, scene.visual || '');
  if (!base) return '';

  const safeDuration = Math.max(1, durationInFrames || 1);
  const progress = Math.max(0, Math.min(1, frame / safeDuration));
  const { words, lines } = getSubtitleParts(base);

  if (subtitleTiming === 'word') {
    const chunks = [];
    for (let i = 0; i < words.length; i += 3) {
      chunks.push(words.slice(i, i + 3).join(' '));
    }
    const visibleChunks = Math.max(1, Math.ceil(progress * Math.max(1, chunks.length)));
    return chunks.slice(0, visibleChunks).join(' ');
  }

  if (subtitleTiming === 'line') {
    const sourceLines = lines.length ? lines : [base];
    const visibleLines = Math.max(1, Math.ceil(progress * Math.max(1, sourceLines.length)));
    return sourceLines.slice(0, visibleLines).join(' | ');
  }

  const visibleWords = Math.max(1, Math.ceil(progress * Math.max(1, words.length)));
  return words.slice(0, visibleWords).join(' ');
};

const CaptionBubble = ({ text, styleName, accentColor }) => {
  const shared = {
    maxWidth: '92%',
    textAlign: 'center',
    fontWeight: 800,
    lineHeight: 1.28,
    boxShadow: '0 16px 40px rgba(15,23,42,0.22)'
  };

  if (styleName === 'bold_box') {
    return React.createElement('div', {
      style: {
        ...shared,
        background: '#111827',
        color: 'white',
        padding: '18px 22px',
        borderRadius: 18,
        fontSize: 30,
        border: `3px solid ${accentColor}`
      }
    }, text);
  }

  if (styleName === 'minimal') {
    return React.createElement('div', {
      style: {
        ...shared,
        background: 'rgba(255,255,255,0.92)',
        color: '#0f172a',
        padding: '14px 18px',
        borderRadius: 16,
        fontSize: 24
      }
    }, text);
  }

  if (styleName === 'karaoke') {
    return React.createElement(
      'div',
      {
        style: {
          ...shared,
          background: 'rgba(17,24,39,0.82)',
          color: '#fde047',
          padding: '18px 20px',
          borderRadius: 22,
          fontSize: 28,
          textTransform: 'uppercase',
          letterSpacing: '0.03em'
        }
      },
      text
    );
  }

  return React.createElement('div', {
    style: {
      ...shared,
      background: 'rgba(17,24,39,0.78)',
      color: 'white',
      padding: '16px 20px',
      borderRadius: 24,
      fontSize: 26
    }
  }, text);
};

const TypingLine = ({ text, accentColor = '#b45309' }) => {
  const frame = useCurrentFrame();
  const visibleChars = Math.max(1, Math.floor(frame / 2.5));
  const shown = fitText(text).slice(0, visibleChars);
  return React.createElement(
    'div',
    {
      style: {
        fontSize: 54,
        lineHeight: 1.08,
        fontWeight: 800,
        letterSpacing: '-0.03em',
        color: '#111827',
        textShadow: '0 2px 12px rgba(255,255,255,0.5)'
      }
    },
    shown,
    React.createElement('span', {
      style: {
        display: 'inline-block',
        width: 8,
        height: 56,
        marginLeft: 6,
        verticalAlign: 'middle',
        backgroundColor: accentColor,
        opacity: Math.floor(frame / 12) % 2 === 0 ? 1 : 0.2
      }
    })
  );
};

const BackgroundMedia = ({ sourceMediaUrl, sourceMediaType, frame }) => {
  const scale = interpolate(frame, [0, 180], [1.02, 1.12], { extrapolateRight: 'clamp' });
  if (sourceMediaUrl && sourceMediaType === 'video') {
    return React.createElement(OffthreadVideo, {
      src: sourceMediaUrl,
      muted: true,
      style: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: `scale(${scale})`
      }
    });
  }

  if (sourceMediaUrl) {
    return React.createElement(Img, {
      src: sourceMediaUrl,
      style: {
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        objectFit: 'cover',
        transform: `scale(${scale})`
      }
    });
  }

  return React.createElement(AbsoluteFill, {
    style: {
      background: 'linear-gradient(135deg, #fdf2f8 0%, #ede9fe 45%, #dbeafe 100%)'
    }
  });
};

const BrandingOverlay = ({ brandingTemplate, title, logoUrl, accentColor }) => {
  const frame = useCurrentFrame();
  const headerY = interpolate(frame, [0, 25], [-30, 0], { extrapolateRight: 'clamp' });
  const showIntro = brandingTemplate === 'academy' || brandingTemplate === 'celebration';

  return React.createElement(
    React.Fragment,
    null,
    React.createElement(
      'div',
      {
        style: {
          position: 'absolute',
          top: 32 + headerY,
          left: 38,
          right: 38,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center'
        }
      },
      React.createElement(
        'div',
        {
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 12,
            background: 'rgba(255,255,255,0.9)',
            borderRadius: 999,
            padding: '10px 16px',
            boxShadow: '0 12px 32px rgba(15,23,42,0.12)'
          }
        },
        logoUrl ? React.createElement(Img, {
          src: logoUrl,
          style: {
            width: 42,
            height: 42,
            objectFit: 'contain',
            background: 'white',
            borderRadius: 12,
            padding: 4
          }
        }) : null,
        React.createElement('div', {
          style: {
            fontSize: 20,
            fontWeight: 800,
            color: '#111827'
          }
        }, fitText(title, 'Fluent Feathers Academy'))
      ),
      React.createElement(
        'div',
        {
          style: {
            background: accentColor,
            color: 'white',
            borderRadius: 999,
            padding: '10px 16px',
            fontSize: 18,
            fontWeight: 800,
            boxShadow: '0 12px 32px rgba(15,23,42,0.12)'
          }
        },
        'Reel'
      )
    ),
    showIntro ? React.createElement('div', {
      style: {
        position: 'absolute',
        left: 40,
        right: 40,
        bottom: 22,
        textAlign: 'center',
        color: 'white',
        fontSize: 18,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        opacity: 0.85
      }
    }, brandingTemplate === 'celebration' ? 'Celebrate Every Milestone' : 'Fluent Feathers Academy') : null
  );
};

const OutroCard = ({ brandingTemplate, logoUrl, title, accentColor }) => {
  if (brandingTemplate === 'minimal') return null;
  return React.createElement(
    AbsoluteFill,
    {
      style: {
        alignItems: 'center',
        justifyContent: 'center',
        background: 'linear-gradient(135deg, rgba(15,23,42,0.82) 0%, rgba(88,28,135,0.72) 100%)'
      }
    },
    React.createElement(
      'div',
      {
        style: {
          background: 'rgba(255,255,255,0.92)',
          borderRadius: 28,
          padding: '30px 34px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 14,
          boxShadow: '0 22px 60px rgba(15,23,42,0.25)'
        }
      },
      logoUrl ? React.createElement(Img, {
        src: logoUrl,
        style: { width: 84, height: 84, objectFit: 'contain' }
      }) : null,
      React.createElement('div', {
        style: { fontSize: 34, fontWeight: 900, color: '#111827', textAlign: 'center' }
      }, fitText(title, 'Fluent Feathers Academy')),
      React.createElement('div', {
        style: { fontSize: 22, fontWeight: 700, color: accentColor, textAlign: 'center' }
      }, brandingTemplate === 'celebration' ? 'Small voices. Big stories.' : 'English | Confidence | Creativity')
    )
  );
};

const SceneCard = ({ scene, accentColor, studentName, captionStyle, subtitleTiming, durationInFrames }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 18, mass: 0.9 } });
  const subtitleText = buildSubtitleText({ scene, subtitleTiming, frame, durationInFrames });

  return React.createElement(
    AbsoluteFill,
    {
      style: {
        justifyContent: 'space-between',
        padding: '108px 72px 70px',
        transform: `translateY(${interpolate(enter, [0, 1], [36, 0])}px)`,
        opacity: enter
      }
    },
    React.createElement(
      'div',
      {
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          alignSelf: 'flex-start',
          background: 'rgba(255,255,255,0.86)',
          padding: '14px 18px',
          borderRadius: 999,
          boxShadow: '0 12px 30px rgba(15,23,42,0.12)'
        }
      },
      React.createElement('div', {
        style: {
          width: 12,
          height: 12,
          borderRadius: 999,
          background: accentColor
        }
      }),
      React.createElement('div', {
        style: { fontSize: 24, fontWeight: 700, color: '#334155' }
      }, fitText(studentName, 'Fluent Feathers Reel'))
    ),
    React.createElement(
      'div',
      {
        style: {
          alignSelf: 'stretch',
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          justifyContent: 'flex-end'
        }
      },
      React.createElement(
        'div',
        {
          style: {
            maxWidth: '82%',
            background: 'rgba(255,255,255,0.86)',
            borderRadius: 36,
            padding: '34px 36px 30px',
            boxShadow: '0 24px 70px rgba(15,23,42,0.20)'
          }
        },
        React.createElement(TypingLine, {
          text: fitText(scene.on_screen_text, scene.visual || 'A learning moment worth sharing'),
          accentColor
        }),
        React.createElement('div', {
          style: {
            marginTop: 20,
            fontSize: 24,
            lineHeight: 1.5,
            color: '#475569',
            fontWeight: 500
          }
        }, fitText(scene.visual))
      ),
      React.createElement(
        'div',
        {
          style: {
            display: 'flex',
            gap: 12,
            alignItems: 'center',
            flexWrap: 'wrap'
          }
        },
        fitText(scene.motion) ? React.createElement('div', {
          style: {
            background: 'rgba(17,24,39,0.72)',
            color: 'white',
            borderRadius: 999,
            padding: '10px 16px',
            fontSize: 20,
            fontWeight: 700
          }
        }, fitText(scene.motion)) : null,
        fitText(scene.sfx) ? React.createElement('div', {
          style: {
            background: 'rgba(255,255,255,0.80)',
            color: '#334155',
            borderRadius: 999,
            padding: '10px 16px',
            fontSize: 18,
            fontWeight: 700
          }
        }, `SFX: ${fitText(scene.sfx)}`) : null
      ),
      subtitleText ? React.createElement(CaptionBubble, {
        text: subtitleText,
        styleName: captionStyle,
        accentColor
      }) : null
    )
  );
};

const ReelComposition = (props) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const {
    title,
    hook,
    scenePlan,
    sourceMediaUrl,
    sourceMediaType,
    studentName,
    contentStyle,
    voiceoverAudioUrl,
    sfxMap,
    captionStyle,
    subtitleTiming,
    brandingTemplate,
    backgroundMusicUrl,
    logoUrl
  } = props;

  const palette = paletteByStyle[fitText(contentStyle, 'warm educational').toLowerCase()] || paletteByStyle['warm educational'];
  const [, , accentColor] = palette;
  const durationOutroFrames = brandingTemplate === 'minimal' ? 0 : Math.round(fps * 1.5);

  return React.createElement(
    AbsoluteFill,
    {
      style: {
        fontFamily: 'Inter, Arial, sans-serif',
        backgroundColor: '#0f172a'
      }
    },
    React.createElement(BackgroundMedia, { sourceMediaUrl, sourceMediaType, frame }),
    React.createElement(AbsoluteFill, {
      style: {
        background: 'linear-gradient(180deg, rgba(15,23,42,0.28) 0%, rgba(15,23,42,0.12) 35%, rgba(15,23,42,0.72) 100%)'
      }
    }),
    React.createElement(BrandingOverlay, { brandingTemplate, title, logoUrl, accentColor }),
    fitText(hook) ? React.createElement('div', {
      style: {
        position: 'absolute',
        top: 126,
        left: 42,
        right: 42,
        background: 'rgba(255,255,255,0.9)',
        color: '#111827',
        borderRadius: 30,
        padding: '20px 24px',
        fontSize: 34,
        lineHeight: 1.2,
        fontWeight: 900,
        boxShadow: '0 16px 40px rgba(15,23,42,0.12)'
      }
    }, fitText(hook)) : null,
    voiceoverAudioUrl ? React.createElement(Audio, { src: voiceoverAudioUrl, volume: 1 }) : null,
    backgroundMusicUrl ? React.createElement(Audio, { src: backgroundMusicUrl, volume: 0.16, loop: true }) : null,
    Array.isArray(scenePlan) ? scenePlan.map((scene, index) => {
      const start = Math.max(0, Math.floor((Number(scene.start_sec) || 0) * fps));
      const end = Math.max(start + 1, Math.floor((Number(scene.end_sec) || 0) * fps));
      const sfxUrl = resolveSfxUrl(scene.sfx, sfxMap);
      return React.createElement(
        Sequence,
        { key: `scene-${index}`, from: start, durationInFrames: end - start },
        React.createElement(
          React.Fragment,
          null,
          sfxUrl ? React.createElement(Audio, { src: sfxUrl, volume: 0.45 }) : null,
          React.createElement(SceneCard, {
            scene,
            accentColor,
            studentName,
            captionStyle,
            subtitleTiming,
            durationInFrames: end - start
          })
        )
      );
    }) : null,
    durationOutroFrames > 0 ? React.createElement(
      Sequence,
      { from: Math.max(0, (Array.isArray(scenePlan) && scenePlan.length ? Math.floor((Number(scenePlan[scenePlan.length - 1].end_sec) || 0) * fps) : 0) - durationOutroFrames), durationInFrames: durationOutroFrames },
      React.createElement(OutroCard, { brandingTemplate, logoUrl, title, accentColor })
    ) : null
  );
};

module.exports = { ReelComposition };
