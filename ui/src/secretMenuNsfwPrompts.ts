/**
 * Optional prompt snippets for the utility panel (local image generation). Structure can follow
 * common SD / Comfy guides (subject, setting, lighting, quality tags). Edit labels and prompts
 * to match your models and use case.
 */
export type SecretMenuPromptSnippet = {
  id: string;
  /** Short label for the button */
  label: string;
  /** Full positive prompt (comma-separated tags / phrases) */
  prompt: string;
};

export const SECRET_MENU_NSFW_PROMPT_SNIPPETS: SecretMenuPromptSnippet[] = [
  {
    id: 'portrait-daylight',
    label: 'Interior · daylight portrait',
    prompt:
      'high resolution, cinematic full body shot, natural skin textures, soft window light, ' +
      'warm golden hour mood, shallow depth of field, bokeh, RAW photo, 8k uhd, dslr, ' +
      'professional photography, film grain, sharp focus, photorealistic, hyperdetailed',
  },
];