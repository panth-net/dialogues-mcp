import path from "node:path";
import { dataDir, preferencesPath } from "./paths.js";
import { readJsonFile, withLock, writeJsonAtomic } from "./state/files.js";

const MAX_KEY = 64;
const MAX_VALUE = 2000;
const MAX_KEYS = 50;

function readPreferences(): Record<string, string> {
  const result = readJsonFile<unknown>(preferencesPath());
  if (result.status === "missing") return {};
  if (result.status === "corrupt") {
    throw new Error(`preferences.json in ${dataDir()} is unreadable (${result.error}). Fix or remove it; Dialogues will not overwrite it.`);
  }
  const raw = result.value;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`preferences.json in ${dataDir()} must contain a JSON object. Fix or remove it; Dialogues will not overwrite it.`);
  }
  return Object.fromEntries(
    Object.entries(raw as Record<string, unknown>).filter(([, value]) => typeof value === "string")
  ) as Record<string, string>;
}

export function getPreferences(): Record<string, string> {
  return readPreferences();
}

export function setPreference(key: string, value: string): Record<string, string> {
  const cleanKey = key.trim();
  if (!cleanKey) throw new Error("Preference key must be a non-empty string");
  if (cleanKey.length > MAX_KEY || !/^[A-Za-z0-9_.-]+$/.test(cleanKey)) {
    throw new Error("Preference key must be up to 64 letters, numbers, dots, dashes, or underscores.");
  }
  const cleanValue = value.trim();
  if (cleanValue.length > MAX_VALUE) throw new Error(`Preference value must be at most ${MAX_VALUE} characters.`);
  return withLock(path.join(dataDir(), ".preferences.lock"), "saving preferences", () => {
    const preferences = readPreferences();
    if (cleanValue) {
      if (!(cleanKey in preferences) && Object.keys(preferences).length >= MAX_KEYS) {
        throw new Error(`At most ${MAX_KEYS} preferences can be saved.`);
      }
      preferences[cleanKey] = cleanValue;
    } else {
      delete preferences[cleanKey];
    }
    writeJsonAtomic(preferencesPath(), preferences);
    return preferences;
  });
}
