/** Generic colour roles. Components take a tone; `web/` maps tiers and statuses to tones. */
export const TONES = ['positive', 'info', 'caution', 'negative', 'accent', 'neutral'] as const;

export type Tone = (typeof TONES)[number];

/** Text colour utility per tone (Tailwind names from theme.css). */
export const TONE_TEXT: Record<Tone, string> = {
  positive: 'text-tone-positive',
  info: 'text-tone-info',
  caution: 'text-tone-caution',
  negative: 'text-tone-negative',
  accent: 'text-tone-accent',
  neutral: 'text-tone-neutral',
};

/** Border colour utility per tone. */
export const TONE_BORDER: Record<Tone, string> = {
  positive: 'border-tone-positive',
  info: 'border-tone-info',
  caution: 'border-tone-caution',
  negative: 'border-tone-negative',
  accent: 'border-tone-accent',
  neutral: 'border-tone-neutral',
};
