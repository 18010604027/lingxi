/**
 * The pet World's tool declarations (world.ts binds the handlers). Descriptions are English whatever the model-text
 * language. Moved from the old pet package's tools.ts, only what the new body has.
 */
import type { ToolDef } from '../contracts.ts';

export const PET_TOOL_DECLS: Array<Omit<ToolDef, 'handler'>> = [
  {
    name: 'pet_interaction',
    tags: ['act'],
    description: 'Set how your body responds to the next click, petting, or landing, and whether you consider speaking after touch. Use an action word you can perform; omit fields you do not want to change. Clicks stay quiet unless voice is set to consider.',
    parameters: {
      type: 'object',
      properties: {
        click: { type: 'string', description: 'Action word for a click.' },
        pet: { type: 'string', description: 'Action word for petting.' },
        landed: { type: 'string', description: 'Action word after landing.' },
        voice: { type: 'string', enum: ['quiet', 'consider'], description: 'Whether a touch may wake you to consider speaking.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'pet_say',
    tags: ['speak'],
    description: 'Say something in a speech bubble above the pet. Actions go into the script as markers: 【…】 does them first and then starts a new bubble; <…> does them when the typing reaches that point. The receipt says roughly how long it stays on screen.',
    parameters: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'What to say, with optional 【action, action】 and <action> markers. One or two sentences per bubble. Do not call this when you have nothing to say.' },
      },
      required: ['script'],
    },
  },
  {
    name: 'pet_ask',
    tags: ['speak'],
    description: 'Ask the person a question with up to 3 options. They are written into the body bubble. The next body reply answers the newest waiting question; older pending questions remain available for explicit answering in the workbench.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question, one sentence.' },
        options: { type: 'array', items: { type: 'string' }, maxItems: 3, description: '1–3 short options.' },
        requestId: { type: 'string', description: 'For a permission notice, copy its request id exactly; omit for an ordinary question.' },
      },
      required: ['question', 'options'],
    },
  },
  {
    name: 'pet_where',
    tags: ['read'],
    description: "Where you stand on the screen, which stretches you may go to and which are in use, as percent of the screen's width. Look when you mean to go somewhere and are not sure.",
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'pet_act',
    tags: ['act'],
    description: 'Do a sequence of actions without speaking (the actions you know are in the environment section). Returns at once; how one with a time or a place ended comes later as [moved]. With only a group, plays one action chosen at random from those that carry that tag (a mood or a scene).',
    parameters: {
      type: 'object',
      properties: {
        actions: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 6, description: 'Action words, done in order; a word may be followed by how long, how many times or where to, as in a script: "run 3m", "jump x2", "run right", "walk 30%".' },
        group: { type: 'string', description: 'A tag to pick from instead: one action at random whose mood or scene contains it, e.g. "happy" or "见到人".' },
      },
    },
  },
];
