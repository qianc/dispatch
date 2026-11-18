// The server's default model and effort (DISP-117): what a session on 'default' runs on, on every
// worker. One setting for the whole server; it starts as Opus at medium effort.
import type { Db } from './db.ts';
import { MODEL_DEFAULTS, modelDefaults, type ModelDefaults, type SessionOptions } from '../shared/types.ts';

const KEY = 'model_defaults';

export function getModelDefaults(db: Db): ModelDefaults {
  try {
    return modelDefaults.parse({ ...MODEL_DEFAULTS, ...JSON.parse(db.setting(KEY) ?? '{}') });
  } catch {
    return MODEL_DEFAULTS;
  }
}

export function setModelDefaults(db: Db, patch: Partial<ModelDefaults>): ModelDefaults {
  const next = modelDefaults.parse({ ...getModelDefaults(db), ...patch });
  db.setSetting(KEY, JSON.stringify(next));
  return next;
}

/** A session's options with 'default' model and effort replaced by the server's: a worker never gets 'default'. */
export function withModelDefaults(options: SessionOptions, defaults: ModelDefaults): SessionOptions {
  return {
    ...options,
    model: options.model === 'default' ? defaults.model : options.model,
    effort: options.effort === 'default' ? defaults.effort : options.effort,
  };
}
