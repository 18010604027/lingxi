/**
 * The app's language (`config.language`) and the language of the text the bot reads.
 *
 * The application supports Simplified Chinese and English.
 * A value outside these two languages reads as Chinese.
 *
 * Text the person reads comes from a file per language (`core/i18n/`, the provider's and the bundled
 * Worlds' own). The `zh` and `en` files are complete.
 *
 * Model text comes in two versions: Chinese for `zh`, English for `en`. The bundled Worlds get both through
 * their definitions (`modelLanguage`, `replyLanguage`) and read them at each use; the prompt follows
 * at the next prefix rebuild.
 */
export type ModelLanguage = 'zh' | 'en';
export type AppLanguage = 'zh' | 'en';
export const APP_LANGUAGES: readonly AppLanguage[] = ['zh', 'en'];
export const APP_LANGUAGE_NAMES: Readonly<Record<AppLanguage, string>> = { zh: '简体中文', en: 'English' };

/** The app language a stored value stands for; old or unsupported values use Simplified Chinese. */
export const appLanguage = (value: unknown): AppLanguage => value === 'en' ? 'en' : 'zh';

/** The bot speaks the same two languages as the Core and pet. */
export function replyLanguage(_language: unknown): string | null { return null; }

export function modelLanguage(language: unknown): ModelLanguage {
  return appLanguage(language);
}
