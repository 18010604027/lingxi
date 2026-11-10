/**
 * The Core process's text for people, one file per language named for its code. `zh.ts` and `en.ts`
 * have every key. Core language values are normalized to these two tables before display.
 */
import type { Language } from '../contracts.ts';
type LanguageTable<T> = Record<string, T>;
const pick = <T>(language: Language, table: LanguageTable<T>): T => table[language] ?? table.zh ?? table.en;
import zh from './zh.ts';
import en from './en.ts';

export type CoreText = typeof zh;

const CORE_TEXT: LanguageTable<CoreText> = { zh, en };

export const coreText = (language: Language): CoreText => pick(language, CORE_TEXT);
